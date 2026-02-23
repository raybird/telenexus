import dotenv from 'dotenv';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { randomUUID } from 'crypto';
import yaml from 'js-yaml';
import { GeminiAgent } from './core/gemini.js';
import { OpencodeAgent } from './core/opencode.js';

dotenv.config();

type Provider = 'gemini' | 'opencode';
type RunnerTask = 'chat' | 'summarize';

type RunnerRequest = {
  task?: RunnerTask;
  input?: string;
  provider?: Provider;
  model?: string;
  isPassthroughCommand?: boolean;
  forceNewSession?: boolean;
};

type AIConfig = {
  provider?: string;
  model?: string;
};

const gemini = new GeminiAgent();
const opencode = new OpencodeAgent();
const runnerSharedSecret = process.env.RUNNER_SHARED_SECRET?.trim() || null;
const serializeGemini =
  (process.env.RUNNER_SERIALIZE_GEMINI || 'true').trim().toLowerCase() !== 'false';
const zombieWarnThreshold = Number.parseInt(process.env.RUNNER_ZOMBIE_WARN_THRESHOLD || '8', 10);
let geminiExecutionQueue: Promise<void> = Promise.resolve();

function runGeminiInQueue<T>(task: () => Promise<T>): Promise<T> {
  const pending = geminiExecutionQueue.then(task);
  geminiExecutionQueue = pending.then(
    () => undefined,
    () => undefined
  );
  return pending;
}

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
  while (recentOutcomes.length > 0 && recentOutcomes[0]!.timestamp < cutoff) {
    recentOutcomes.shift();
  }
}

function resolveAuditPath(): string {
  const configured = process.env.RUNNER_AUDIT_PATH?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  const projectDir = process.env.GEMINI_PROJECT_DIR?.trim() || process.cwd();
  return path.resolve(projectDir, 'workspace', 'context', 'runner-audit.log');
}

function appendAuditLine(payload: Record<string, unknown>): void {
  try {
    const auditPath = resolveAuditPath();
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (error) {
    console.warn('[Runner] Failed to write audit log:', error);
  }
}

function classifyRunnerError(message: string): string {
  if (/invalid argument/i.test(message)) {
    return 'gemini_bad_request_invalid_argument';
  }
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
  const projectDir = process.env.GEMINI_PROJECT_DIR?.trim() || process.cwd();
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
    console.warn('[Runner] Failed to write runner status:', error);
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
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(content) as AIConfig;
    const result: { provider: Provider; model?: string } = {
      provider: parsed?.provider === 'opencode' ? 'opencode' : 'gemini'
    };
    if (typeof parsed?.model === 'string' && parsed.model.trim().length > 0) {
      result.model = parsed.model;
    }
    return result;
  } catch {
    return { provider: 'gemini' };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
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
  return Boolean(token && token === runnerSharedSecret);
}

async function executeTask(
  request: RunnerRequest
): Promise<{ provider: Provider; output: string }> {
  const config = loadProviderConfig();
  const provider = request.provider || config.provider;
  const model = request.model || config.model;
  const options = model
    ? {
        model,
        ...(request.isPassthroughCommand ? { isPassthroughCommand: true } : {}),
        ...(request.forceNewSession ? { forceNewSession: true } : {})
      }
    : request.isPassthroughCommand
      ? { isPassthroughCommand: true }
      : request.forceNewSession
        ? { forceNewSession: true }
        : undefined;

  if (!request.input || !request.task) {
    throw new Error('Invalid request: task and input are required.');
  }

  if (provider === 'opencode') {
    const output =
      request.task === 'chat'
        ? await opencode.chat(request.input, options)
        : await opencode.summarize(request.input, options);
    return { provider, output };
  }

  const output =
    request.task === 'chat'
      ? await (serializeGemini
          ? runGeminiInQueue(() => gemini.chat(request.input!, options))
          : gemini.chat(request.input, options))
      : await (serializeGemini
          ? runGeminiInQueue(() => gemini.summarize(request.input!, options))
          : gemini.summarize(request.input, options));
  return { provider: 'gemini', output };
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
    const requestId = randomUUID();
    const startedAt = Date.now();

    try {
      if (!isRunnerAuthorized(req)) {
        const durationMs = Date.now() - startedAt;
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
      const result = await executeTask(parsed);
      const durationMs = Date.now() - startedAt;

      appendAuditLine({
        requestId,
        timestamp: startedAt,
        durationMs,
        ok: true,
        task: parsed.task,
        provider: result.provider,
        model: parsed.model || '(default)',
        passthrough: parsed.isPassthroughCommand === true
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

      sendJson(res, 200, {
        ok: true,
        requestId,
        durationMs,
        provider: result.provider,
        output: result.output
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
      sendJson(res, 500, { ok: false, requestId, durationMs, error: message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

server.listen(port, '0.0.0.0', () => {
  writeRunnerStatus();
  console.log(`[Runner] agent-runner listening on :${port}`);
});
