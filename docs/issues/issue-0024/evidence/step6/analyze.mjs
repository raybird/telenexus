// issue 0024 步驟 6：每個情境彙整回覆、工具呼叫順序、fixture 讀取者、程序與暫存檔觀測。
// 用法：node analyze.mjs <輸出目錄> <情境...>
import { existsSync, readFileSync } from 'node:fs';
const [out, ...cases] = process.argv.slice(2);
const read = (f) => readFileSync(`${out}/${f}`, 'utf8');
const jsonl = (f) => read(f).trim().split('\n').filter(Boolean).map(JSON.parse);
const TOKENS = { s1: 'ISSUE24_S1_HTTP_BODY_20261112', s2: 'ISSUE24_S2_JS_BODY_20261112', s3a: 'ISSUE24_S3A_JS_BODY_20261112', s3b: 'ISSUE24_S3B_JS_BODY_20261112', s3c: 'ISSUE24_S3C_JS_BODY_20261112', s3d: 'ISSUE24_S3D_JS_BODY_20261112', s5: 'ISSUE24_S5_JS_BODY_20261112' };
const fixture = jsonl('fixture-requests.jsonl');

function toolCalls(c) {
  if (!existsSync(`${out}/${c}-session.json`)) return null;
  let raw = read(`${c}-session.json`);
  raw = raw.slice(raw.indexOf('{'));
  const calls = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (v.type === 'tool' && v.tool) {
      const input = v.state?.input ?? {};
      const output = String(v.state?.output ?? v.state?.error ?? '');
      calls.push({ tool: v.tool, status: v.state?.status, input: input.command ?? input.url ?? input.name ?? input.function ?? JSON.stringify(input).slice(0, 160), output: output.replace(/\s+/g, ' ').slice(0, 200) });
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  walk(JSON.parse(raw));
  return calls;
}

for (const c of cases) {
  const client = JSON.parse(read(`${c}-client.json`));
  const reply = client.body?.output ?? '';
  const end = client.ended;
  const proc = jsonl(`${c}-proc.jsonl`);
  // 2026-11-12 第二輪：當時的採樣器把 argv 帶 full 提示詞的 opencode 也判成 wrapper，這裡排除。
  for (const r of proc) r.procs = r.procs.filter((p) => p.kind !== 'wrapper' || p.comm !== 'opencode');
  const seen = (kind) => proc.find((r) => r.procs.some((p) => p.kind === kind))?.t ?? null;
  const wrapperStart = seen('wrapper');
  // 檢查點：wrapper 啟動後 45 秒；沒啟動 wrapper 時用回合結束後 15 秒（issue 0010 的收尾標準）。
  const checkAt = wrapperStart ? wrapperStart + 45000 : end + 15000;
  const at = proc.filter((r) => r.t <= checkAt).at(-1);
  // 採樣器只在狀態改變時寫一列，所以「清乾淨的時間」是最後一個忙碌列之後的下一列。
  const busy = (r) => r.procs.some((p) => ['wrapper', 'moli', 'zombie'].includes(p.kind)) || r.tmp.some((n) => /^(tnm-|moli-storage-)/.test(n));
  const lastBusyIndex = proc.findLastIndex(busy);
  const clearedAt = lastBusyIndex >= 0 ? proc[lastBusyIndex + 1]?.t ?? null : null;
  // SCN-005 只看 Moli 這一側（wrapper、moli、tnm-*、moli-storage-*）；Chrome 的 zombie 與 profile 屬於 issue 0010 的收尾。
  const moliBusy = (r) => r.procs.some((p) => ['wrapper', 'moli'].includes(p.kind)) || r.tmp.some((n) => /^(tnm-|moli-storage-)/.test(n));
  const moliLastIndex = proc.findLastIndex(moliBusy);
  const moliClearedAt = moliLastIndex >= 0 ? proc[moliLastIndex + 1]?.t ?? null : null;
  const reqs = fixture.filter((r) => r.path.startsWith(`/${c}/`) && r.t >= client.started && r.t <= end + 45000);
  const order = [];
  for (const r of reqs) { const k = `${r.client}:${r.path.split('/')[2]}`; if (order.at(-1) !== k) order.push(k); }
  const otherUAs = [...new Set(reqs.filter((r) => r.client === 'other').map((r) => r.ua))];
  console.log(JSON.stringify({
    case: c,
    ok: client.body?.ok, structuredFailure: client.body?.structured?.failure ?? null, error: client.error ?? client.body?.error ?? null,
    durationS: Math.round((end - client.started) / 1000),
    replyHasToken: TOKENS[c] ? reply.includes(TOKENS[c]) : null,
    replyHasUrl: reply.includes(`/${c}/page`),
    reply: reply.replace(/\s+/g, ' ').slice(0, 400),
    tools: toolCalls(c),
    fixtureOrder: order, otherUAs,
    wrapperSeen: wrapperStart ? Math.round((wrapperStart - client.started) / 1000) : null,
    chromeSeen: seen('chrome') ? Math.round((seen('chrome') - client.started) / 1000) : null,
    cancel: client.mode === 'cancel' ? { wrapperSeenAt: client.wrapperSeenAt && Math.round((client.wrapperSeenAt - client.started) / 1000), abortedAt: client.abortedAt && Math.round((client.abortedAt - client.started) / 1000) } : null,
    moliClearedAfterWrapperS: wrapperStart && moliClearedAt ? +((moliClearedAt - wrapperStart) / 1000).toFixed(1) : null,
    clearedAfterWrapperS: wrapperStart && clearedAt ? +((clearedAt - wrapperStart) / 1000).toFixed(1) : null,
    atCheckpoint: at ? { procs: at.procs.map((p) => `${p.kind}:${p.state}`), tmp: at.tmp } : null,
    finalRow: proc.at(-1)?.final ? { procs: proc.at(-1).procs.map((p) => `${p.kind}:${p.state}`), tmp: proc.at(-1).tmp } : 'no-final-row',
  }, null, 1));
}
