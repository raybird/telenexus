import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * issue 0030：模型面板的登入驗證（SCN-002）。
 *
 * 面板經 Quick Tunnel 對外公開，授權只看這裡驗過的 Telegram initData 與換發的憑證，
 * 不看來源 IP、X-Forwarded-For、Host 或 WEB_AUTH_TOKEN。
 *
 * initData 驗證依 Telegram 文件：
 * - secret = HMAC_SHA256(key="WebAppData", msg=bot token)
 * - hash = hex(HMAC_SHA256(key=secret, msg=data-check-string))
 * - data-check-string：hash 以外的欄位依 key 排序，`key=<解碼後的值>` 以 \n 連接
 *
 * 文件沒有說清楚 bot 端驗 hash 時 `signature` 欄位要不要納入，所以兩種算法都接受。
 * 兩種都要用 Bot token 才算得出來，安全性相同。
 */

export type InitDataFailure =
  | 'not-configured'
  | 'missing-hash'
  | 'malformed'
  | 'bad-hash'
  | 'expired'
  | 'future'
  | 'no-user'
  | 'not-allowed';

export type InitDataResult = { ok: true; userId: string } | { ok: false; reason: InitDataFailure };

export type VerifyInitDataOptions = {
  botToken: string;
  allowedUserId: string;
  nowMs?: number;
};

/** 已核准的工程預設（2026-11-17）：initData 開啟超過 10 分鐘就不能拿來登入。 */
const MAX_AGE_SEC = 600;
/** 容許主機與 Telegram 的時鐘誤差。 */
const MAX_FUTURE_SKEW_SEC = 60;

export function verifyInitData(initData: string, options: VerifyInitDataOptions): InitDataResult {
  const botToken = options.botToken.trim();
  const allowedUserId = options.allowedUserId.trim();
  if (!botToken || !allowedUserId) return fail('not-configured');

  const params = new URLSearchParams(initData);
  const fields = new Map<string, string>();
  for (const [key, value] of params) {
    // 重複欄位會讓「哪一個值被簽」產生歧義，直接拒絕。
    if (fields.has(key)) return fail('malformed');
    fields.set(key, value);
  }

  const hash = fields.get('hash');
  if (!hash) return fail('missing-hash');
  fields.delete('hash');

  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const matches = (excluded: string[]): boolean => {
    const dataCheckString = [...fields.entries()]
      .filter(([key]) => !excluded.includes(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');
    const expected = createHmac('sha256', secret).update(dataCheckString).digest('hex');
    return safeEqualHex(expected, hash);
  };
  if (!matches([]) && !(fields.has('signature') && matches(['signature']))) {
    return fail('bad-hash');
  }

  const authDate = Number(fields.get('auth_date'));
  if (!Number.isInteger(authDate) || authDate <= 0) return fail('malformed');
  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (nowSec - authDate > MAX_AGE_SEC) return fail('expired');
  if (authDate - nowSec > MAX_FUTURE_SKEW_SEC) return fail('future');

  const userId = readUserId(fields.get('user'));
  if (!userId) return fail('no-user');
  if (userId !== allowedUserId) return fail('not-allowed');
  return { ok: true, userId };
}

function fail(reason: InitDataFailure): InitDataResult {
  return { ok: false, reason };
}

function safeEqualHex(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function readUserId(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const user = JSON.parse(raw) as { id?: unknown };
    return typeof user?.id === 'number' && Number.isSafeInteger(user.id) ? String(user.id) : null;
  } catch {
    return null;
  }
}

/**
 * 登入後換發的面板憑證，只存在記憶體（重啟即失效）。
 * `revokeAll()` 在入口關閉或換網址時呼叫，舊網址拿到的憑證全部作廢（SCN-002、SCN-005）。
 */
export class PanelSessions {
  private sessions = new Map<string, string>();

  issue(userId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, userId);
    return token;
  }

  verify(token: string): { userId: string } | null {
    if (!token) return null;
    const userId = this.sessions.get(token);
    return userId === undefined ? null : { userId };
  }

  revokeAll(): void {
    this.sessions.clear();
  }
}
