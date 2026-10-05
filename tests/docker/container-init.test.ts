import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// 2026-10-04：SCN-003／007，兩個執行服務必須由 init 回收被收養的程序。
for (const filename of ['docker-compose.yml', 'docker-compose.release.yml']) {
  test(`${filename} enables init for both execution services`, () => {
    const configuration = yaml.load(readFileSync(path.resolve(import.meta.dirname, '../..', filename), 'utf8')) as {
      services: Record<string, { init?: boolean; pids_limit?: number }>;
    };
    assert.equal(configuration.services.telenexus.init, true);
    assert.equal(configuration.services['agent-runner'].init, true);
    assert.equal(configuration.services['agent-runner'].pids_limit, 1024);
  });
}
