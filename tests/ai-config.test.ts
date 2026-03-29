import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadChatPromptConfig } from '../src/config/ai-config.js';

function withTempCwd<T>(files: Record<string, string>, fn: () => T): T {
  const prevCwd = process.cwd();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telenexus-ai-config-test-'));

  try {
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(tempDir, name), content, 'utf8');
    }
    process.chdir(tempDir);
    return fn();
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test('loadChatPromptConfig default prompt text uses current TeleNexus wording', () => {
  withTempCwd({}, () => {
    const config = loadChatPromptConfig();

    assert.match(config.roleSystem, /TeleNexus/);
    assert.doesNotMatch(config.roleSystem, /google_search|read_file/);
    assert.equal(config.memoryPolicyLines.length, 4);
    assert.ok(
      config.memoryPolicyLines.every(
        (line) => !/create_entities|create_relations|search_entities/.test(line)
      )
    );
  });
});
