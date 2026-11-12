// issue 0024 步驟 6：在 runner 容器內每 100ms 掃一次 /proc 與 /tmp，狀態有變才寫一列。
// 記錄 wrapper、moli、Chrome、chrome-devtools-mcp 程序，任何 zombie，以及 /tmp 下的
// tnm-*（wrapper）、moli-storage-*、tnb-*（Chrome profile）。收到 SIGTERM 時寫最後一列後結束。
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';

const out = process.argv[2];
const self = String(process.pid);
const kindOf = (comm, cmd) => {
  // full 模式的提示詞放在 opencode 的 argv，裡面的技能索引也有 telenexus-moli-fetch 字樣，所以排除 opencode 本身。
  // wrapper 的 comm 是 bash（shebang 交給 bash 執行），只能看 cmdline。
  if (comm !== 'opencode' && cmd.includes('telenexus-moli-fetch')) return 'wrapper';
  if (comm === 'moli' || cmd.includes('/opt/telenexus/moli/')) return 'moli';
  if (cmd.includes('chrome-devtools-mcp')) return 'mcp';
  if (cmd.includes('/opt/telenexus/chrome/')) return 'chrome';
  return null;
};
function sample() {
  const procs = [];
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid) || pid === self) continue;
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      const [state, ppid] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
      const kind = state === 'Z' ? 'zombie' : kindOf(comm, cmd);
      if (kind) procs.push({ pid: +pid, ppid: +ppid, kind, state, comm });
    } catch { /* 程序在讀取途中結束 */ }
  }
  const tmp = readdirSync('/tmp').filter((n) => /^(tnm-|moli-storage-|tnb-)/.test(n)).sort();
  return { procs: procs.sort((a, b) => a.pid - b.pid), tmp };
}
let last = '';
const tick = (final = false) => {
  const s = sample();
  const key = JSON.stringify(s);
  if (key !== last || final) { appendFileSync(out, JSON.stringify({ t: Date.now(), final, ...s }) + '\n'); last = key; }
};
tick();
const timer = setInterval(tick, 100);
process.on('SIGTERM', () => { clearInterval(timer); tick(true); process.exit(0); });
