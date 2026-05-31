import { createLogger } from '../core/logger.js';

const log = createLogger('interaction-guard');

export type InteractionState = {
  kind: string;
  expectedInput: string;
  allowedCommands: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  expiresAt: number | null;
};

export type StartOptions = {
  kind: string;
  expectedInput: string;
  allowedCommands?: string[];
  metadata?: Record<string, unknown>;
  expiresInMs?: number;
};

export const DEFAULT_ALLOWED_COMMANDS = ['/help', '/status', '/abort'];

export class InteractionGuard {
  private states = new Map<string, InteractionState>();

  start(userId: string, options: StartOptions): InteractionState {
    if (this.states.has(userId)) {
      this.clear(userId, 'state_replaced');
    }
    const now = Date.now();
    const state: InteractionState = {
      kind: options.kind,
      expectedInput: options.expectedInput,
      allowedCommands: options.allowedCommands
        ? [...new Set(options.allowedCommands.map((c) => c.toLowerCase()))]
        : [...DEFAULT_ALLOWED_COMMANDS],
      metadata: options.metadata ? { ...options.metadata } : {},
      createdAt: now,
      expiresAt: typeof options.expiresInMs === 'number' ? now + options.expiresInMs : null
    };
    this.states.set(userId, state);
    log.info('start', { userId, kind: state.kind });
    return state;
  }

  getState(userId: string): InteractionState | null {
    const state = this.states.get(userId);
    if (!state) return null;
    if (state.expiresAt && Date.now() >= state.expiresAt) {
      this.states.delete(userId);
      log.info('expired', { userId, kind: state.kind });
      return null;
    }
    return state;
  }

  isCommandAllowed(userId: string, content: string): boolean {
    const state = this.getState(userId);
    if (!state) return true;
    const token = content.split(/\s+/)[0]?.toLowerCase() ?? '';
    return state.allowedCommands.includes(token);
  }

  clear(userId: string, reason: string): void {
    if (this.states.delete(userId)) {
      log.info('clear', { userId, reason });
    }
  }
}

export const interactionGuard = new InteractionGuard();
