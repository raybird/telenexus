import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const syncScript = resolve('scripts/sync-skills.mjs');
const legacySource = resolve('tests/fixtures/legacy-agent-browser');
const backupName = 'agent-browser-04f5f2d';

function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [name, content] of Object.entries(snapshot(path))) result[`${entry.name}/${name}`] = content;
    } else if (entry.isFile()) result[entry.name] = readFileSync(path).toString('base64');
  }
  return result;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'issue10-skills-'));
  const source = join(root, 'source');
  const targets = [join(root, 'workspace', '.opencode', 'skills'), join(root, 'global', 'skills')];
  mkdirSync(source, { recursive: true });
  cpSync(legacySource, join(source, 'agent-browser'), { recursive: true });
  mkdirSync(join(source, 'web-reading'));
  writeFileSync(join(source, 'web-reading', 'SKILL.md'), '---\nname: web-reading\ndescription: 公開網頁閱讀\n---\nHTTP first\n');
  for (const target of targets) {
    mkdirSync(target, { recursive: true });
    mkdirSync(join(target, 'custom'));
    writeFileSync(join(target, 'custom', 'SKILL.md'), '---\nname: custom\ndescription: 客製技能\n---\nUSER CUSTOM\n');
    writeFileSync(join(target, '..', 'auth.json'), '{"auth":"FIXTURE_AUTH"}');
    writeFileSync(join(target, '..', 'opencode.json'), '{"mcp":{"memory":{"command":["memory"]},"custom":{"command":["custom"]}}}');
    writeFileSync(join(target, '..', 'session.fixture'), 'EXISTING_TEXT_SESSION');
  }
  const preserved = targets.map(target => ({ custom: snapshot(join(target, 'custom')), auth: readFileSync(join(target, '..', 'auth.json'), 'utf8'), config: readFileSync(join(target, '..', 'opencode.json'), 'utf8'), session: readFileSync(join(target, '..', 'session.fixture'), 'utf8') }));
  const run = () => {
    const result = spawnSync(process.execPath, [syncScript], { env: { ...process.env, BUILTIN_SKILLS_DIR: source, OPENCODE_SKILLS_DIRS: targets.join(','), APP_PROJECT_DIR: root }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    for (const [index, target] of targets.entries()) {
      assert.deepEqual(snapshot(join(target, 'custom')), preserved[index].custom);
      assert.equal(readFileSync(join(target, '..', 'auth.json'), 'utf8'), preserved[index].auth);
      assert.equal(readFileSync(join(target, '..', 'opencode.json'), 'utf8'), preserved[index].config);
      assert.equal(readFileSync(join(target, '..', 'session.fixture'), 'utf8'), preserved[index].session);
    }
    return result;
  };
  return { root, source, targets, run, close: () => rmSync(root, { recursive: true }) };
}

test('SCN-006 新安裝兩目標不再同步 agent-browser，重跑冪等', () => {
  const f = fixture();
  try {
    f.run();
    f.run();
    for (const target of f.targets) {
      assert.equal(existsSync(join(target, 'agent-browser')), false);
      assert.equal(existsSync(join(target, 'web-reading', 'SKILL.md')), true);
    }
    const index = readFileSync(join(f.targets[0], '..', 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(index, /agent-browser/);
    assert.match(index, /web-reading/);
    assert.match(index, /custom/);
  } finally { f.close(); }
});

test('SCN-006 完全相符舊內建技能兩目標改名備份，索引退役且不覆寫', () => {
  const f = fixture();
  try {
    for (const target of f.targets) cpSync(legacySource, join(target, 'agent-browser'), { recursive: true });
    const original = snapshot(legacySource);
    f.run();
    f.run();
    for (const target of f.targets) {
      assert.equal(existsSync(join(target, 'agent-browser')), false);
      assert.deepEqual(snapshot(join(target, '..', 'retired-skills', backupName)), original);
    }
    assert.doesNotMatch(readFileSync(join(f.targets[0], '..', 'AGENTS.md'), 'utf8'), /agent-browser/);
    assert.doesNotMatch(readFileSync(join(f.root, 'workspace', 'context', 'skills-summary.md'), 'utf8'), /agent-browser/);
  } finally { f.close(); }
});

for (const kind of ['custom-content', 'extra-file', 'prototype-file', 'extra-dir', 'symlink', 'root-symlink', 'backup-collision'] as const) {
  test(`SCN-006 ${kind} 兩目標保留原地、警告且重跑不覆寫`, () => {
    const f = fixture();
    try {
      for (const target of f.targets) {
        const legacy = join(target, 'agent-browser');
        if (kind === 'root-symlink') symlinkSync(join(f.source, 'agent-browser'), legacy, 'dir');
        else cpSync(legacySource, legacy, { recursive: true });
        if (kind === 'custom-content') writeFileSync(join(legacy, 'SKILL.md'), 'USER CUSTOM BROWSER');
        if (kind === 'extra-file') writeFileSync(join(legacy, 'extra.txt'), 'USER EXTRA');
        if (kind === 'prototype-file') writeFileSync(join(legacy, '__proto__'), 'USER PROTOTYPE FILE');
        if (kind === 'extra-dir') mkdirSync(join(legacy, 'empty-extra'));
        if (kind === 'symlink') symlinkSync(join(legacy, 'SKILL.md'), join(legacy, 'extra-link'));
        if (kind === 'backup-collision') {
          mkdirSync(join(target, '..', 'retired-skills', backupName), { recursive: true });
          writeFileSync(join(target, '..', 'retired-skills', backupName, 'USER.txt'), 'KEEP BACKUP');
        }
      }
      const before = f.targets.map(target => snapshot(join(target, 'agent-browser')));
      const first = f.run();
      const second = f.run();
      assert.match(first.stderr, /無法自動遷移|備份已存在/);
      assert.match(first.stderr, /舊.*backend|舊.*後端/);
      assert.match(second.stderr, /無法自動遷移|備份已存在/);
      for (const [index, target] of f.targets.entries()) {
        assert.deepEqual(snapshot(join(target, 'agent-browser')), before[index]);
        if (kind === 'prototype-file') assert.equal(readFileSync(join(target, 'agent-browser', '__proto__'), 'utf8'), 'USER PROTOTYPE FILE');
        if (kind === 'backup-collision') assert.equal(readFileSync(join(target, '..', 'retired-skills', backupName, 'USER.txt'), 'utf8'), 'KEEP BACKUP');
      }
    } finally { f.close(); }
  });
}

for (const kind of ['target-ancestor-symlink', 'backup-ancestor-symlink'] as const) {
  test(`SCN-006 ${kind} 保留兩目標並警告`, () => {
    const f = fixture();
    try {
      for (const [index, target] of f.targets.entries()) {
        cpSync(legacySource, join(target, 'agent-browser'), { recursive: true });
        const actual = join(f.root, `real-${index}`);
        if (kind === 'target-ancestor-symlink') {
          renameSync(join(target, '..'), actual);
          symlinkSync(actual, join(target, '..'), 'dir');
        } else {
          mkdirSync(actual);
          symlinkSync(actual, join(target, '..', 'retired-skills'), 'dir');
        }
      }
      const result = f.run();
      f.run();
      assert.match(result.stderr, /無法自動遷移/);
      for (const target of f.targets) assert.deepEqual(snapshot(join(target, 'agent-browser')), snapshot(legacySource));
    } finally { f.close(); }
  });
}

test('SCN-006 local／runner 同時同步只保留一份完整備份，不殘留 builtin', async () => {
  const f = fixture();
  try {
    for (const target of f.targets) cpSync(legacySource, join(target, 'agent-browser'), { recursive: true });
    const runConcurrent = () => new Promise<void>((resolveExit, reject) => {
      const child = spawn(process.execPath, [syncScript], { env: { ...process.env, BUILTIN_SKILLS_DIR: f.source, OPENCODE_SKILLS_DIRS: f.targets.join(','), APP_PROJECT_DIR: f.root }, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', code => {
        try { assert.equal(code, 0, stderr); resolveExit(); } catch (error) { reject(error); }
      });
    });
    await Promise.all([runConcurrent(), runConcurrent()]);
    f.run();
    for (const target of f.targets) {
      assert.equal(existsSync(join(target, 'agent-browser')), false);
      assert.deepEqual(snapshot(join(target, '..', 'retired-skills', backupName)), snapshot(legacySource));
    }
  } finally { f.close(); }
});
