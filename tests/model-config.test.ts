// issue 0030 Task 2.1（SCN-004 責任，SCN-003 支援）：共用模型設定服務。
// 有效模型的期望值是手寫字面值（依 README 的合併規則：override 的 model 是非空字串就用它，否則用 base），
// 不拿 loadAiConfig() 當對照，因為 loadAiConfig() 現在就建立在同一套合併上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadAiConfig } from '../src/core/config-loader.js';
import { applyModel, listModels, readModelState, resetModel } from '../src/core/model-config.js';

type Project = { dir: string; basePath: string; overridePath: string; cleanup(): void };

function makeProject(files: { base?: string; override?: string }): Project {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-'));
  const basePath = path.join(dir, 'ai-config.yaml');
  const overridePath = path.join(dir, 'data', 'ai-config.override.yaml');
  fs.mkdirSync(path.dirname(overridePath));
  if (files.base !== undefined) fs.writeFileSync(basePath, files.base);
  if (files.override !== undefined) fs.writeFileSync(overridePath, files.override);
  const saved = process.env.APP_PROJECT_DIR;
  process.env.APP_PROJECT_DIR = dir;
  return {
    dir,
    basePath,
    overridePath,
    cleanup() {
      if (saved === undefined) delete process.env.APP_PROJECT_DIR;
      else process.env.APP_PROJECT_DIR = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function inProject(
  files: { base?: string; override?: string },
  fn: (p: Project) => void | Promise<void>
) {
  return async () => {
    const project = makeProject(files);
    try {
      await fn(project);
    } finally {
      project.cleanup();
    }
  };
}

const STATE_CASES: Array<{
  name: string;
  base?: string;
  override?: string;
  expected: ReturnType<typeof readModelState>;
}> = [
  {
    name: 'override 有值時以 override 為準',
    base: 'model: mock/a\n',
    override: 'model: mock/b\n',
    expected: { model: 'mock/b', source: 'override', baseModel: 'mock/a', overrideModel: 'mock/b' }
  },
  {
    name: '沒有 override 檔時用 base',
    base: 'model: mock/a\n',
    expected: { model: 'mock/a', source: 'base', baseModel: 'mock/a' }
  },
  {
    name: 'override 的 model 空白時用 base',
    base: 'model: mock/a\n',
    override: 'model: "  "\n',
    expected: { model: 'mock/a', source: 'base', baseModel: 'mock/a' }
  },
  {
    name: 'override 的 model 不是字串時用 base',
    base: 'model: mock/a\n',
    override: 'model: 123\n',
    expected: { model: 'mock/a', source: 'base', baseModel: 'mock/a' }
  },
  {
    name: 'override 的 YAML 壞掉時用 base',
    base: 'model: mock/a\n',
    override: 'model: [unclosed\n',
    expected: { model: 'mock/a', source: 'base', baseModel: 'mock/a' }
  },
  {
    name: 'base 的 model 不是字串時用 override',
    base: 'model:\n  - mock/a\n',
    override: 'model: mock/b\n',
    expected: { model: 'mock/b', source: 'override', overrideModel: 'mock/b' }
  },
  {
    name: '沒有 ai-config.yaml 時用 override',
    override: 'model: mock/b\n',
    expected: { model: 'mock/b', source: 'override', overrideModel: 'mock/b' }
  },
  {
    name: '兩個檔都沒有 model',
    base: 'provider: opencode\n',
    expected: { source: 'none' }
  },
  {
    name: '引號與前後空白會去掉',
    base: "model: '  mock/a  '\n",
    override: 'model: " mock/b "\n',
    expected: { model: 'mock/b', source: 'override', baseModel: 'mock/a', overrideModel: 'mock/b' }
  }
];

for (const c of STATE_CASES) {
  test(
    `SCN-004／SCN-006：有效模型與來源——${c.name}`,
    inProject(c, ({ basePath }) => {
      assert.deepEqual(readModelState({ basePath }), c.expected);
      // 實際呼叫讀到的模型和顯示的相同
      assert.equal(loadAiConfig({ basePath }).model, c.expected.model);
    })
  );
}

test(
  'SCN-004：套用後新呼叫讀到選定模型，回傳原本的 override',
  inProject({ base: 'model: mock/a\n', override: 'model: mock/b\n' }, ({ basePath }) => {
    assert.deepEqual(applyModel('nvidia/deepseek-ai/deepseek-v4-flash'), {
      ok: true,
      previous: 'mock/b'
    });
    assert.equal(loadAiConfig({ basePath }).model, 'nvidia/deepseek-ai/deepseek-v4-flash');
    assert.deepEqual(readModelState({ basePath }), {
      model: 'nvidia/deepseek-ai/deepseek-v4-flash',
      source: 'override',
      baseModel: 'mock/a',
      overrideModel: 'nvidia/deepseek-ai/deepseek-v4-flash'
    });
  })
);

test(
  'SCN-004：YAML 特殊字元的模型 ID 寫入後原樣讀回',
  inProject({ base: 'model: mock/a\n' }, ({ basePath }) => {
    for (const id of ['mock/a:b', 'mock/#hash', "mock/it's", 'mock/[x]']) {
      assert.equal(applyModel(id).ok, true, id);
      assert.equal(loadAiConfig({ basePath }).model, id);
    }
  })
);

test(
  'SCN-004：data 目錄不存在時會建立',
  inProject({ base: 'model: mock/a\n' }, ({ basePath, overridePath }) => {
    fs.rmSync(path.dirname(overridePath), { recursive: true });
    assert.equal(applyModel('mock/c').ok, true);
    assert.equal(loadAiConfig({ basePath }).model, 'mock/c');
  })
);

test(
  'SCN-004：無效的模型 ID 被拒，原設定不變',
  inProject({ base: 'model: mock/a\n', override: 'model: mock/b\n' }, ({ overridePath }) => {
    const before = fs.readFileSync(overridePath, 'utf8');
    for (const id of [
      '',
      '   ',
      'no-slash',
      'mock/a b',
      'mock/a\nmodel: evil',
      '/leading',
      'trailing/',
      'mock/\u0000x'
    ]) {
      assert.deepEqual(applyModel(id), { ok: false, error: 'invalid-model' }, JSON.stringify(id));
    }
    assert.equal(fs.readFileSync(overridePath, 'utf8'), before);
  })
);

test(
  'SCN-004：指定可用清單時，不在清單內的 ID 被拒',
  inProject({ base: 'model: mock/a\n', override: 'model: mock/b\n' }, ({ overridePath }) => {
    const before = fs.readFileSync(overridePath, 'utf8');
    assert.deepEqual(applyModel('mock/x', { available: ['mock/a', 'mock/b'] }), {
      ok: false,
      error: 'not-listed'
    });
    assert.equal(fs.readFileSync(overridePath, 'utf8'), before);
    assert.equal(applyModel('mock/a', { available: ['mock/a', 'mock/b'] }).ok, true);
  })
);

test(
  'SCN-004：寫入中途失敗時保留舊檔，不留下暫存檔',
  inProject(
    { base: 'model: mock/a\n', override: 'model: mock/b\n' },
    ({ basePath, overridePath }) => {
      const before = fs.readFileSync(overridePath, 'utf8');
      const result = applyModel('mock/c', {
        renameSync: () => {
          throw new Error('EIO: simulated');
        }
      });
      assert.equal(result.ok, false);
      assert.equal(result.ok === false && result.error, 'write-failed');
      assert.equal(fs.readFileSync(overridePath, 'utf8'), before);
      assert.deepEqual(fs.readdirSync(path.dirname(overridePath)), ['ai-config.override.yaml']);
      assert.equal(loadAiConfig({ basePath }).model, 'mock/b');
    }
  )
);

test(
  'SCN-004：暫存檔寫不進去（目錄唯讀）時保留舊檔',
  inProject({ base: 'model: mock/a\n', override: 'model: mock/b\n' }, ({ overridePath }) => {
    const dataDir = path.dirname(overridePath);
    fs.chmodSync(dataDir, 0o555);
    try {
      const result = applyModel('mock/c');
      // root 執行時 chmod 擋不住寫入，這支測試就沒有意義
      if (process.getuid?.() === 0) return;
      assert.equal(result.ok, false);
      assert.equal(fs.readFileSync(overridePath, 'utf8'), 'model: mock/b\n');
    } finally {
      fs.chmodSync(dataDir, 0o755);
    }
  })
);

test(
  'SCN-004：恢復預設清除 override，新呼叫回到 base',
  inProject(
    { base: 'model: mock/a\n', override: 'model: mock/b\n' },
    ({ basePath, overridePath }) => {
      assert.deepEqual(resetModel(), { ok: true, changed: true, previous: 'mock/b' });
      assert.equal(fs.existsSync(overridePath), false);
      assert.equal(loadAiConfig({ basePath }).model, 'mock/a');
      assert.deepEqual(resetModel(), { ok: true, changed: false });
    }
  )
);

test(
  'SCN-004：服務不快取有效模型，外部改檔後下一次讀取就看到',
  inProject({ base: 'model: mock/a\n' }, ({ basePath, overridePath }) => {
    assert.equal(readModelState({ basePath }).model, 'mock/a');
    fs.writeFileSync(overridePath, 'model: mock/z\n');
    assert.equal(readModelState({ basePath }).model, 'mock/z');
    fs.writeFileSync(basePath, 'model: mock/y\n');
    fs.rmSync(overridePath);
    assert.equal(readModelState({ basePath }).model, 'mock/y');
  })
);

test('SCN-003：模型清單解析 provider，略過空行與不是模型 ID 的行', async () => {
  const result = await listModels({
    run: async () =>
      'nvidia/deepseek-ai/deepseek-v4-flash\n\nopencode/big-pickle\nWARN something happened\nopencode/gpt-5-nano\n'
  });
  assert.deepEqual(result, {
    ok: true,
    models: [
      { id: 'nvidia/deepseek-ai/deepseek-v4-flash', provider: 'nvidia' },
      { id: 'opencode/big-pickle', provider: 'opencode' },
      { id: 'opencode/gpt-5-nano', provider: 'opencode' }
    ]
  });
});

test('SCN-003：清單為空與命令失敗是可區分的結果', async () => {
  assert.deepEqual(await listModels({ run: async () => '\n' }), { ok: true, models: [] });
  const failed = await listModels({
    run: async () => {
      throw new Error('spawn opencode ENOENT');
    }
  });
  assert.equal(failed.ok, false);
  assert.match(failed.ok === false ? failed.error : '', /ENOENT/);
});

test('SCN-003：沒有注入時實際執行 opencode models（以 PATH 上的假執行檔驗證）', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-opencode-'));
  const script = path.join(bin, 'opencode');
  fs.writeFileSync(
    script,
    '#!/bin/sh\nif [ "$1" = "models" ]; then printf "mock/a\\nother/b\\n"; exit 0; fi\nexit 2\n'
  );
  fs.chmodSync(script, 0o755);
  const savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ''}`;
  try {
    assert.deepEqual(await listModels(), {
      ok: true,
      models: [
        { id: 'mock/a', provider: 'mock' },
        { id: 'other/b', provider: 'other' }
      ]
    });
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});
