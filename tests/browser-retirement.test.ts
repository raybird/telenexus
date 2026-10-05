import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpencodeAgent } from '../src/core/opencode.js';

class RetirementAgent extends OpencodeAgent {
  finish(): Promise<void> {
    return this.onRunFinished({ fromScheduler: true });
  }
}

test('SCN-006 排程收尾不再呼叫舊全域 browser close', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-retire-'));
  const savedPath = process.env.PATH;
  const savedProject = process.env.APP_PROJECT_DIR;
  const marker = path.join(root, 'called');
  fs.mkdirSync(path.join(root, 'workspace'));
  fs.writeFileSync(path.join(root, 'agent-browser'), `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called');\n`, { mode: 0o700 });
  process.env.PATH = `${root}${path.delimiter}${savedPath ?? ''}`;
  process.env.APP_PROJECT_DIR = root;
  try {
    await new RetirementAgent().finish();
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedProject === undefined) delete process.env.APP_PROJECT_DIR; else process.env.APP_PROJECT_DIR = savedProject;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SCN-006 映像及兩份 compose 不再依賴舊 browser 後端', () => {
  const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.doesNotMatch(dockerfile, /agent-browser|PUPPETEER_SKIP_CHROMIUM_DOWNLOAD/);
  assert.match(dockerfile, /apt-get install[\s\S]*?\bripgrep\b/, '原生技能讀取所需 ripgrep 必須在建置時安裝');
  for (const name of ['docker-compose.yml', 'docker-compose.release.yml']) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'), /AGENT_BROWSER_ARGS/);
  }
});
