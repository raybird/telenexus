import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot } from './proc-observer.mjs';

// 2026-10-04：量測後仍保持 PID1 存活，容器退出不是程序回收證據。
setInterval(() => {}, 1000);
const root = mkdtempSync(join(tmpdir(), 'issue10-control-'));
const profile = mkdtempSync(join(root, 'profile-'));
console.log(JSON.stringify({ event: 'profile-present', profiles: readdirSync(root), profile }));
rmSync(profile, { recursive: true });
console.log(JSON.stringify({ event: 'profile-removed', profiles: readdirSync(root) }));
const helperCode = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),1500)'],{detached:true,stdio:'ignore'});console.log(child.pid);child.unref();`;
const helper = spawn(process.execPath, ['-e', helperCode]);
let raw = '';
helper.stdout.on('data', data => { raw += data; });
await new Promise(resolve => helper.on('exit', resolve));
const targetPid = Number(raw.trim());
console.log(JSON.stringify({ event: 'target', targetPid, observerPid: process.pid }));
for (let second = 0; second <= 4; second++) {
  const rows = snapshot();
  console.log(JSON.stringify({ event: 'sample', second, target: rows.find(row => row.pid === targetPid) ?? null, zombieCount: rows.filter(row => row.state === 'Z').length, observerAlive: rows.some(row => row.pid === process.pid) }));
  await new Promise(resolve => setTimeout(resolve, 1000));
}
console.log(JSON.stringify({ event: 'measurement-complete', observerStillAlive: true }));
