import http from 'http';
import https from 'https';
import { parsePositiveInt } from '../utils/env.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { emitEvent } from '../services/event-bus.js';
import { isDegradedRoute, recordMemoriaRecallTrace } from '../services/memoria-recall-telemetry.js';
import { createLogger } from './logger.js';

const logger = createLogger('MemoriaRecall');

type RecallHit = {
  id?: string;
  snippet?: string;
  score?: number;
};

/** Memoria 1.x 的回應是 MemoriaResult envelope:hits 在 data[],recall_id 在 meta。 */
type RecallResponse = {
  data?: RecallHit[];
  /** 舊版相容:早期實作預期的頂層 hits 欄位。 */
  hits?: RecallHit[];
  meta?: {
    recall_id?: string;
    /** 實際走到的召回路由:hybrid_tree / hybrid_fallback / vector_unavailable … */
    route_mode?: string;
    fallback_used?: boolean;
    /** null = 該路由無法判斷匹配品質,與 0(判斷過、很差)是不同的意思。 */
    confidence?: number | null;
    /** lexical_coverage / unavailable / no_hits(Memoria issue-9)。 */
    confidence_basis?: string;
  };
};

export type MemoriaRecallHit = { id: string; snippet: string };

/** Memoria 回應 meta 的召回品質資訊,欄位缺席時以 'unknown' 補齊而非省略。 */
export type MemoriaRecallMetaInfo = {
  routeMode: string;
  fallbackUsed: boolean;
  confidence: number | null;
  confidenceBasis: string;
};

export type MemoriaRecallResult = {
  snippets: string[];
  /** UFL 關聯 id,回覆完成後可用 reportRecallOutcome 回報效用。 */
  recallId?: string;
  hits: MemoriaRecallHit[];
  /** 召回路由與信心基準;請求失敗時不帶此欄位。 */
  meta?: MemoriaRecallMetaInfo;
};

/** 把 envelope 的 meta 正規化;舊版 Memoria 沒有這些欄位時退回 'unknown'。 */
function interpretRecallMeta(meta: RecallResponse['meta']): MemoriaRecallMetaInfo {
  return {
    routeMode: meta?.route_mode ?? 'unknown',
    fallbackUsed: meta?.fallback_used === true,
    confidence: typeof meta?.confidence === 'number' ? meta.confidence : null,
    confidenceBasis: meta?.confidence_basis ?? 'unknown'
  };
}

function getRecallEnabled(): boolean {
  const raw = process.env.MEMORIA_RECALL_ENABLED?.trim().toLowerCase();
  if (!raw || raw === 'auto') {
    return Boolean(process.env.MEMORIA_ENDPOINT?.trim());
  }
  return raw === 'on' || raw === '1' || raw === 'true';
}

function getRecallEndpoint(): string {
  return process.env.MEMORIA_ENDPOINT?.trim() || 'http://memoria:3917';
}

/** 共用的 Memoria HTTP endpoint(recall 與 remember 共用同一個服務)。 */
export function getMemoriaEndpoint(): string {
  return getRecallEndpoint();
}

function getRecallTimeoutMs(): number {
  return parsePositiveInt(process.env.MEMORIA_RECALL_TIMEOUT_MS, 1500);
}

function getRecallTopK(): number {
  return parsePositiveInt(process.env.MEMORIA_RECALL_TOP_K, 5);
}

export class MemoriaRecallClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly topK: number;
  private readonly project: string;

  constructor(options?: {
    endpoint?: string;
    timeoutMs?: number;
    topK?: number;
    project?: string;
  }) {
    this.endpoint = options?.endpoint ?? getRecallEndpoint();
    this.timeoutMs = options?.timeoutMs ?? getRecallTimeoutMs();
    this.topK = options?.topK ?? getRecallTopK();
    this.project = options?.project ?? 'TeleNexus';
  }

  async recall(query: string, scope?: string): Promise<string[]> {
    return (await this.recallWithMeta(query, scope)).snippets;
  }

  /** 回傳 snippets 之外,同時保留 recall_id 與 hit id,供 UFL outcome 回報使用。失敗回空結果不 throw。 */
  async recallWithMeta(query: string, scope?: string): Promise<MemoriaRecallResult> {
    const payload = {
      query,
      project: this.project,
      ...(scope ? { scope } : {}),
      top_k: this.topK,
      mode: 'hybrid'
    };

    const startedAt = Date.now();
    try {
      const { status, body } = await memoriaHttpRequest(
        this.endpoint,
        '/v1/recall',
        'POST',
        this.timeoutMs,
        payload
      );
      if (status < 200 || status >= 300) {
        throw new Error(`recall failed: HTTP ${status} ${body.slice(0, 200)}`);
      }

      const parsed = JSON.parse(body) as RecallResponse;
      const rawHits = parsed.data ?? parsed.hits ?? [];
      const snippets = rawHits.map((h) => h.snippet ?? '').filter((s) => s.trim().length > 0);
      const hits = rawHits.flatMap((h) =>
        h.id && h.snippet && h.snippet.trim().length > 0 ? [{ id: h.id, snippet: h.snippet }] : []
      );
      const recallId = parsed.meta?.recall_id;
      const meta = interpretRecallMeta(parsed.meta);
      const latencyMs = Date.now() - startedAt;

      recordMemoriaRecallTrace({
        timestamp: startedAt,
        ok: true,
        hitCount: rawHits.length,
        latencyMs,
        ...meta
      });
      emitEvent('memoria_recall', {
        ok: true,
        route_mode: meta.routeMode,
        fallback_used: meta.fallbackUsed,
        confidence: meta.confidence,
        confidence_basis: meta.confidenceBasis,
        hit_count: rawHits.length,
        latency_ms: latencyMs
      });
      // 語意索引服務不了、實際端出字面結果時要出聲——這種降級不講就是靜默降級。
      if (isDegradedRoute(meta.routeMode)) {
        logger.warn('recall_degraded', { routeMode: meta.routeMode, hits: rawHits.length });
        recordRuntimeIssue(
          `memoria:recall-degraded:${meta.routeMode}`,
          new Error(`Memoria 語意召回不可用,已退回字面召回 (route_mode=${meta.routeMode})`)
        );
      }

      return { snippets, hits, meta, ...(recallId ? { recallId } : {}) };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      const latencyMs = Date.now() - startedAt;
      logger.warn('recall_failed', { err: msg });
      recordRuntimeIssue('memoria:recall', error);
      recordMemoriaRecallTrace({
        timestamp: startedAt,
        ok: false,
        routeMode: 'error',
        fallbackUsed: false,
        confidence: null,
        confidenceBasis: 'unknown',
        hitCount: 0,
        latencyMs
      });
      emitEvent('memoria_recall', {
        ok: false,
        route_mode: 'error',
        latency_ms: latencyMs,
        error: msg
      });
      return { snippets: [], hits: [] };
    }
  }
}

/** 對 Memoria 服務發一次 HTTP 請求,回傳 { status, body }。逾時/連線失敗會 throw。 */
function memoriaHttpRequest(
  endpoint: string,
  pathname: string,
  method: 'GET' | 'POST',
  timeoutMs: number,
  payload?: unknown
): Promise<{ status: number; body: string }> {
  const url = new URL(`${endpoint}${pathname}`);
  const transport = url.protocol === 'https:' ? https : http;
  const body = payload === undefined ? undefined : JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {}
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Memoria request timed out after ${timeoutMs}ms`));
    });

    let text = '';
    req.on('response', (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 寫入一段對話記憶到 Memoria(POST /v1/remember)。失敗會 throw,讓呼叫端決定重試。 */
export async function rememberViaHttp(
  data: {
    id?: string;
    timestamp?: string;
    project?: string;
    scope?: string;
    summary?: string;
    events: unknown[];
  },
  options?: { endpoint?: string; timeoutMs?: number }
): Promise<void> {
  const endpoint = options?.endpoint ?? getMemoriaEndpoint();
  const timeoutMs = options?.timeoutMs ?? 20000;
  const { status, body } = await memoriaHttpRequest(
    endpoint,
    '/v1/remember',
    'POST',
    timeoutMs,
    data
  );
  if (status < 200 || status >= 300) {
    throw new Error(`remember failed: HTTP ${status} ${body.slice(0, 200)}`);
  }
}

// 與 Memoria SDK(dist 內 tokenizeQuery/tokenCoverage)相同的斷詞與覆蓋率計算,
// 確保回報的 utility_score 與官方 adapter 語意一致:CJK 連續字串視為單一 token。
const TOKEN_SPLIT_PATTERN = /[^a-z0-9一-鿿]+/;

/** 計算 snippet 的 token 有多少比例出現在 text 中(0~1)。 */
export function tokenCoverage(snippet: string, text: string): number {
  const tokens = Array.from(
    new Set(
      snippet
        .toLowerCase()
        .split(TOKEN_SPLIT_PATTERN)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2)
    )
  );
  if (tokens.length === 0) return 0;
  const haystack = text.toLowerCase();
  let found = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) found += 1;
  }
  return found / tokens.length;
}

export type RecallOutcomePayload = {
  signal: string;
  utility_score?: number;
  used?: boolean;
  hits?: { id: string; utility_score: number }[];
};

/** 以「hit snippet 在助理回覆中的 token 覆蓋率」組出 reuse outcome(同 Memoria 官方 adapter 的 implicit 訊號)。 */
export function buildReuseOutcome(
  hits: MemoriaRecallHit[],
  assistantText: string
): RecallOutcomePayload {
  const perHit = hits.map((h) => ({
    id: h.id,
    utility_score: tokenCoverage(h.snippet, assistantText)
  }));
  const utilityScore = perHit.length > 0 ? Math.max(...perHit.map((p) => p.utility_score)) : 0;
  return { signal: 'reuse', utility_score: utilityScore, hits: perHit };
}

/** 回報 recall 效用(POST /v1/recall/:id/outcome)。失敗不 throw,記 runtime issue 後回傳 false。 */
export async function reportRecallOutcome(
  recallId: string,
  outcome: RecallOutcomePayload,
  options?: { endpoint?: string; timeoutMs?: number }
): Promise<boolean> {
  const endpoint = options?.endpoint ?? getMemoriaEndpoint();
  const timeoutMs = options?.timeoutMs ?? 3000;
  try {
    const { status, body } = await memoriaHttpRequest(
      endpoint,
      `/v1/recall/${encodeURIComponent(recallId)}/outcome`,
      'POST',
      timeoutMs,
      outcome
    );
    if (status < 200 || status >= 300) {
      throw new Error(`recall outcome failed: HTTP ${status} ${body.slice(0, 200)}`);
    }
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('recall_outcome_failed', { recallId, err: msg });
    recordRuntimeIssue('memoria:recall-outcome', error);
    return false;
  }
}

/** 探測 Memoria 服務是否可達(GET /v1/health)。不 throw,回傳 boolean。 */
export async function pingMemoriaEndpoint(options?: {
  endpoint?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const endpoint = options?.endpoint ?? getMemoriaEndpoint();
  const timeoutMs = options?.timeoutMs ?? 1500;
  try {
    const { status } = await memoriaHttpRequest(endpoint, '/v1/health', 'GET', timeoutMs);
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}

let _singleton: MemoriaRecallClient | null = null;

export function getMemoriaRecallClient(): MemoriaRecallClient | null {
  if (!getRecallEnabled()) return null;
  if (!_singleton) {
    _singleton = new MemoriaRecallClient();
    logger.info('initialized', {
      endpoint: getRecallEndpoint(),
      topK: getRecallTopK(),
      timeoutMs: getRecallTimeoutMs()
    });
  }
  return _singleton;
}
