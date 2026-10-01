import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');

/**
 * 不指定 target 的建置取到的是最後一個 stage,release.yml 與 docker-compose.yml 都這樣建。
 * release.yml 不跑測試,所以「最後一個 stage 不是正式映像」在發版流程裡是全綠的 ——
 * 只有這裡守得住。
 */
function finalStage(text: string): string {
  const fromLines = [...text.matchAll(/^FROM\s.+$/gm)];
  const last = fromLines.at(-1);
  assert.ok(last, 'Dockerfile should contain at least one FROM');
  return text.slice(last.index);
}

test('default build target (last stage) is the production image', () => {
  const stage = finalStage(dockerfile);
  const fromLine = stage.split('\n', 1)[0] ?? '';

  assert.doesNotMatch(
    fromLine,
    /\bAS\s+dev\b/i,
    'the dev stage must not be last: an untargeted build would ship it as the release image',
  );
  assert.match(
    stage,
    /npm\s+ci\s+--omit=dev/,
    'final stage should install production-only dependencies',
  );
  assert.doesNotMatch(
    stage,
    /npm\s+ci(?!\s+--omit=dev)/,
    'final stage should not install devDependencies',
  );
  assert.match(
    stage,
    /COPY\s+--from=builder\s+\/app\/dist\s/,
    'final stage should run the compiled dist from the builder stage',
  );
  assert.match(stage, /^ENV\s+NODE_ENV=production$/m, 'final stage should set NODE_ENV=production');
  assert.match(
    stage,
    /^CMD\s+\["npm",\s*"start"\]$/m,
    'final stage should start the compiled service with npm start',
  );
});

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
