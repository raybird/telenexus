import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');

test('runtime image installs production dependencies instead of copying builder node_modules', () => {
  assert.match(
    dockerfile,
    /npm\s+ci\s+--omit=dev/,
    'runtime stage should install production-only dependencies with npm ci --omit=dev',
  );
  assert.doesNotMatch(
    dockerfile,
    /COPY\s+--from=builder\s+\/app\/node_modules\s+\.\/node_modules/,
    'runtime stage should not copy builder node_modules because it includes devDependencies',
  );
});

test('runtime image avoids installing both system Chromium and agent-browser Chrome', () => {
  assert.doesNotMatch(
    dockerfile,
    /\s+chromium\s*\\/,
    'agent-browser install already provides Chrome, so the runtime image should not also install Debian chromium',
  );
  assert.doesNotMatch(
    dockerfile,
    /PUPPETEER_EXECUTABLE_PATH=\/usr\/bin\/chromium/,
    'runtime image should not point Puppeteer at Debian chromium when Chromium is not installed',
  );
});
