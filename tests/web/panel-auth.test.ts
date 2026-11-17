// issue 0030 Task 1.1（SCN-002）：Telegram initData 驗證與面板憑證。
// 簽章期望值不在測試裡用 Node 重算：以下 hash 由 Python hmac 依 Telegram 文件
// （secret = HMAC_SHA256(key="WebAppData", msg=bot_token)；hash = hex(HMAC_SHA256(key=secret,
// msg=data-check-string))，欄位依 key 排序、值為解碼後原文、以 \n 連接）另外算出的字面值。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PanelSessions, verifyInitData } from '../../src/web/panel-auth.js';

const BOT_TOKEN = '123456:TEST-token-for-unit-tests';
const ALLOWED = '424242';
const AUTH_DATE = 1763337600;
const NOW_MS = (AUTH_DATE + 30) * 1000;

const USER_Q =
  'user=%7B%22id%22%3A424242%2C%22first_name%22%3A%22Test%22%2C%22username%22%3A%22tester%22%7D';
const SIG_Q = 'signature=c2lnbmF0dXJlLXBsYWNlaG9sZGVy';

/** 沒有 signature 欄位，hash 涵蓋 auth_date、query_id、user。 */
const PLAIN = `auth_date=${AUTH_DATE}&query_id=AAHtest&${USER_Q}&hash=902cb11e533a2f911a40ea3cb24425db197701682f9d0666dac6f591ba7622f4`;
/** 有 signature，hash 涵蓋 signature（文件 bot 端「all received fields」的字面讀法）。 */
const WITH_SIG_INCLUDED = `auth_date=${AUTH_DATE}&query_id=AAHtest&${USER_Q}&${SIG_Q}&hash=0420b03727e9d1ef058a940771aee721b18a00437201a268a6014569ab339452`;
/** 有 signature，hash 不涵蓋 signature（第三方驗證段落的排除法）。 */
const WITH_SIG_EXCLUDED = `auth_date=${AUTH_DATE}&query_id=AAHtest&${USER_Q}&${SIG_Q}&hash=902cb11e533a2f911a40ea3cb24425db197701682f9d0666dac6f591ba7622f4`;
/** 簽章正確，但 user.id 是 999。 */
const OTHER_USER = `auth_date=${AUTH_DATE}&query_id=AAHtest&user=%7B%22id%22%3A999%2C%22first_name%22%3A%22Other%22%7D&${SIG_Q}&hash=0c61413f8159852795aa71511b47247f3694e719e37cf543b58857494670e5d4`;
/** 簽章正確，但沒有 user。 */
const NO_USER = `auth_date=${AUTH_DATE}&query_id=AAHtest&hash=cb274e85287739ee72d42c2d105c57dda355c959058efc787737dd2b7cfe0fb8`;
/** 用另一個 Bot token 簽的。 */
const WRONG_TOKEN = `auth_date=${AUTH_DATE}&query_id=AAHtest&${USER_Q}&hash=a68ae034a6be140ea215f196a68d0458e53654d037b614e5786cb53ae856c28c`;

function check(initData: string, nowMs: number = NOW_MS) {
  return verifyInitData(initData, { botToken: BOT_TOKEN, allowedUserId: ALLOWED, nowMs });
}

test('SCN-002：正確簽章、時效內的白名單帳號通過，回傳使用者 id', () => {
  assert.deepEqual(check(PLAIN), { ok: true, userId: '424242' });
});

test('SCN-002：signature 欄位無論是否納入 hash 計算都接受（兩種讀法都需要 Bot token）', () => {
  assert.deepEqual(check(WITH_SIG_INCLUDED), { ok: true, userId: '424242' });
  assert.deepEqual(check(WITH_SIG_EXCLUDED), { ok: true, userId: '424242' });
});

test('SCN-002：竄改任一欄位就拒絕', () => {
  const tampered = [
    PLAIN.replace('424242', '424243'),
    PLAIN.replace(`auth_date=${AUTH_DATE}`, `auth_date=${AUTH_DATE + 1}`),
    PLAIN.replace('query_id=AAHtest', 'query_id=AAHtesu'),
    PLAIN.replace('&hash=902c', '&hash=902d'),
    `${PLAIN}&extra=1`
  ];
  for (const data of tampered) {
    assert.deepEqual(check(data), { ok: false, reason: 'bad-hash' }, data);
  }
});

test('SCN-002：其他 Bot token 簽的 initData 拒絕', () => {
  assert.deepEqual(check(WRONG_TOKEN), { ok: false, reason: 'bad-hash' });
});

test('SCN-002：缺 hash、空字串、重複欄位都拒絕', () => {
  assert.deepEqual(check(''), { ok: false, reason: 'missing-hash' });
  assert.deepEqual(check(PLAIN.replace(/&hash=[0-9a-f]+$/, '')), {
    ok: false,
    reason: 'missing-hash'
  });
  assert.deepEqual(
    check(`${PLAIN}&hash=902cb11e533a2f911a40ea3cb24425db197701682f9d0666dac6f591ba7622f4`),
    {
      ok: false,
      reason: 'malformed'
    }
  );
  assert.deepEqual(check(`user=x&${PLAIN}`), { ok: false, reason: 'malformed' });
});

test('SCN-002：auth_date 超過 10 分鐘拒絕，剛好 10 分鐘仍接受', () => {
  assert.deepEqual(check(PLAIN, (AUTH_DATE + 600) * 1000), { ok: true, userId: '424242' });
  assert.deepEqual(check(PLAIN, (AUTH_DATE + 601) * 1000), { ok: false, reason: 'expired' });
});

test('SCN-002：auth_date 在未來超過 60 秒拒絕', () => {
  assert.deepEqual(check(PLAIN, (AUTH_DATE - 60) * 1000), { ok: true, userId: '424242' });
  assert.deepEqual(check(PLAIN, (AUTH_DATE - 61) * 1000), { ok: false, reason: 'future' });
});

test('SCN-002：簽章正確但不是白名單帳號或沒有 user 時拒絕', () => {
  assert.deepEqual(check(OTHER_USER), { ok: false, reason: 'not-allowed' });
  assert.deepEqual(check(NO_USER), { ok: false, reason: 'no-user' });
});

test('SCN-002：Bot token 或白名單空白時一律拒絕，不放行', () => {
  assert.deepEqual(verifyInitData(PLAIN, { botToken: '', allowedUserId: ALLOWED, nowMs: NOW_MS }), {
    ok: false,
    reason: 'not-configured'
  });
  assert.deepEqual(
    verifyInitData(PLAIN, { botToken: BOT_TOKEN, allowedUserId: ' ', nowMs: NOW_MS }),
    { ok: false, reason: 'not-configured' }
  );
});

test('SCN-002：面板憑證換發後可查驗，未知或空白憑證拒絕', () => {
  const sessions = new PanelSessions();
  const token = sessions.issue('424242');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(sessions.verify(token), { userId: '424242' });
  assert.equal(sessions.verify(''), null);
  assert.equal(sessions.verify(`${token}x`), null);
  assert.equal(sessions.verify(new PanelSessions().issue('424242')), null);
  assert.notEqual(sessions.issue('424242'), token);
});

test('SCN-002：入口關閉或換網址（revokeAll）後，舊憑證全部失效，新憑證可用', () => {
  const sessions = new PanelSessions();
  const first = sessions.issue('424242');
  const second = sessions.issue('424242');
  sessions.revokeAll();
  assert.equal(sessions.verify(first), null);
  assert.equal(sessions.verify(second), null);
  const fresh = sessions.issue('424242');
  assert.deepEqual(sessions.verify(fresh), { userId: '424242' });
});
