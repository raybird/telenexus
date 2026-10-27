import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpencodeAgent } from '../src/core/opencode.js';

class ConfigAgent extends OpencodeAgent {
  environment(): NodeJS.ProcessEnv {
    return this.getEnv();
  }
}

const saved: NodeJS.ProcessEnv = {};
const keys = ['PATH', 'APP_PROJECT_DIR', 'OPENCODE_CONFIG_CONTENT', 'BROWSER_CONFIG_CAPTURE'];
let root = '';

before(() => {
  for (const key of keys) saved[key] = process.env[key];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-browser-config-'));
  fs.mkdirSync(path.join(root, 'workspace'));
  fs.writeFileSync(
    path.join(root, 'opencode'),
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.BROWSER_CONFIG_CAPTURE, process.env.OPENCODE_CONFIG_CONTENT || '{}');
console.log(JSON.stringify({type:'text',sessionID:'fixture',part:{text:'CONFIG_CAPTURED'}}));
`,
    { mode: 0o700 }
  );
  process.env.PATH = `${root}${path.delimiter}${saved.PATH ?? ''}`;
  process.env.APP_PROJECT_DIR = root;
  process.env.BROWSER_CONFIG_CAPTURE = path.join(root, 'capture.json');
});

after(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('SCN-002 子程序設定加入固定、工作專屬 browser MCP，不改父程序環境', () => {
  delete process.env.OPENCODE_CONFIG_CONTENT;
  const env = new ConfigAgent().environment();
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? '{}');
  assert.equal(config.mcp?.telenexus_browser?.type, 'local');
  assert.deepEqual(config.mcp.telenexus_browser.command, [
    'setsid',
    'node',
    '/usr/local/lib/telenexus/browser-mcp-launcher.mjs',
    'node',
    '/usr/local/lib/telenexus/browser/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
    '--headless',
    '--isolated',
    '--slim',
    '--no-usage-statistics',
    '--no-performance-crux',
    '--executable-path=/opt/telenexus/chrome/chrome-linux64/chrome',
    '--chrome-arg=--no-sandbox',
    '--chrome-arg=--disable-dev-shm-usage'
  ]);
  assert.equal(config.mcp.telenexus_browser.timeout, 20000);
  assert.equal(process.env.OPENCODE_CONFIG_CONTENT, undefined);
});

test('SCN-006 合併 JSONC inline 設定，保留 provider、memory、自訂 MCP 與工具權限', () => {
  const original = `{
    // 使用者設定，不改持久化檔案。
    "model": "custom/model", "provider": {"custom": {"options": {"apiKey": "fixture-only"}}},
    "mcp": {"memory": {"type": "local", "command": ["memory-fixture"]},
            "custom": {"type": "remote", "url": "https://example.invalid/mcp"}},
    "permission": {"bash": "deny"},
  }`;
  process.env.OPENCODE_CONFIG_CONTENT = original;
  const config = JSON.parse(new ConfigAgent().environment().OPENCODE_CONFIG_CONTENT!);
  assert.equal(config.model, 'custom/model');
  assert.deepEqual(config.provider, { custom: { options: { apiKey: 'fixture-only' } } });
  assert.deepEqual(config.mcp.memory, { type: 'local', command: ['memory-fixture'] });
  assert.deepEqual(config.mcp.custom, { type: 'remote', url: 'https://example.invalid/mcp' });
  assert.deepEqual(config.permission, { bash: 'deny' });
  assert.ok(config.mcp.telenexus_browser);
  assert.equal(process.env.OPENCODE_CONFIG_CONTENT, original);
});

for (const mode of ['non-stream', 'stream'] as const) {
  test(`SCN-002 ${mode} 真 OpencodeAgent 子程序收到 browser 設定`, async () => {
    delete process.env.OPENCODE_CONFIG_CONTENT;
    const agent = new OpencodeAgent();
    const result =
      mode === 'stream'
        ? await agent.streamChat('fixture', { forceNewSession: true }, () => {})
        : await agent.chatStructured('fixture', { forceNewSession: true });
    assert.equal(result.text, 'CONFIG_CAPTURED');
    const config = JSON.parse(fs.readFileSync(process.env.BROWSER_CONFIG_CAPTURE!, 'utf8'));
    assert.equal(config.mcp?.telenexus_browser?.type, 'local');
    assert.equal(config.mcp?.['mcp-memory-libsql']?.enabled, false);
  });
}

test('SCN-006 同名自訂 browser 設定保持原樣，不覆寫或重複註冊', () => {
  const original = '{"mcp":{"telenexus_browser":{"type":"local","command":["custom-browser"]}}}';
  process.env.OPENCODE_CONFIG_CONTENT = original;
  const env = new ConfigAgent().environment();
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  // issue 0022 SCN-003：自訂 browser 時仍停用舊部署的 mcp-memory-libsql，browser 設定不動
  assert.deepEqual(config.mcp.telenexus_browser, { type: 'local', command: ['custom-browser'] });
  assert.deepEqual(Object.keys(config.mcp).sort(), ['mcp-memory-libsql', 'telenexus_browser']);
  assert.equal(config.mcp['mcp-memory-libsql'].enabled, false);
  assert.equal(env.TELENEXUS_BROWSER_AUDIT_FILE, process.env.TELENEXUS_BROWSER_AUDIT_FILE);
  assert.equal(process.env.OPENCODE_CONFIG_CONTENT, original);
});

// issue 0022：舊部署的 workspace/.opencode/opencode.json 還留著 mcp-memory-libsql，升級不會覆蓋它。
// 注入完整的停用條目（只給 enabled 時，沒有舊設定的部署每輪會多一行 ERROR log，見 issue 0022 步驟 1）。
test('issue 0022 SCN-001/002 預設注入完整的 mcp-memory-libsql 停用條目', () => {
  delete process.env.OPENCODE_CONFIG_CONTENT;
  const config = JSON.parse(new ConfigAgent().environment().OPENCODE_CONFIG_CONTENT ?? '{}');
  assert.deepEqual(config.mcp?.['mcp-memory-libsql'], {
    type: 'local',
    command: ['mcp-memory-libsql'],
    enabled: false
  });
  assert.ok(config.mcp.telenexus_browser);
});

test('issue 0022 SCN-003 使用者自訂的 mcp-memory-libsql 原樣保留', () => {
  const entry = {
    type: 'local',
    command: ['npx', '-y', 'mcp-memory-libsql'],
    enabled: true,
    environment: { LIBSQL_URL: 'file:../data/memory.db' }
  };
  const original = JSON.stringify({ mcp: { 'mcp-memory-libsql': entry } });
  process.env.OPENCODE_CONFIG_CONTENT = original;
  const config = JSON.parse(new ConfigAgent().environment().OPENCODE_CONFIG_CONTENT!);
  assert.deepEqual(config.mcp['mcp-memory-libsql'], entry);
  assert.ok(config.mcp.telenexus_browser);
  assert.equal(process.env.OPENCODE_CONFIG_CONTENT, original);
});

test('無效 inline 設定如實失敗，不靜默丟失原設定或印出內容', () => {
  for (const original of ['{"secret":"fixture-only",', '[]', 'null', '{"mcp":[]}']) {
    process.env.OPENCODE_CONFIG_CONTENT = original;
    assert.throws(() => new ConfigAgent().environment(), /必須是/);
    assert.equal(process.env.OPENCODE_CONFIG_CONTENT, original);
  }
});
