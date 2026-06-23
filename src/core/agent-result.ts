export type AgentProvider = 'opencode';

export type AgentStructuredResult = {
  text: string;
  provider: AgentProvider;
  sessionId?: string;
  stats?: unknown;
  raw?: unknown;
  events?: unknown[];
};

export type AgentEvent =
  | { type: 'start'; provider: AgentProvider }
  | { type: 'status'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'usage'; stats: unknown }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };

export function buildTextOnlyStructuredResult(
  provider: AgentProvider,
  text: string,
  extra: Omit<AgentStructuredResult, 'provider' | 'text'> = {}
): AgentStructuredResult {
  return {
    provider,
    text,
    ...extra
  };
}
