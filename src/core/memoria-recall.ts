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
