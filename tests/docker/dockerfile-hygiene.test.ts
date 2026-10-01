import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');

/** Dockerfile 指令不分大小寫,行首也可以有空白;比對時都要放寬,否則小寫的 from 就能繞過檢查。 */
function stages(text: string): string[] {
  const starts = [...text.matchAll(/^[ \t]*FROM\s.+$/gim)].map((match) => match.index);
  return starts.map((start, i) => text.slice(start, starts[i + 1]));
}

/**
 * 不指定 target 的建置取到的是最後一個 stage,release.yml 與 docker-compose.yml 都這樣建。
 * release.yml 不跑測試,所以「最後一個 stage 不是正式映像」在發版流程裡是全綠的 ——
 * 只有這裡守得住。
 */
function finalStage(text: string): string {
  const last = stages(text).at(-1);
  assert.ok(last, 'Dockerfile should contain at least one FROM');
  return last;
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
    /npm\s+ci(?!\s+--omit=dev)|npm\s+(?:install|i|add)\b|--include=dev/,
    'final stage should not install devDependencies',
  );
  assert.match(
    stage,
    /COPY\s+--from=builder\s+\/app\/dist\s/i,
    'final stage should run the compiled dist from the builder stage',
  );
  assert.match(stage, /^ENV\s+NODE_ENV=production$/m, 'final stage should set NODE_ENV=production');

  // 同一個 stage 有多個 CMD 時只有最後一個生效。
  const lastCmd = [...stage.matchAll(/^[ \t]*CMD\s.+$/gim)].at(-1)?.[0] ?? '';
  assert.match(
    lastCmd,
    /^[ \t]*CMD\s+\["npm",\s*"start"\]$/i,
    'the effective CMD of the final stage should start the compiled service with npm start',
  );
});

/**
 * ARG 之後的每個 RUN 都隱含使用它,值不同就 cache miss。release.yml 每次發版傳入不同的
 * APP_BUILD_TIME,所以 base 的系統套件、未釘版的全域 CLI 與 Chrome 每版都會重裝。
 * 把這兩個 ARG 移到後面的 stage,這些層就改由 CI 快取決定新舊 —— 建出來的映像內容
 * 當下看不出差別,只有這裡守得住。
 */
test('build args are declared before the first RUN of the shared base stage', () => {
  const base = stages(dockerfile).find((stage) =>
    /\bAS\s+base\b/i.test(stage.split('\n', 1)[0] ?? ''),
  );
  assert.ok(base, 'Dockerfile should define a stage named base');

  const firstRun = base.search(/^[ \t]*RUN\s/im);
  assert.notEqual(firstRun, -1, 'base stage should contain a RUN instruction');
  const beforeFirstRun = base.slice(0, firstRun);

  for (const name of ['APP_GIT_SHA', 'APP_BUILD_TIME']) {
    assert.match(
      beforeFirstRun,
      new RegExp(`^[ \\t]*ARG\\s+${name}\\b`, 'im'),
      `base stage should declare ARG ${name} before its first RUN so release builds refresh every layer`,
    );
  }
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
