import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// issue 0025：收成命令以 git 歷史判斷 workspace 的技能是新的、被改過、舊版內建還是已退役。
// fixture 是一個暫存 git repo：skills/ 有兩個版本的歷史，workspace 擺入每一種情況。
const script = resolve('scripts/harvest-skills.mjs');

const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} 測試技能\n---\n${body}\n`;
const V1 = skill('sched', '第一版排程說明');
const V2 = skill('sched', '第二版排程說明，多了 update 指令');
const SAME = skill('same', '與內建相同');
const EDITED = skill('edited', '原本的說明');

function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      result[path.slice(dir.length + 1)] = readFileSync(path, 'utf8');
    }
  }
  return result;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'issue25-harvest-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  write(repo, { 'skills/sched/SKILL.md': V1, 'skills/old-tool/SKILL.md': skill('old-tool', '已退役'), 'workspace/.gitignore': '*\n' });
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'v1');
  const v1 = git(repo, 'rev-parse', '--short', 'HEAD').trim();
  rmSync(join(repo, 'skills/old-tool'), { recursive: true });
  write(repo, { 'skills/sched/SKILL.md': V2, 'skills/same/SKILL.md': SAME, 'skills/edited/SKILL.md': EDITED, 'skills/edited/notes.md': '附註\n' });
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'v2');
  const ws = join(repo, 'workspace/.opencode/skills');
  write(ws, {
    'newskill/SKILL.md': skill('newskill', 'agent 做的'),
    'newskill/scripts/run.sh': 'echo hi\n',
    'sched/SKILL.md': V1,
    'same/SKILL.md': SAME,
    'edited/SKILL.md': skill('edited', 'agent 改過的說明'),
    'edited/notes.md': '附註\n',
    'old-tool/SKILL.md': skill('old-tool', '已退役'),
  });
  mkdirSync(join(root, 'elsewhere'));
  symlinkSync(join(root, 'elsewhere'), join(ws, 'linked'));
  const run = (args: string[] = [], cwd = repo) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
    return { code: result.status, out: result.stdout + result.stderr };
  };
  const status = () => git(repo, 'status', '--porcelain', '--ignored');
  return { root, repo, ws, v1, run, status, close: () => rmSync(root, { recursive: true, force: true }) };
}

/** 輸出裡某個分類段落（標題到下一個空行）。 */
function section(out: string, title: string): string {
  const start = out.indexOf(title);
  assert.ok(start >= 0, `輸出要有「${title}」：\n${out}`);
  const end = out.indexOf('\n\n', start);
  return out.slice(start, end < 0 ? undefined : end);
}

test('SCN-001 列出新技能，附檔案數；結束碼 0，repo 沒有變動', () => {
  const f = fixture();
  try {
    const before = f.status();
    const r = f.run();
    assert.equal(r.code, 0, r.out);
    assert.match(section(r.out, '新技能'), /newskill\s+2 個檔案/);
    assert.equal(f.status(), before);
  } finally { f.close(); }
});

test('SCN-002 被改過的內建技能附差異', () => {
  const f = fixture();
  try {
    const r = f.run();
    const modified = section(r.out, '被改過的內建技能');
    assert.match(modified, /edited/);
    assert.match(modified, /-原本的說明/);
    assert.match(modified, /\+agent 改過的說明/);
    assert.doesNotMatch(section(r.out, '新技能'), /edited/);
  } finally { f.close(); }
});

test('SCN-003 舊版內建技能列在略過，標出相符的版本', () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.match(section(r.out, '略過'), new RegExp(`sched\\s+舊版內建，未被修改（與 ${f.v1} 相同）`));
    assert.doesNotMatch(section(r.out, '被改過的內建技能'), /sched/);
  } finally { f.close(); }
});

for (const [name, reason] of [['linked', 'symlink'], ['same', '與內建相同'], ['old-tool', '已退役內建']] as const) {
  test(`SCN-004 ${name} 列在略過，原因是「${reason}」`, () => {
    const f = fixture();
    try {
      const r = f.run();
      assert.match(section(r.out, '略過'), new RegExp(`${name}\\s+${reason}`));
      assert.doesNotMatch(section(r.out, '新技能'), new RegExp(`\\b${name}\\b`));
    } finally { f.close(); }
  });
}

test('SCN-005 --from 掃描另一個 workspace，比對基準仍是本 repo', () => {
  const f = fixture();
  try {
    const other = join(f.root, 'deploy-workspace');
    write(join(other, '.opencode/skills'), { 'stock-analysis/SKILL.md': skill('stock-analysis', '另一台的技能'), 'sched/SKILL.md': V1 });
    const r = f.run(['--from', other]);
    assert.equal(r.code, 0, r.out);
    assert.match(section(r.out, '新技能'), /stock-analysis\s+1 個檔案/);
    assert.doesNotMatch(r.out, /newskill/, '不再掃 repo 的 workspace');
    assert.match(section(r.out, '略過'), new RegExp(`sched\\s+舊版內建，未被修改（與 ${f.v1} 相同）`));
  } finally { f.close(); }
});

test('SCN-005 --from 指向沒有 .opencode/skills 的路徑：非 0 並說明找不到', () => {
  const f = fixture();
  try {
    const missing = join(f.root, 'empty');
    mkdirSync(missing);
    const r = f.run(['--from', missing]);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /找不到/);
    assert.ok(r.out.includes(join(missing, '.opencode/skills')), r.out);
  } finally { f.close(); }
});

test('不在 git checkout 裡執行：非 0 並說明', () => {
  const f = fixture();
  try {
    const r = f.run([], f.root);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /git/);
  } finally { f.close(); }
});

// ---- promote（SCN-006～009）----

test('SCN-006 promote 新技能：內容相同、提醒先檢查，不 commit、不動 skills/ 以外的檔案', () => {
  const f = fixture();
  try {
    const head = git(f.repo, 'rev-parse', 'HEAD');
    const before = f.status();
    const r = f.run(['--promote', 'newskill']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(snapshot(join(f.repo, 'skills/newskill')), snapshot(join(f.ws, 'newskill')));
    assert.match(r.out, /commit 前請先自己檢查/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), head, '不建立 commit');
    const added = f.status().split('\n').filter((line) => line && !before.split('\n').includes(line));
    assert.deepEqual(added, ['?? skills/newskill/']);
  } finally { f.close(); }
});

const refusals: Array<[string, (f: ReturnType<typeof fixture>) => string, RegExp]> = [
  ['skills/ 已有同名技能', () => 'edited', /已存在.*--force/],
  ['目錄裡沒有 SKILL.md', (f) => { write(f.ws, { 'nodoc/README.md': '沒有 SKILL.md\n' }); return 'nodoc'; }, /沒有 SKILL\.md/],
  ['目錄裡含 symlink', (f) => { write(f.ws, { 'withlink/SKILL.md': skill('withlink', 'x') }); symlinkSync(join(f.root, 'elsewhere'), join(f.ws, 'withlink/data')); return 'withlink'; }, /目錄裡含 symlink/],
  ['技能本身是 symlink', () => 'linked', /是 symlink/],
  ['workspace 沒有這個名稱', () => 'ghost', /沒有這個技能/],
  ['名稱含路徑分隔符號', () => 'newskill/scripts', /不能含路徑/],
  // 名稱檢查是唯一的防線：workspace 外的 outside 是合法技能，沒擋下就會寫到 repo 的 skills/ 之外。
  ['名稱以 .. 指向 workspace 外的技能', (f) => { write(join(f.ws, '..'), { 'outside/SKILL.md': skill('outside', 'x') }); return '../outside'; }, /不能含路徑/],
  ['名稱是 ..', () => '..', /不能含路徑/],
];
for (const [label, prepare, reason] of refusals) {
  test(`SCN-007 promote 拒絕：${label}；非 0、skills/ 不變`, () => {
    const f = fixture();
    try {
      const name = prepare(f);
      const before = snapshot(join(f.repo, 'skills'));
      const r = f.run(['--promote', name]);
      assert.notEqual(r.code, 0, r.out);
      assert.match(r.out, /\[harvest\] /);
      assert.match(r.out, reason, '要說明拒絕的原因');
      assert.deepEqual(snapshot(join(f.repo, 'skills')), before);
      assert.deepEqual(readdirSync(join(f.repo, 'skills')).sort(), ['edited', 'same', 'sched']);
      assert.equal(existsSync(join(f.repo, 'outside')), false, '不能寫到 skills/ 之外');
    } finally { f.close(); }
  });
}

test('SCN-008 --force 覆寫同名內建技能：與 workspace 完全相同，少掉的檔案也移除', () => {
  const f = fixture();
  try {
    rmSync(join(f.ws, 'edited/notes.md'));
    const r = f.run(['--promote', 'edited', '--force']);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(snapshot(join(f.repo, 'skills/edited')), { 'SKILL.md': skill('edited', 'agent 改過的說明') });
    assert.deepEqual(readdirSync(join(f.repo, 'skills')).sort(), ['edited', 'same', 'sched'], '沒有留下暫存目錄');
  } finally { f.close(); }
});

// 假 token：只用來觸發警告的格式，不是真的憑證。
const FAKE_TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
const FAKE_TG_TOKEN = `123456789:${'AbCdEfGhIj'.repeat(3)}AbCdE`;
const warnings: Array<[string, string, string, RegExp]> = [
  ['name 與目錄名不同', 'renamed', skill('other-name', 'x'), /renamed.*other-name|other-name.*renamed/],
  ['疑似 token', 'tokeny', skill('tokeny', `設定\n\nexport GH=${FAKE_TOKEN}`), /SKILL\.md:7/],
  ['本機絕對路徑', 'pathy', skill('pathy', '資料在 /home/someone/data 底下'), /SKILL\.md:5/],
  ['Telegram bot token 寫在 API 網址裡', 'tg', skill('tg', `curl https://api.telegram.org/bot${FAKE_TG_TOKEN}/sendMessage`), /SKILL\.md:5 疑似含 token/],
];
for (const [label, name, content, expected] of warnings) {
  test(`SCN-009 promote 照樣複製但警告：${label}`, () => {
    const f = fixture();
    try {
      write(f.ws, { [`${name}/SKILL.md`]: content });
      const r = f.run(['--promote', name]);
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(snapshot(join(f.repo, 'skills', name)), { 'SKILL.md': content });
      const warning = r.out.split('\n').filter((line) => line.includes('警告')).join('\n');
      assert.match(warning, expected);
      assert.ok(!r.out.includes(FAKE_TOKEN) && !r.out.includes(FAKE_TG_TOKEN), '輸出不能印出疑似 token 本身');
    } finally { f.close(); }
  });
}

test('SCN-009 沒有可疑內容時不警告', () => {
  const f = fixture();
  try {
    const r = f.run(['--promote', 'newskill']);
    assert.doesNotMatch(r.out, /警告/);
  } finally { f.close(); }
});

// 複製到一半失敗時，skills/ 要維持原狀、不留暫存目錄；--force 時舊版仍在。
for (const force of [false, true]) {
  test(`SCN-007 promote${force ? ' --force' : ''} 複製失敗：非 0，skills/ 不變、不留暫存`, () => {
    const f = fixture();
    try {
      const hook = join(f.root, 'fail-copy.mjs');
      writeFileSync(hook, [
        "import fs from 'node:fs';",
        "fs.cpSync = () => { throw Object.assign(new Error('ENOSPC: injected copy failure'), { code: 'ENOSPC' }); };",
      ].join('\n'));
      const name = force ? 'edited' : 'newskill';
      const before = snapshot(join(f.repo, 'skills'));
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, script, '--promote', name, ...(force ? ['--force'] : [])], { cwd: f.repo, encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /ENOSPC/);
      assert.deepEqual(snapshot(join(f.repo, 'skills')), before);
      assert.deepEqual(readdirSync(join(f.repo, 'skills')).sort(), ['edited', 'same', 'sched'], '沒有留下暫存目錄');
    } finally { f.close(); }
  });
}

test('SCN-007 promote --force 換上新版時失敗：舊版移回原處，skills/ 不變', () => {
  const f = fixture();
  try {
    const hook = join(f.root, 'fail-install.mjs');
    // 只讓「暫存目錄 → skills/edited」那次改名失敗；移走舊版的那次照常。
    writeFileSync(hook, [
      "import fs from 'node:fs';",
      'const rename = fs.renameSync;',
      "fs.renameSync = (from, to) => {",
      "  if (String(to).endsWith('/skills/edited') && String(from).includes('.harvest-edited-')) throw Object.assign(new Error('EIO: injected install failure'), { code: 'EIO' });",
      '  return rename(from, to);',
      '};',
    ].join('\n'));
    const before = snapshot(join(f.repo, 'skills'));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, script, '--promote', 'edited', '--force'], { cwd: f.repo, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /EIO/);
    assert.deepEqual(snapshot(join(f.repo, 'skills')), before, '舊版回到原處');
    assert.deepEqual(readdirSync(join(f.repo, 'skills')).sort(), ['edited', 'same', 'sched'], '沒有留下暫存目錄');
  } finally { f.close(); }
});

// 2026-11-12 審查 MUST FIX：git 預設會替含中文或 " 的路徑加引號，比對不能因此漏掉檔案。
function nonAsciiFixture() {
  const f = fixture();
  write(f.repo, { 'skills/股票/SKILL.md': skill('股票', '台股分析'), 'skills/same/說明.md': '附註\n', 'skills/same/say "hi".md': '引號\n' });
  git(f.repo, 'add', '-A');
  git(f.repo, 'commit', '-q', '-m', 'v3');
  const v3 = git(f.repo, 'rev-parse', '--short', 'HEAD').trim();
  write(f.ws, { '股票/SKILL.md': skill('股票', '台股分析'), 'same/說明.md': '附註\n', 'same/say "hi".md': '引號\n' });
  return { ...f, v3 };
}

test('含中文或引號的檔名：內容相同就是與內建相同', () => {
  const f = nonAsciiFixture();
  try {
    const r = f.run();
    assert.match(section(r.out, '略過'), /same\s+與內建相同/);
    assert.doesNotMatch(section(r.out, '被改過的內建技能'), /same/);
  } finally { f.close(); }
});

test('中文技能名：與內建相同，不列成新技能', () => {
  const f = nonAsciiFixture();
  try {
    const r = f.run();
    assert.match(section(r.out, '略過'), /股票\s+與內建相同/);
    assert.doesNotMatch(section(r.out, '新技能'), /股票/);
  } finally { f.close(); }
});

test('含中文檔名的舊版內建：找得到相符的歷史版本', () => {
  const f = nonAsciiFixture();
  try {
    write(f.repo, { 'skills/same/說明.md': '新的附註\n' });
    git(f.repo, 'commit', '-q', '-am', 'v4');
    const r = f.run();
    assert.match(section(r.out, '略過'), new RegExp(`same\\s+舊版內建，未被修改（與 ${f.v3} 相同）`));
  } finally { f.close(); }
});
