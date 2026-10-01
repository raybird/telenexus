/**
 * 模型健康檢查：週期性確認「當下生效的模型」是否仍可呼叫,失效時主動推播。
 *
 * 背景見 docs/model-health-check-plan.md —— v2.26.2 的 47 小時靜默故障。
 *
 * 刻意不走 error-alerter：那是「同 scope 在視窗內超過閾值」的滑動視窗告警,
 * 本檢查週期以小時計,永遠湊不滿門檻,接上去等於永遠不會告警。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Connector } from '../types/index.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { trackChildProcess, terminateProcessTree } from '../core/process-runner.js';
import {
  classifyUpstreamStatus,
  countUpstreamRateLimitHits,
  hasUpstreamModelInvalid
} from '../core/rate-limit.js';
import { findUpstreamError } from '../core/opencode-event-parser.js';

/**
 * `client-outdated`:上游因為 opencode 版本太舊而拒絕(HTTP 426),模型本身沒問題。
 * `upstream-error`:上游回了其他錯誤。與 `unknown` 的差別是這裡確定有一個 error 事件。
 */
export type FailureCategory =
  | 'model-invalid'
  | 'rate-limited'
  | 'client-outdated'
  | 'upstream-error'
  | 'unknown';

export type HealthCheckOutcome =
  | { ok: true }
  | {
      ok: false;
      category: FailureCategory;
      message: string;
      /** 上游回的 HTTP 狀態碼;只有從 error 事件判定時才有。 */
      statusCode?: number;
    };

export type HealthState = {
  status: 'healthy' | 'failing';
  signature: string | null;
  /** 目前狀態的起始時間,用來算故障持續多久 */
  since: number;
  lastAlertAt: number;
};

export type AlertKind = 'none' | 'new-failure' | 'changed-failure' | 'reminder' | 'recovered';

export type AlertDecision = {
  alert: AlertKind;
  nextState: HealthState;
  outageMs?: number;
};

// 下架/EOL 的樣式改由 core/rate-limit.ts 統一提供 —— 這裡原本自帶一份較窄的清單
// (缺 `"statusCode":410`),與 scripts/probe-models.mjs 的判定分岔,是 2026-09-08
// 漏判的第三層原因。單一來源才不會再次各自演化。

const SIGNATURE_PREFIX_LENGTH = 120;

export const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
// 實測(2026-08-24,nvidia/minimaxai/minimax-m3):
//   prompt "ping"                → 超過 180s 未結束(agent 把它當任務去執行)
//   prompt "回覆 OK 兩個字即可"    → 70s
//   prompt "Reply with exactly: OK" → 10.9s
// 逾時取 120s 給約 11x 餘裕 —— 設太短會把健康的模型誤報成故障。
export const DEFAULT_TIMEOUT_MS = 120 * 1000;

/** 探針 prompt。務必是明確的最小指令:模糊的 prompt 會讓 agent 當成任務去跑,遲遲不結束。 */
export const PROBE_PROMPT = 'Reply with exactly: OK';

/**
 * 探測期間容許幾次上游限流。
 *
 * 健康的模型回答這句 prompt 只需要一次 model call —— 出現 429 就代表有重試。
 * 但只看 exit code 會漏掉「重試很多次但最後成功」這種降級狀態:2026-08-29 實測,
 * nvidia/moonshotai/kimi-k3 回答「1+1」重試了 5 次 429 仍 exit 0,舊版探針會判它健康,
 * 而同一顆模型跑真實排程任務時直接 429 到逾時。次數本身就是訊號。
 *
 * 取 2 而不是 1:容忍單次瞬斷,但抓得到持續性節流。
 */
export const RATE_LIMIT_DEGRADED_THRESHOLD = 2;
export const DEFAULT_REMIND_MS = 6 * 60 * 60 * 1000;

/**
 * 判定失敗類別。無法歸因時一律回 unknown —— 寧可說「無法確認」,
 * 也不要把認證失敗誤報成模型下架。
 */
export function classifyFailure(output: string): FailureCategory {
  // 先看限流:被節流時上游根本沒機會回下架訊息,兩者不會同時出現。
  if (countUpstreamRateLimitHits(output) > 0) return 'rate-limited';
  return hasUpstreamModelInvalid(output) ? 'model-invalid' : 'unknown';
}

/**
 * 失敗簽章：類別 + 狀態碼 + 訊息前段。用來區分「同一個故障」與「新的故障」。
 *
 * 沒有狀態碼時維持原本的兩段格式:升級當下若正處於故障中,狀態檔裡的舊簽章才對得上,
 * 不會因為格式改變多推一次。
 */
export function failureSignature(outcome: HealthCheckOutcome): string {
  if (outcome.ok) return 'ok';
  const prefix = outcome.message.slice(0, SIGNATURE_PREFIX_LENGTH);
  let hash = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    hash = (hash * 31 + prefix.charCodeAt(i)) | 0;
  }
  return outcome.statusCode === undefined
    ? `${outcome.category}:${hash}`
    : `${outcome.category}:${outcome.statusCode}:${hash}`;
}

/**
 * 狀態轉換決策（純函式）。
 *
 * 壓抑的只有「同一故障的第 2..N 次重複偵測」;每個獨立故障都會在發生當下推播,
 * 持續期間有定期提醒,恢復時有結束通知 —— 不是漏報。
 */
export function decideAlert(
  prev: HealthState | null,
  outcome: HealthCheckOutcome,
  now: number,
  remindMs: number
): AlertDecision {
  if (outcome.ok) {
    if (prev && prev.status === 'failing') {
      return {
        alert: 'recovered',
        outageMs: now - prev.since,
        nextState: { status: 'healthy', signature: null, since: now, lastAlertAt: now }
      };
    }
    return {
      alert: 'none',
      nextState: {
        status: 'healthy',
        signature: null,
        since: prev?.since ?? now,
        lastAlertAt: prev?.lastAlertAt ?? 0
      }
    };
  }

  const signature = failureSignature(outcome);

  if (!prev || prev.status === 'healthy') {
    return {
      alert: 'new-failure',
      nextState: { status: 'failing', signature, since: now, lastAlertAt: now }
    };
  }

  if (prev.signature !== signature) {
    // 錯誤性質改變（如 model-not-found 變成認證失敗）是新資訊,必須立刻說。
    return {
      alert: 'changed-failure',
      nextState: { status: 'failing', signature, since: now, lastAlertAt: now }
    };
  }

  if (now - prev.lastAlertAt >= remindMs) {
    return {
      alert: 'reminder',
      nextState: { ...prev, signature, lastAlertAt: now }
    };
  }

  return { alert: 'none', nextState: prev };
}

function readState(statePath: string): HealthState | null {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<HealthState>;
    if (parsed.status !== 'healthy' && parsed.status !== 'failing') return null;
    return {
      status: parsed.status,
      signature: typeof parsed.signature === 'string' ? parsed.signature : null,
      since: typeof parsed.since === 'number' ? parsed.since : 0,
      lastAlertAt: typeof parsed.lastAlertAt === 'number' ? parsed.lastAlertAt : 0
    };
  } catch {
    return null;
  }
}

function writeState(statePath: string, state: HealthState): void {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    recordRuntimeIssue('model-health:state-write', error);
  }
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} 小時 ${rest} 分鐘` : `${hours} 小時`;
}

function buildAlertText(
  alert: AlertKind,
  model: string,
  outcome: HealthCheckOutcome,
  outageMs?: number
): string {
  if (alert === 'recovered') {
    return `✅ 模型已恢復\n` + `模型：${model}\n` + `故障持續：${formatDuration(outageMs ?? 0)}`;
  }

  const snippet = outcome.ok ? '' : outcome.message.slice(0, 240);
  const header = alert === 'reminder' ? '⏰ 模型仍未恢復' : '🚨 模型健康檢查失敗';
  const status =
    !outcome.ok && outcome.statusCode !== undefined ? ` (HTTP ${outcome.statusCode})` : '';

  if (!outcome.ok && outcome.category === 'client-outdated') {
    return (
      `${header}\n` +
      `模型：${model}\n` +
      `原因：opencode 版本過舊，上游拒絕服務${status}\n` +
      `錯誤：${snippet}\n\n` +
      `模型本身沒有失效，換模型不一定有用。\n` +
      `請升級 opencode：更新到釘了較新 opencode-ai 版本的 TeleNexus 映像。`
    );
  }

  if (!outcome.ok && outcome.category === 'upstream-error') {
    return (
      `${header}\n` + `模型：${model}\n` + `原因：上游回了錯誤${status}\n` + `錯誤：${snippet}`
    );
  }

  if (!outcome.ok && outcome.category === 'model-invalid') {
    return (
      `${header}\n` +
      `模型：${model}\n` +
      `原因：模型已失效（下架或 EOL）${status}\n` +
      `錯誤：${snippet}\n\n` +
      `注意 opencode models 清單仍會列出已失效的模型,\n` +
      `換模型前請先實測：opencode run --model <名稱> "ping"`
    );
  }

  if (!outcome.ok && outcome.category === 'rate-limited') {
    return (
      `${header}\n` +
      `模型：${model}\n` +
      `原因：上游配額限流 (HTTP 429)\n` +
      `狀況：${snippet}\n\n` +
      `模型本身沒下架，是配額或流量被擋。可換模型或錯開排程時間；\n` +
      `用 npm run models:probe -- --models <名稱> 可實測其他候選。`
    );
  }

  // 無法歸因時措辭必須誠實,不猜成模型下架。
  return `${header}\n` + `模型：${model}\n` + `原因：無法確認模型可用性\n` + `錯誤：${snippet}`;
}

/**
 * 探針輸出的判定（純函式,與 spawn 解耦以便測試）。
 *
 * 順序即是這個函式的全部重點:結構化的 HTTP 訊號必須先於 exit code。
 * 2026-09-08 `nvidia/openai/gpt-oss-120b` 下架後,opencode 吞掉 AI_APICallError、
 * 吐出降級文字後以 exit 0 收場;舊版先看 `code === 0` 的順序讓探針連續 9 天回報
 * 健康,一次告警都沒發。scripts/probe-models.mjs 的 classify() 一直是對的順序,
 * 同一天用它一次就抓到了 —— 兩邊的差異就是這個 bug 本身。
 *
 * `output` 是套用文字樣式的來源(探針給的是 stderr);`stdout` 是 `--format json` 的事件。
 */
export function interpretProbeOutput(
  code: number | null,
  output: string,
  stdout = ''
): HealthCheckOutcome {
  // error 事件是最精確的訊號:它直接帶狀態碼,不必從 log 文字裡猜。2026-09-17 的 426 就是
  // 因為下面的樣式只列舉了 429 與 410 而被判成健康 —— 這裡不看狀態碼是哪一個,有就是不健康。
  const upstream = findUpstreamError(stdout)?.upstreamError;
  if (upstream?.statusCode !== undefined) {
    const upstreamClass = classifyUpstreamStatus(upstream.statusCode);
    return {
      ok: false,
      category: upstreamClass === 'other' ? 'upstream-error' : upstreamClass,
      message: upstream.message,
      statusCode: upstream.statusCode
    };
  }

  const hits = countUpstreamRateLimitHits(output);
  if (hits >= RATE_LIMIT_DEGRADED_THRESHOLD) {
    // exit 0 不等於健康:重試很多次才成功的模型,跑真實排程任務時就會 429 到逾時。
    return {
      ok: false,
      category: 'rate-limited',
      message: `模型仍能回應，但這次探測被上游限流 ${hits} 次 (HTTP 429)。`
    };
  }

  if (hasUpstreamModelInvalid(output)) {
    return { ok: false, category: 'model-invalid', message: output.trim().slice(0, 2000) };
  }

  // 沒有狀態碼的 error 事件(例如模型不存在時的 UnknownError)排在 stderr 樣式之後:
  // 事件裡只有一句通用訊息,真正的原因在 stderr。
  if (upstream) {
    return { ok: false, category: 'upstream-error', message: upstream.message };
  }

  if (code === 0) return { ok: true };

  return { ok: false, category: classifyFailure(output), message: output.trim().slice(0, 2000) };
}

/**
 * 事件是否代表「上游真的服務了這次請求」—— 流量豁免只能採信這種成功。
 *
 * `opencode_done` 不代表上游服務了請求:opencode 1.15 在上游錯誤時照樣 exit 0。
 * 2026-09-08 就是這種假成功持續餵養豁免視窗,讓探針 9 天沒跑過一次;2026-09-17 的 426
 * 又重演一次,因為當時的旗標只認得 stderr 裡的 410。`upstreamError` 來自 stdout 的
 * error 事件,不看狀態碼是哪一個。
 * main.ts 與 runner.ts 兩處 hook 共用這裡,避免判斷再次分岔。
 */
export function isRealSuccessEvent(type: string, payload: Record<string, unknown>): boolean {
  return (
    type === 'opencode_done' &&
    payload['upstreamInvalid'] !== true &&
    payload['upstreamError'] !== true
  );
}

/** 預設探針：實際打一次 opencode,因為靜態比對模型清單無效（已 EOL 的仍會列出）。 */
export async function defaultProbe(model: string, timeoutMs: number): Promise<HealthCheckOutcome> {
  return new Promise<HealthCheckOutcome>((resolve) => {
    // --format json 不可省:上游錯誤的狀態碼只在 stdout 的 error 事件裡。預設格式下 stdout
    // 是空的,opencode 1.18 的 stderr 也不再有狀態碼,410 與 426 都會落到「無法確認」。
    // --print-logs 不可省:少了它,上游的 429 只會進 opencode 自己的 log 檔,
    // 探針看到的就只有「跑很久然後沒輸出」,分不出限流、下架還是網路問題。
    const child = spawn(
      'opencode',
      [
        'run',
        '--format',
        'json',
        '--print-logs',
        '--log-level',
        'ERROR',
        '--model',
        model,
        PROBE_PROMPT
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32'
      }
    );
    trackChildProcess(child);

    // 分開收:兩條管線的 chunk 交錯到達,混在一起會把 stdout 的 JSON 行切斷。
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (outcome: HealthCheckOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      terminateProcessTree(child);
      finish({
        ok: false,
        category: 'unknown',
        message: `Health check timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({ ok: false, category: 'unknown', message: (error as Error).message });
    });
    child.on('close', (code) => {
      finish(interpretProbeOutput(code, stderr, stdout));
    });
  });
}

/** 供 context snapshot 讀取目前狀態;讀不到就回 null（尚未跑過第一次檢查）。 */
export function readHealthState(statePath: string): HealthState | null {
  return readState(statePath);
}

export type ModelHealthCheckOptions = {
  /** 省略代表不推播（runner 端只記錄) */
  connector?: Connector;
  adminUserId?: string;
  resolveModel: () => string | undefined;
  probe?: (model: string, timeoutMs: number) => Promise<HealthCheckOutcome>;
  statePath: string;
  /** <= 0 代表不自動排程,只能手動 runOnce（測試用） */
  intervalMs?: number;
  /** 流量豁免視窗;預設同 intervalMs。與排程週期解耦以便單獨調整與測試。 */
  exemptionWindowMs?: number;
  timeoutMs?: number;
  remindMs?: number;
  enabled?: boolean;
  now?: () => number;
  /** 最近一次真實成功呼叫的時間戳;週期內有成功流量就跳過 ping */
  lastSuccessAt?: () => number | null;
};

export function startModelHealthCheck(options: ModelHealthCheckOptions): {
  stop: () => void;
  runOnce: () => Promise<void>;
} {
  const {
    connector,
    adminUserId,
    resolveModel,
    probe = defaultProbe,
    statePath,
    intervalMs = DEFAULT_INTERVAL_MS,
    exemptionWindowMs = intervalMs,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    remindMs = DEFAULT_REMIND_MS,
    enabled = true,
    now = () => Date.now(),
    lastSuccessAt
  } = options;

  let timer: NodeJS.Timeout | null = null;

  // 整段包起來:這個函式跑在 bootstrap 內與 interval callback 中,兩處都以 void 丟棄 promise。
  // 任何漏網的 reject 都會變成 unhandled rejection —— 不能讓自檢把主服務帶下去。
  const runOnce = async (): Promise<void> => {
    try {
      await runOnceInner();
    } catch (error) {
      recordRuntimeIssue('model-health:internal', error);
    }
  };

  const runOnceInner = async (): Promise<void> => {
    if (!enabled) return;

    const model = resolveModel();
    if (!model) return;

    const at = now();
    let outcome: HealthCheckOutcome;

    // 週期內已有真實成功流量 → 模型顯然活著,不必再燒一次配額。
    const lastSuccess = lastSuccessAt?.() ?? null;
    if (lastSuccess !== null && exemptionWindowMs > 0 && at - lastSuccess < exemptionWindowMs) {
      outcome = { ok: true };
    } else {
      try {
        outcome = await probe(model, timeoutMs);
      } catch (error) {
        outcome = { ok: false, category: 'unknown', message: (error as Error).message };
      }
    }

    if (!outcome.ok) {
      // 模型名併進訊息而非 context —— IssueContext 只有 requestId,不為此擴充既有型別。
      recordRuntimeIssue(
        `model-health:${outcome.category}`,
        new Error(`[${model}] ${outcome.message}`)
      );
    }

    const prev = readState(statePath);
    const decision = decideAlert(prev, outcome, at, remindMs);
    writeState(statePath, decision.nextState);

    if (decision.alert === 'none') return;
    if (!connector || !adminUserId) return;

    const text = buildAlertText(decision.alert, model, outcome, decision.outageMs);
    try {
      await connector.sendMessage(adminUserId, text);
    } catch (error) {
      // 推播失敗不能讓檢查整個炸掉 —— 否則排程 timer 會被未捕捉的 rejection 帶走。
      recordRuntimeIssue('model-health:alert-failed', error);
    }
  };

  if (enabled && intervalMs > 0) {
    void runOnce();
    timer = setInterval(() => {
      void runOnce();
    }, intervalMs);
    timer.unref();
  }

  return {
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce
  };
}
