// 用法：npx tsx corpus-compare.ts {tmp}/corpus-old.json {tmp}/corpus-new.json（兩個檔由 corpus-check.ts 產生，不進 repo）
import { readFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2) as [string, string];
const oldR = JSON.parse(readFileSync(a, 'utf8')); const newR = JSON.parse(readFileSync(b, 'utf8'));
let ac6 = 0, ac6Same = 0, changed = 0;
for (const id of Object.keys(oldR)) {
  if (oldR[id].out !== newR[id].out) changed++;
  if (oldR[id].ac6) { ac6++; if (oldR[id].out === newR[id].out) ac6Same++; }
}
console.log(JSON.stringify({ replies: Object.keys(oldR).length, outputChanged: changed, ac6Replies: ac6, ac6Identical: ac6Same }));
