// issue 0030 Task 2.2（SCN-006）：/model、/set_model、/reset_model、/models 改用共用模型設定服務。
// 期望值是手寫字面值：實際呼叫用 cwd 下的 ai-config.yaml（DynamicAIAgent 預設 'ai-config.yaml'）
// 加 APP_PROJECT_DIR/data/ai-config.override.yaml，合併規則見 README。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandRouter } from '../src/core/command-router.js';
import { loadAiConfig } from '../src/core/config-loader.js';

function makeStubConnector() {
  const sent: string[] = [];
  return {
    sent,
    connector: {
      name: 'stub',
      initialize: async () => {},
      sendMessage: async (_c: string, text: string) => {
        sent.push(text);
      },
      sendFile: async () => {},
      sendPlaceholder: async () => '',
      editMessage: async () => {},
      onMessage: () => {}
    }
  };
}

function makeMsg(content: string) {
  return {
    id: '1',
    chatId: 'u1',
    content,
    sender: { id: 'u1', name: 'x', platform: 'telegram' as const },
    timestamp: Date.now()
  };
}

type Files = { cwdBase?: string; projectBase?: string; override?: string };

/** cwd 與 APP_PROJECT_DIR 分開，才能看出 ai-config.yaml 讀的是哪一個。 */
async function withProject(
  files: Files,
  fn: (ctx: { send(content: string): Promise<string[]>; overridePath: string }) => Promise<void>
): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-model-'));
  const cwd = path.join(root, 'cwd');
  const project = path.join(root, 'project');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(project, 'data'), { recursive: true });
  if (files.cwdBase !== undefined)
    fs.writeFileSync(path.join(cwd, 'ai-config.yaml'), files.cwdBase);
  if (files.projectBase !== undefined) {
    fs.writeFileSync(path.join(project, 'ai-config.yaml'), files.projectBase);
  }
  const overridePath = path.join(project, 'data', 'ai-config.override.yaml');
  if (files.override !== undefined) fs.writeFileSync(overridePath, files.override);

  const savedCwd = process.cwd();
  const savedDir = process.env.APP_PROJECT_DIR;
  process.chdir(cwd);
  process.env.APP_PROJECT_DIR = project;
  try {
    const router = new CommandRouter();
    await fn({
      overridePath,
      async send(content: string) {
        const { connector, sent } = makeStubConnector();
        await router.handleMessage(makeMsg(content), {
          connector: connector as never,
          memory: {} as never,
          scheduler: {} as never,
          requestNewSession: () => {}
        });
        return sent;
      }
    });
  } finally {
    process.chdir(savedCwd);
    if (savedDir === undefined) delete process.env.APP_PROJECT_DIR;
    else process.env.APP_PROJECT_DIR = savedDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const BASE_REPLY = (m: string) => `🤖 目前使用模型：\`${m}\`（base config）`;
const OVERRIDE_REPLY = (m: string, base: string) =>
  `🤖 目前使用模型：\`${m}\`（override）\n📄 基礎設定：\`${base}\``;

test('SCN-006：/model 在 override 的 model 不是字串時改用 base，不回「無法讀取設定檔」', async () => {
  await withProject({ cwdBase: 'model: mock/a\n', override: 'model: 123\n' }, async ({ send }) => {
    assert.deepEqual(await send('/model'), [BASE_REPLY('mock/a')]);
    assert.equal(loadAiConfig().model, 'mock/a');
  });
});

test('SCN-006：/model 在 ai-config.yaml 壞掉時照樣顯示 override', async () => {
  await withProject(
    { cwdBase: 'model: [oops\n', override: 'model: mock/b\n' },
    async ({ send }) => {
      assert.deepEqual(await send('/model'), [OVERRIDE_REPLY('mock/b', '未設定')]);
      assert.equal(loadAiConfig().model, 'mock/b');
    }
  );
});

test('SCN-006：/model 在 base 的 model 是清單時顯示未設定，不回錯誤', async () => {
  await withProject({ cwdBase: 'model:\n  - mock/a\n' }, async ({ send }) => {
    assert.deepEqual(await send('/model'), [BASE_REPLY('未設定（使用 opencode 預設）')]);
    assert.equal(loadAiConfig().model, undefined);
  });
});

test('SCN-006：/model 讀的 ai-config.yaml 與實際呼叫是同一個', async () => {
  await withProject(
    { cwdBase: 'model: mock/c\n', projectBase: 'model: mock/p\n' },
    async ({ send }) => {
      assert.equal(loadAiConfig().model, 'mock/c');
      assert.deepEqual(await send('/model'), [BASE_REPLY('mock/c')]);
    }
  );
});

test('SCN-006：/model 的一般情況回覆文字不變', async () => {
  await withProject(
    { cwdBase: 'model: mock/a\n', override: 'model: mock/b\n' },
    async ({ send }) => {
      assert.deepEqual(await send('/model'), [OVERRIDE_REPLY('mock/b', 'mock/a')]);
    }
  );
});

// 指令內容的引號與反引號由 handleMessage 先移除（既有行為），所以這裡不測含引號的 ID。
test('SCN-006：/set_model 寫出的檔讓實際呼叫讀回同一個 ID', async () => {
  await withProject({ cwdBase: 'model: mock/a\n' }, async ({ send }) => {
    for (const id of ['[mock]/x', 'mock/x:y']) {
      const reply = await send(`/set_model ${id}`);
      assert.match(reply[0] ?? '', /^✅ 模型已切換/, id);
      assert.equal(loadAiConfig().model, id, id);
      assert.deepEqual(await send('/model'), [OVERRIDE_REPLY(id, 'mock/a')]);
    }
  });
});

test('SCN-006：/set_model 的 ID 含換行或空白時拒絕，設定不變', async () => {
  await withProject(
    { cwdBase: 'model: mock/a\n', override: 'model: mock/b\n' },
    async ({ send, overridePath }) => {
      for (const content of [
        '/set_model mock/x\nmodel: evil',
        '/set_model mock/x y',
        '/set_model noslash'
      ]) {
        const reply = await send(content);
        assert.match(reply[0] ?? '', /^❌ 格式錯誤/, JSON.stringify(content));
      }
      assert.equal(fs.readFileSync(overridePath, 'utf8'), 'model: mock/b\n');
    }
  );
});

test('SCN-006：/set_model 回覆原本的 override，/reset_model 清除後回到 base', async () => {
  await withProject(
    { cwdBase: 'model: mock/a\n', override: 'model: mock/b\n' },
    async ({ send, overridePath }) => {
      assert.deepEqual(await send('/set_model mock/c'), [
        '✅ 模型已切換：`mock/b` → `mock/c`\n下一則訊息生效。'
      ]);
      assert.deepEqual(await send('/reset_model'), [
        '✅ 已清除模型 override（`mock/c`），恢復使用 base config 設定。'
      ]);
      assert.equal(fs.existsSync(overridePath), false);
      assert.equal(loadAiConfig().model, 'mock/a');
      assert.deepEqual(await send('/reset_model'), [
        'ℹ️ 目前沒有 override，已使用 base config 的模型設定。'
      ]);
      assert.deepEqual(await send('/set_model mock/d'), [
        '✅ 模型已切換：（base config） → `mock/d`\n下一則訊息生效。'
      ]);
    }
  );
});

test('/models 改用共用清單後回覆格式不變，provider 篩選照舊（回歸守門）', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-opencode-'));
  const script = path.join(bin, 'opencode');
  fs.writeFileSync(
    script,
    '#!/bin/sh\nif [ "$1" = "models" ] && [ -z "$2" ]; then printf "mock/a\\nother/b\\n"; exit 0; fi\nif [ "$2" = "mock" ]; then printf "mock/a\\n"; exit 0; fi\nexit 0\n'
  );
  fs.chmodSync(script, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
  try {
    await withProject({ cwdBase: 'model: mock/a\n' }, async ({ send }) => {
      assert.deepEqual(await send('/models'), [
        '📋 可用模型列表（共 2 個）\n\n• `mock/a`\n• `other/b`'
      ]);
      assert.deepEqual(await send('/models mock'), [
        '📋 **mock** 模型列表（共 1 個）\n\n• `mock/a`'
      ]);
      assert.deepEqual(await send('/models nope'), ['❌ 找不到 provider「nope」的模型。']);
    });
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
