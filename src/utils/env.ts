/**
 * 統一環境變數解析工具
 */

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw?.trim() || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export function parseNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(raw?.trim() || '');
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

export function parseString(raw: string | undefined, fallback: string): string {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}
