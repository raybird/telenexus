import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dockerfile = fs.readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');

test('SCN-002 dev/runtime 共用 base 固定安裝 MCP 與獨立 Chrome', () => {
  const base = dockerfile.split('FROM node:22-slim AS base')[1]?.split('FROM base AS dev')[0] ?? '';
  assert.match(base, /chrome-devtools-mcp@1\.10\.1/);
  assert.match(base, /154\.0\.8037\.92\/linux64\/chrome-linux64\.zip/);
  assert.match(base, /ff43322f335e436b2f4dcdfeeec5db032299e335a7e8c1c618b326e100ce8732/);
  assert.match(base, /sha256sum -c/);
  assert.match(base, /COPY scripts\/browser-mcp-launcher\.mjs/);
  assert.doesNotMatch(base, /chrome-devtools-mcp@latest/);
});
