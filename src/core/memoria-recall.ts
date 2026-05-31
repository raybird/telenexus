import http from 'http';
import https from 'https';
import { parsePositiveInt } from '../utils/env.js';
import { recordRuntimeIssue } from '../utils/errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('MemoriaRecall');

type RecallHit = {
  snippet?: string;
  score?: number;
};

type RecallResponse = {
  hits?: RecallHit[];
};

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
    const body = JSON.stringify({
      query,
      project: this.project,
      ...(scope ? { scope } : {}),
      top_k: this.topK,
      mode: 'hybrid'
    });

    const url = new URL(`${this.endpoint}/v1/recall`);
    const transport = url.protocol === 'https:' ? https : http;

    try {
      const responseText = await new Promise<string>((resolve, reject) => {
        const req = transport.request({
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || undefined,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body)
          }
        });

        req.setTimeout(this.timeoutMs, () => {
          req.destroy(new Error(`Memoria recall timed out after ${this.timeoutMs}ms`));
        });

        let text = '';
        req.on('response', (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () => resolve(text));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      const parsed = JSON.parse(responseText) as RecallResponse;
      const hits = parsed.hits ?? [];
      return hits
        .map((h) => h.snippet ?? '')
        .filter((s) => s.trim().length > 0);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn('recall_failed', { err: msg });
      recordRuntimeIssue('memoria:recall', error);
      return [];
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
  data: { id?: string; timestamp?: string; project?: string; scope?: string; summary?: string; events: unknown[] },
  options?: { endpoint?: string; timeoutMs?: number }
): Promise<void> {
  const endpoint = options?.endpoint ?? getMemoriaEndpoint();
  const timeoutMs = options?.timeoutMs ?? 20000;
  const { status, body } = await memoriaHttpRequest(endpoint, '/v1/remember', 'POST', timeoutMs, data);
  if (status < 200 || status >= 300) {
    throw new Error(`remember failed: HTTP ${status} ${body.slice(0, 200)}`);
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
