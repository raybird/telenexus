import dotenv from 'dotenv';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';
import { OpencodeAgent } from './core/opencode.js';
import { terminateAllChildren } from './core/process-runner.js';
import type { AgentEvent, AgentStructuredResult } from './core/agent-result.js';
import { safeCompare } from './utils/crypto.js';
import { resolveProjectDir } from './utils/paths.js';
import { createLogger } from './core/logger.js';
import { loadAiConfig } from './core/config-loader.js';
import { emitEvent } from './services/event-bus.js';
import { createAuditLogWriter } from './services/audit-log.js';

const logger = createLogger('Runner');

dotenv.config();

type Provider = 'opencode';
type RunnerTask = 'chat' | 'summarize';
type Lane = 'interactive' | 'scheduled';

type RunnerRequest = {
  task?: RunnerTask;
  input?: string;
  provider?: Provider;
  model?: string;
  requestId?: string;
  isPassthroughCommand?: boolean;
  forceNewSession?: boolean;
  autoRecoveryNotice?: boolean;
  lane?: Lane;
};

// 每 lane 一條序列化 Promise 鏈；兩 lane 可並行，同 lane 內依序執行
const laneQueues: Record<Lane, Promise<void>> = {
  interactive: Promise.resolve(),
  scheduled: Promise.resolve()
};
const activeLaneCounts: Record<Lane, number> = { interactive: 0, scheduled: 0 };

function withLane<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
  const prev = laneQueues[lane];
  let settle!: () => void;
  laneQueues[lane] = new Promise<void>((r) => { settle = r; });
  return prev
    .then(() => {
      activeLaneCounts[lane] += 1;
      return fn();
    })
    .finally(() => {
      activeLaneCounts[lane] = Math.max(0, activeLaneCounts[lane] - 1);
      settle();
    });
}

const opencode = new OpencodeAgent();
const runnerSharedSecret = process.env.RUNNER_SHARED_SECRET?.trim() || null;
const zombieWarnThreshold = Number.parseInt(process.env.RUNNER_ZOMBIE_WARN_THRESHOLD || '8', 10);

type RunnerStats = {
  startedAt: number;
  updatedAt: number;
  total: number;
  success: number;
  failed: number;
  totalDurationMs: number;
  lastRequestId?: string;
  lastTask?: RunnerTask;
  lastProvider?: Provider;
  lastDurationMs?: number;
  lastError?: string;
};

type RunnerOutcome = {
  timestamp: number;
  ok: boolean;
  durationMs: number;
};

const runnerStats: RunnerStats = {
  startedAt: Date.now(),
  updatedAt: Date.now(),
  total: 0,
  success: 0,
  failed: 0,
  totalDurationMs: 0
};

const recentOutcomes: RunnerOutcome[] = [];
const RECENT_WINDOW_MS = 5 * 60 * 1000;

function pruneRecentOutcomes(now: number): void {
  const cutoff = now - RECENT_WINDOW_MS;
  let firstValid = 0;
  while (firstValid < recentOutcomes.length && recentOutcomes[firstValid]!.timestamp < cutoff) {
    firstValid++;
  }
  if (firstValid > 0) {
    recentOutcomes.splice(0, firstValid);
  }
}

function resolveAuditPath(): string {
  const configured = process.env.RUNNER_AUDIT_PATH?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  const projectDir = resolveProjectDir();
  return path.resolve(projectDir, 'workspace', 'context', 'runner-audit.log');
}

// 日輪替 + 7 天保留,與 event-bus 的 events.jsonl 同策略(先前這個檔案完全沒有清理機制)。
const auditWriter = createAuditLogWriter(resolveAuditPath);

function appendAuditLine(payload: Record<string, unknown>): void {
  try {
    auditWriter.append(JSON.stringify(payload));
  } catch (error) {
    logger.warn('audit_write_failed', { err: error instanceof Error ? error.message : String(error) });
  }
}

function classifyRunnerError(message: string): string {
  if (/timed out|ETIMEDOUT|timeout/i.test(message)) {
    return 'runner_timeout';
  }
  if (/unauthorized-token|Unauthorized runner token/i.test(message)) {
    return 'runner_unauthorized';
  }
  return 'runner_error_other';
}

function resolveStatusPath(): string {
  const configured = process.env.RUNNER_STATUS_PATH?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  const projectDir = resolveProjectDir();
  return path.resolve(projectDir, 'workspace', 'context', 'runner-status.md');
}

function getZombieProcessCount(): number {
  try {
    const entries = fs.readdirSync('/proc', { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
        continue;
      }
      try {
        const stat = fs.readFileSync(`/proc/${entry.name}/stat`, 'utf8');
        const match = stat.match(/^\d+\s+\(.+\)\s+([A-Z])/);
        if (match?.[1] === 'Z') {
          count += 1;
        }
      } catch {
        // Process may have already exited between readdir and read.
      }
    }
    return count;
  } catch {
    return -1;
  }
}

function writeRunnerStatus(): void {
  try {
    const statusPath = resolveStatusPath();
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    const avgDuration =
      runnerStats.success > 0 ? Math.round(runnerStats.totalDurationMs / runnerStats.success) : 0;
    const successRate =
      runnerStats.total > 0 ? ((runnerStats.success / runnerStats.total) * 100).toFixed(1) : '0.0';
    const recentSuccess = recentOutcomes.filter((item) => item.ok).length;
    const recentRate =
      recentOutcomes.length > 0
        ? ((recentSuccess / recentOutcomes.length) * 100).toFixed(1)
        : '0.0';
    const recentAvgDuration =
      recentSuccess > 0
        ? Math.round(
            recentOutcomes
              .filter((item) => item.ok)
              .reduce((acc, item) => acc + item.durationMs, 0) / recentSuccess
          )
        : 0;
    const zombieCount = getZombieProcessCount();
    const zombieWarn = zombieCount >= 0 && zombieCount >= zombieWarnThreshold;

    const lines = [
      '# Runner Status',
      '',
      `- Updated: ${new Date(runnerStats.updatedAt).toLocaleString('zh-TW')}`,
      `- Started: ${new Date(runnerStats.startedAt).toLocaleString('zh-TW')}`,
      `- Active Lanes: interactive=${activeLaneCounts.interactive} scheduled=${activeLaneCounts.scheduled}`,
      `- Total Requests: ${runnerStats.total}`,
      `- Success: ${runnerStats.success}`,
      `- Failed: ${runnerStats.failed}`,
      `- Success Rate: ${successRate}%`,
      `- Avg Duration (success): ${avgDuration}ms`,
      `- Last 5m Requests: ${recentOutcomes.length}`,
      `- Last 5m Success Rate: ${recentRate}%`,
      `- Last 5m Avg Duration (success): ${recentAvgDuration}ms`,
      `- Zombie Processes: ${zombieCount >= 0 ? zombieCount : 'unavailable'}`,
      `- Zombie Warn Threshold: ${Number.isFinite(zombieWarnThreshold) ? zombieWarnThreshold : 8}`,
      `- Zombie Health: ${zombieWarn ? 'warning' : 'ok'}`,
      `- Audit Log: ${resolveAuditPath()}`,
      '',
      '## Last Request',
      `- Request ID: ${runnerStats.lastRequestId || '(none)'}`,
      `- Task: ${runnerStats.lastTask || '(none)'}`,
      `- Provider: ${runnerStats.lastProvider || '(none)'}`,
      `- Duration: ${typeof runnerStats.lastDurationMs === 'number' ? `${runnerStats.lastDurationMs}ms` : '(none)'}`,
      `- Last Error: ${runnerStats.lastError || '(none)'}`
    ];

    fs.writeFileSync(statusPath, lines.join('\n'), 'utf8');
  } catch (error) {
    logger.warn('status_write_failed', { err: error instanceof Error ? error.message : String(error) });
  }
}

function markRunnerResult(result: {
  requestId: string;
  durationMs: number;
  ok: boolean;
  task?: RunnerTask;
  provider?: Provider;
  error?: string;
}): void {
  const now = Date.now();
  runnerStats.updatedAt = now;
  runnerStats.total += 1;
  runnerStats.lastRequestId = result.requestId;
  runnerStats.lastDurationMs = result.durationMs;
  if (result.task) {
    runnerStats.lastTask = result.task;
  } else {
    delete runnerStats.lastTask;
  }
  if (result.provider) {
    runnerStats.lastProvider = result.provider;
  } else {
    delete runnerStats.lastProvider;
  }
  if (result.error) {
    runnerStats.lastError = result.error;
  } else {
    delete runnerStats.lastError;
  }

  if (result.ok) {
    runnerStats.success += 1;
    runnerStats.totalDurationMs += result.durationMs;
  } else {
    runnerStats.failed += 1;
  }

  recentOutcomes.push({
    timestamp: now,
    ok: result.ok,
    durationMs: result.durationMs
  });
  pruneRecentOutcomes(now);

  writeRunnerStatus();
}

function loadProviderConfig(configPath = 'ai-config.yaml'): { provider: Provider; model?: string } {
  const config = loadAiConfig({ basePath: configPath });
  const result: { provider: Provider; model?: string } = { provider: 'opencode' };
  if (config.model) {
    result.model = config.model;
  }
  return result;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body too large (>${MAX_BODY_BYTES} bytes)`));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (error) => reject(error));
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function writeSseEvent(
  res: http.ServerResponse,
  event: string,
  payload: Record<string, unknown>
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getRunnerToken(req: http.IncomingMessage): string | null {
  const token = req.headers['x-runner-token'];
  const presented = Array.isArray(token) ? token[0] : token;
  return presented || null;
}

function isRunnerAuthorized(req: http.IncomingMessage): boolean {
  if (!runnerSharedSecret) {
    return true;
  }
  const token = getRunnerToken(req);
  return Boolean(token && safeCompare(token, runnerSharedSecret));
}

async function executeTask(
  request: RunnerRequest
): Promise<{ provider: Provider; output: string; structured?: AgentStructuredResult }> {
  const { model: configModel } = loadProviderConfig();
  const model = request.model || configModel;
  const options = model
    ? {
        model,
        ...(request.isPassthroughCommand ? { isPassthroughCommand: true } : {}),
        ...(request.forceNewSession ? { forceNewSession: true } : {}),
        ...(request.autoRecoveryNotice ? { autoRecoveryNotice: true } : {})
      }
    : request.isPassthroughCommand
      ? {
          isPassthroughCommand: true,
          ...(request.autoRecoveryNotice ? { autoRecoveryNotice: true } : {})
        }
      : request.forceNewSession
        ? {
            forceNewSession: true,
            ...(request.autoRecoveryNotice ? { autoRecoveryNotice: true } : {})
          }
        : request.autoRecoveryNotice
          ? { autoRecoveryNotice: true }
          : undefined;

  if (!request.input || !request.task) {
    throw new Error('Invalid request: task and input are required.');
  }

  if (request.task === 'chat') {
    const structured = await opencode.chatStructured(request.input, options);
    return { provider: 'opencode', output: structured.text, structured };
  }
  const output = await opencode.summarize(request.input, options);
  return { provider: 'opencode', output };
}

async function executeTaskStream(
  request: RunnerRequest,
  onEvent: (event: AgentEvent) => Promise<void> | void
): Promise<{ provider: Provider; output: string; structured?: AgentStructuredResult }> {
  const { model: configModel } = loadProviderConfig();
  const provider: Provider = 'opencode';
  const model = request.model || configModel;
  const options = model
    ? {
        model,
        ...(request.isPassthroughCommand ? { isPassthroughCommand: true } : {}),
        ...(request.forceNewSession ? { forceNewSession: true } : {}),
        ...(request.autoRecoveryNotice ? { autoRecoveryNotice: true } : {})
      }
    : request.isPassthroughCommand
      ? {
          isPassthroughCommand: true,
          ...(request.autoRecoveryNotice ? { autoRecoveryNotice: true } : {})
        }
      : request.forceNewSession
        ? {
            forceNewSession: true,
            ...(request.autoRecoveryNotice ? { autoRecoveryNotice: true } : {})
          }
        : request.autoRecoveryNotice
          ? { autoRecoveryNotice: true }
          : undefined;

  if (!request.input || request.task !== 'chat') {
    throw new Error('Invalid stream request: chat task and input are required.');
  }

  if (opencode.streamChat) {
    const structured = await opencode.streamChat(request.input, options, onEvent);
    return { provider: 'opencode', output: structured.text, structured };
  }

  await onEvent({ type: 'start', provider });
  const structured = await opencode.chatStructured(request.input, options);
  if (structured.stats !== undefined) {
    await onEvent({ type: 'usage', stats: structured.stats });
  }
  await onEvent({ type: 'done', text: structured.text });
  return { provider: 'opencode', output: structured.text, structured };
}

const port = Number.parseInt(process.env.RUNNER_PORT || '8787', 10);

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { ok: false, error: 'Missing URL' });
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'agent-runner',
      pid: process.pid,
      auditPath: resolveAuditPath(),
      timestamp: Date.now()
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/stats') {
    if (!isRunnerAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: 'Unauthorized runner token.' });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      stats: runnerStats,
      recentWindowSize: recentOutcomes.length,
      statusPath: resolveStatusPath(),
      auditPath: resolveAuditPath()
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    const callerRequestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].trim() : '';
    const requestId = callerRequestId || randomUUID();
    const startedAt = Date.now();

    try {
      if (!isRunnerAuthorized(req)) {
        const durationMs = Date.now() - startedAt;
        logger.warn('run_auth_failed', { requestId });
        markRunnerResult({
          requestId,
          durationMs,
          ok: false,
          error: 'unauthorized-token'
        });
        appendAuditLine({
          requestId,
          timestamp: startedAt,
          durationMs,
          ok: false,
          httpStatus: 401,
          reason: 'unauthorized-token'
        });
        sendJson(res, 401, { ok: false, error: 'Unauthorized runner token.' });
        return;
      }

      const raw = await readBody(req);
      const parsed = JSON.parse(raw || '{}') as RunnerRequest;
      const lane: Lane = parsed.lane === 'scheduled' ? 'scheduled' : 'interactive';
      logger.info('run_start', { requestId, task: parsed.task, stream: false, lane });
      emitEvent('runner_request_start', { requestId, task: parsed.task, stream: false, lane });
      const result = await withLane(lane, () => executeTask(parsed));
      const durationMs = Date.now() - startedAt;

      appendAuditLine({
        requestId,
        timestamp: startedAt,
        durationMs,
        ok: true,
        task: parsed.task,
        provider: result.provider,
        model: parsed.model || '(default)',
        passthrough: parsed.isPassthroughCommand === true,
        lane
      });
      const successResult: {
        requestId: string;
        durationMs: number;
        ok: boolean;
        task?: RunnerTask;
        provider?: Provider;
      } = {
        requestId,
        durationMs,
        ok: true,
        provider: result.provider
      };
      if (parsed.task) {
        successResult.task = parsed.task;
      }
      markRunnerResult(successResult);
      logger.info('run_done', { requestId, durationMs, provider: result.provider, lane });
      emitEvent('runner_request_done', { requestId, durationMs, provider: result.provider, stream: false, lane });

      sendJson(res, 200, {
        ok: true,
        requestId,
        durationMs,
        provider: result.provider,
        output: result.output,
        ...(result.structured ? { structured: result.structured } : {})
      });
    } catch (error: unknown) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      const errorType = classifyRunnerError(message);
      appendAuditLine({
        requestId,
        timestamp: startedAt,
        durationMs,
        ok: false,
        httpStatus: 500,
        error: message,
        errorType
      });
      markRunnerResult({
        requestId,
        durationMs,
        ok: false,
        error: `${errorType}: ${message}`
      });
      logger.warn('run_error', { requestId, durationMs, error: message });
      emitEvent('runner_request_error', { requestId, durationMs, error: message, stream: false });
      sendJson(res, 500, { ok: false, requestId, durationMs, error: message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/run/stream') {
    const callerRequestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].trim() : '';
    const requestId = callerRequestId || randomUUID();
    const startedAt = Date.now();

    try {
      if (!isRunnerAuthorized(req)) {
        const durationMs = Date.now() - startedAt;
        logger.warn('run_auth_failed', { requestId, stream: true });
        markRunnerResult({
          requestId,
          durationMs,
          ok: false,
          error: 'unauthorized-token'
        });
        appendAuditLine({
          requestId,
          timestamp: startedAt,
          durationMs,
          ok: false,
          httpStatus: 401,
          reason: 'unauthorized-token',
          streaming: true
        });
        sendJson(res, 401, { ok: false, error: 'Unauthorized runner token.' });
        return;
      }

      const raw = await readBody(req);
      const parsed = JSON.parse(raw || '{}') as RunnerRequest;
      const lane: Lane = parsed.lane === 'scheduled' ? 'scheduled' : 'interactive';
      logger.info('run_start', { requestId, task: parsed.task, stream: true, lane });
      emitEvent('runner_request_start', { requestId, task: parsed.task, stream: true, lane });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });

      const result = await withLane(lane, () => executeTaskStream(parsed, async (event) => {
        if (event.type === 'start') {
          writeSseEvent(res, 'start', { provider: event.provider });
          return;
        }
        if (event.type === 'status') {
          writeSseEvent(res, 'status', { text: event.text });
          return;
        }
        if (event.type === 'reasoning') {
          writeSseEvent(res, 'reasoning', { text: event.text });
          return;
        }
        if (event.type === 'delta') {
          writeSseEvent(res, 'delta', { text: event.text });
          return;
        }
        if (event.type === 'usage') {
          writeSseEvent(res, 'usage', { stats: event.stats });
          return;
        }
        if (event.type === 'error') {
          writeSseEvent(res, 'error', { message: event.message });
          return;
        }
        if (event.type === 'done') {
          writeSseEvent(res, 'done', { text: event.text });
        }
      }));

      const durationMs = Date.now() - startedAt;
      appendAuditLine({
        requestId,
        timestamp: startedAt,
        durationMs,
        ok: true,
        task: parsed.task,
        provider: result.provider,
        model: parsed.model || '(default)',
        passthrough: parsed.isPassthroughCommand === true,
        streaming: true,
        lane
      });
      const successResult: {
        requestId: string;
        durationMs: number;
        ok: boolean;
        task?: RunnerTask;
        provider?: Provider;
      } = {
        requestId,
        durationMs,
        ok: true,
        provider: result.provider
      };
      if (parsed.task) {
        successResult.task = parsed.task;
      }
      markRunnerResult(successResult);
      logger.info('run_done', { requestId, durationMs, provider: result.provider, stream: true, lane });
      emitEvent('runner_request_done', { requestId, durationMs, provider: result.provider, stream: true, lane });
      writeSseEvent(res, 'result', {
        ok: true,
        requestId,
        durationMs,
        provider: result.provider,
        output: result.output,
        ...(result.structured ? { structured: result.structured } : {})
      });
      res.end();
    } catch (error: unknown) {
      const durationMs = Date.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);
      const errorType = classifyRunnerError(message);
      appendAuditLine({
        requestId,
        timestamp: startedAt,
        durationMs,
        ok: false,
        httpStatus: 500,
        error: message,
        errorType,
        streaming: true
      });
      markRunnerResult({
        requestId,
        durationMs,
        ok: false,
        error: `${errorType}: ${message}`
      });
      logger.warn('run_error', { requestId, durationMs, error: message, stream: true });
      emitEvent('runner_request_error', { requestId, durationMs, error: message, stream: true });
      try {
        if (!res.headersSent) {
          res.writeHead(500, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive'
          });
        }
        writeSseEvent(res, 'error', { message, requestId, durationMs });
      } finally {
        res.end();
      }
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(port, '0.0.0.0', () => {
  writeRunnerStatus();
  logger.info('listening', { port });
});

// runner 先前完全沒有 signal handler,靠 Node 的預設行為終止 —— 而預設終止不會觸發
// 'exit' handler,子程序因此無人收拾。容器內因為 node 就是 PID 1、行程一死容器就死,
// 看不出問題;本機 `npm run dev:runner` 按 Ctrl-C 則會留下 opencode 與整棵 Chrome。
// 註冊 listener 會關掉預設終止,所以這裡必須自己 exit。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const terminated = terminateAllChildren();
    logger.info('shutdown', { signal, terminatedChildren: terminated });
    server.close(() => process.exit(0));
    // 有 keep-alive 連線時 server.close() 可能等不到;給一個上限就走。
    setTimeout(() => process.exit(0), 3000).unref?.();
  });
}
