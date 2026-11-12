import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

// issue 0024 SCN-008：現有部署的 workspace 已經有 web-reading，sync-skills 只補缺少的目錄，
// 所以要靠雜湊比對把「沒被改過的已出貨舊版」換成新版。
// 舊版 fixture 是 718cc8b 的 skills/web-reading/SKILL.md 原檔（sha256 03821d8d…，與維護者正式部署的副本相同）。
const syncScript = resolve('scripts/sync-skills.mjs');
const legacySource = resolve('tests/fixtures/legacy-web-reading');
const backupName = 'web-reading-718cc8b';
const NEW_SKILL = '---\nname: web-reading\ndescription: 公開網頁閱讀\n---\nNEW GUIDANCE WITH MOLI\n';

function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(snapshot(path))) result[`${entry.name}/${name}`] = content;
    } else if (entry.isFile()) result[entry.name] = readFileSync(path, 'utf8');
  }
  return result;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'issue24-skills-'));
  const source = join(root, 'source');
  const targets = [join(root, 'workspace', '.opencode', 'skills'), join(root, 'global', 'skills')];
  mkdirSync(join(source, 'web-reading'), { recursive: true });
  writeFileSync(join(source, 'web-reading', 'SKILL.md'), NEW_SKILL);
  for (const target of targets) mkdirSync(target, { recursive: true });
  const env = { ...process.env, BUILTIN_SKILLS_DIR: source, OPENCODE_SKILLS_DIRS: targets.join(','), APP_PROJECT_DIR: root };
  const run = () => {
    const result = spawnSync(process.execPath, [syncScript], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const runAsync = () => new Promise<{ code: number | null; output: string }>((resolveRun) => {
    const child = spawn(process.execPath, [syncScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (code) => resolveRun({ code, output }));
  });
  const backup = (target: string) => join(target, '..', 'retired-skills', backupName);
  return { root, source, targets, run, runAsync, backup, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('SCN-008 沒有 web-reading：複製新版，重跑不變', () => {
  const f = fixture();
  try {
    f.run();
    f.run();
    for (const target of f.targets) {
      assert.deepEqual(snapshot(join(target, 'web-reading')), { 'SKILL.md': NEW_SKILL });
      assert.equal(existsSync(f.backup(target)), false);
    }
  } finally { f.close(); }
});

test('SCN-008 與已出貨舊版雜湊相同：換成新版，舊版備份到 retired-skills，重跑不變', () => {
  const f = fixture();
  try {
    for (const target of f.targets) cpSync(legacySource, join(target, 'web-reading'), { recursive: true });
    const legacy = snapshot(legacySource);
    const first = f.run();
    assert.match(first.stdout + first.stderr, /web-reading/);
    f.run();
    for (const target of f.targets) {
      assert.deepEqual(snapshot(join(target, 'web-reading')), { 'SKILL.md': NEW_SKILL });
      assert.deepEqual(snapshot(f.backup(target)), legacy);
    }
    const index = readFileSync(join(f.targets[0]!, '..', 'AGENTS.md'), 'utf8');
    assert.match(index, /web-reading/);
  } finally { f.close(); }
});

const CUSTOMIZED: Array<[string, (dir: string) => void]> = [
  ['SKILL.md 被改過', (dir) => { writeFileSync(join(dir, 'SKILL.md'), readFileSync(join(dir, 'SKILL.md'), 'utf8') + '\nUSER NOTE\n'); }],
  ['多了檔案', (dir) => { writeFileSync(join(dir, 'notes.md'), 'USER FILE\n'); }],
  ['多了目錄', (dir) => { mkdirSync(join(dir, 'references')); }],
];

for (const [name, customize] of CUSTOMIZED) {
  test(`SCN-008 有客製內容（${name}）：原地保留並警告，重跑不變`, () => {
    const f = fixture();
    try {
      for (const target of f.targets) {
        cpSync(legacySource, join(target, 'web-reading'), { recursive: true });
        customize(join(target, 'web-reading'));
      }
      const before = f.targets.map((target) => snapshot(join(target, 'web-reading')));
      const first = f.run();
      assert.match(first.stderr, /web-reading/);
      f.run();
      for (const [i, target] of f.targets.entries()) {
        assert.deepEqual(snapshot(join(target, 'web-reading')), before[i]);
        assert.equal(existsSync(f.backup(target)), false);
      }
    } finally { f.close(); }
  });
}

test('SCN-008 web-reading 是指向舊版的 symlink：不跟著連結改動，原地保留並警告', () => {
  const f = fixture();
  try {
    const outside = join(f.root, 'outside-web-reading');
    cpSync(legacySource, outside, { recursive: true });
    for (const target of f.targets) symlinkSync(outside, join(target, 'web-reading'));
    const first = f.run();
    assert.match(first.stderr, /web-reading/);
    assert.deepEqual(snapshot(outside), snapshot(legacySource));
    for (const target of f.targets) assert.equal(existsSync(f.backup(target)), false);
  } finally { f.close(); }
});

test('SCN-008 備份已存在而 workspace 仍是舊版：不覆寫備份，保留並警告', () => {
  const f = fixture();
  try {
    for (const target of f.targets) {
      cpSync(legacySource, join(target, 'web-reading'), { recursive: true });
      mkdirSync(f.backup(target), { recursive: true });
      writeFileSync(join(f.backup(target), 'SKILL.md'), 'EARLIER BACKUP\n');
    }
    const first = f.run();
    assert.match(first.stderr, /web-reading/);
    for (const target of f.targets) {
      assert.deepEqual(snapshot(join(target, 'web-reading')), snapshot(legacySource));
      assert.deepEqual(snapshot(f.backup(target)), { 'SKILL.md': 'EARLIER BACKUP\n' });
    }
  } finally { f.close(); }
});

test('SCN-008 已經是新版：不變，不建立備份', () => {
  const f = fixture();
  try {
    for (const target of f.targets) cpSync(join(f.source, 'web-reading'), join(target, 'web-reading'), { recursive: true });
    const result = f.run();
    assert.doesNotMatch(result.stderr, /web-reading/);
    for (const target of f.targets) {
      assert.deepEqual(snapshot(join(target, 'web-reading')), { 'SKILL.md': NEW_SKILL });
      assert.equal(existsSync(f.backup(target)), false);
    }
  } finally { f.close(); }
});

test('SCN-008 telenexus 與 agent-runner 同時同步：只有一份備份、結果是新版', async () => {
  for (let round = 0; round < 5; round += 1) {
    const f = fixture();
    try {
      for (const target of f.targets) cpSync(legacySource, join(target, 'web-reading'), { recursive: true });
      const results = await Promise.all([f.runAsync(), f.runAsync()]);
      for (const r of results) assert.equal(r.code, 0, r.output);
      for (const target of f.targets) {
        assert.deepEqual(snapshot(join(target, 'web-reading')), { 'SKILL.md': NEW_SKILL });
        assert.deepEqual(snapshot(f.backup(target)), snapshot(legacySource));
        assert.deepEqual(readdirSync(join(target, '..', 'retired-skills')), [backupName]);
      }
    } finally { f.close(); }
  }
});

// 2026-11-12 審查 S1：web-reading 的升級不能讓其他技能的同步中止。
test('S1 來源沒有 web-reading：其他技能照常同步，不中止', () => {
  const f = fixture();
  try {
    rmSync(join(f.source, 'web-reading'), { recursive: true, force: true });
    mkdirSync(join(f.source, 'scheduler'), { recursive: true });
    writeFileSync(join(f.source, 'scheduler', 'SKILL.md'), '---\nname: scheduler\ndescription: x\n---\n');
    const result = f.run();
    assert.doesNotMatch(result.stdout + result.stderr, /\[SkillSync\] Failed/);
    assert.doesNotMatch(result.stdout + result.stderr, /web-reading 未升級/, '沒有新版可換不是錯誤');
    for (const target of f.targets) assert.ok(existsSync(join(target, 'scheduler', 'SKILL.md')), `${target} 要有 scheduler`);
  } finally { f.close(); }
});

test('S1 內建技能來源目錄不存在：照舊只說明找不到來源，不中止', () => {
  const f = fixture();
  try {
    rmSync(f.source, { recursive: true, force: true });
    const result = f.run();
    assert.doesNotMatch(result.stdout + result.stderr, /\[SkillSync\] Failed/);
    assert.doesNotMatch(result.stdout + result.stderr, /web-reading 未升級/, '沒有新版可換不是錯誤');
    assert.match(result.stdout, /Builtin skills source not found/);
  } finally { f.close(); }
});

test('S1 升級時備份失敗：警告並保留舊版，其他技能照常同步', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.source, 'scheduler'), { recursive: true });
    writeFileSync(join(f.source, 'scheduler', 'SKILL.md'), '---\nname: scheduler\ndescription: x\n---\n');
    const target = f.targets[0]!;
    cpSync(legacySource, join(target, 'web-reading'), { recursive: true });
    // retired-skills 是一般檔案，建立備份目錄會失敗。
    writeFileSync(join(target, '..', 'retired-skills'), 'not a directory');
    const result = f.run();
    assert.doesNotMatch(result.stdout + result.stderr, /\[SkillSync\] Failed/);
    assert.match(result.stdout + result.stderr, /web-reading 未升級，保留原本的版本/);
    assert.deepEqual(snapshot(join(target, 'web-reading')), snapshot(legacySource), '舊版原地保留');
    for (const t of f.targets) assert.ok(existsSync(join(t, 'scheduler', 'SKILL.md')), `${t} 要有 scheduler`);
  } finally { f.close(); }
});

// 2026-11-12 第三次審查 S-C：新版複製失敗時，舊版要回到原處，下次啟動仍能升級。
// 新版要大於 ulimit 允許的 2048 bytes，複製才會寫到一半失敗。
const BIG_SKILL = `${NEW_SKILL}${'網頁閱讀指引。'.repeat(400)}\n`;

function legacyFixture() {
  const f = fixture();
  writeFileSync(join(f.source, 'web-reading', 'SKILL.md'), BIG_SKILL);
  const target = f.targets[0]!;
  cpSync(legacySource, join(target, 'web-reading'), { recursive: true });
  const env = { ...process.env, BUILTIN_SKILLS_DIR: f.source, OPENCODE_SKILLS_DIRS: target, APP_PROJECT_DIR: f.root };
  const spawnWith = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout + result.stderr;
  };
  const retired = join(target, '..', 'retired-skills');
  const leftovers = () => (existsSync(retired) ? readdirSync(retired).filter((name) => name !== backupName) : []);
  return { ...f, target, spawnWith, retired, leftovers };
}

test('S-C 新版寫到一半失敗：舊版回到原處、不留暫存，下次啟動照常升級', () => {
  const f = legacyFixture();
  try {
    const output = f.spawnWith('bash', ['-c', 'ulimit -f 2; exec "$0" "$1"', process.execPath, syncScript]);
    assert.match(output, /web-reading 未升級，保留原本的版本/);
    assert.deepEqual(snapshot(join(f.target, 'web-reading')), snapshot(legacySource), '舊版完整回到原處');
    assert.equal(existsSync(f.backup(f.target)), false, '沒有留下備份，下次才能重新升級');
    assert.deepEqual(f.leftovers(), [], '沒有留下暫存目錄');
    f.spawnWith(process.execPath, [syncScript]);
    assert.deepEqual(snapshot(join(f.target, 'web-reading')), { 'SKILL.md': BIG_SKILL });
    assert.deepEqual(snapshot(f.backup(f.target)), snapshot(legacySource));
  } finally { f.close(); }
});

test('S-C 舊版已備份、換上新版時失敗：舊版移回原處，不留暫存', () => {
  const f = legacyFixture();
  try {
    // 新版換到原處的那次改名失敗；其他改名照常。
    const hook = join(f.root, 'fail-install-rename.mjs');
    writeFileSync(hook, [
      "import fs from 'node:fs';",
      'const rename = fs.renameSync;',
      "fs.renameSync = (from, to) => {",
      "  if (String(to).endsWith('/skills/web-reading') && !String(from).endsWith('web-reading-718cc8b')) {",
      "    throw Object.assign(new Error('EIO: injected install failure'), { code: 'EIO' });",
      '  }',
      '  return rename(from, to);',
      '};',
    ].join('\n'));
    const output = f.spawnWith(process.execPath, ['--import', pathToFileURL(hook).href, syncScript]);
    assert.match(output, /web-reading 未升級，保留原本的版本.*EIO/);
    assert.deepEqual(snapshot(join(f.target, 'web-reading')), snapshot(legacySource), '舊版回到原處');
    assert.equal(existsSync(f.backup(f.target)), false);
    assert.deepEqual(f.leftovers(), [], '沒有留下暫存目錄');
  } finally { f.close(); }
});
