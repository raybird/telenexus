import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { snapshot } from './proc-observer.mjs';

// 2026-10-04：SCN-006 真文字 -c、原生 skill 探索與兩次遷移；只建立測試資料。
setInterval(() => {}, 1000);
const [mode = 'legacy'] = process.argv.slice(2);
assert.ok(['fresh', 'legacy'].includes(mode));
const emit = value => console.log(JSON.stringify(value));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = mkdtempSync('/tmp/i10mig-');
const sourceDir = process.env.BUILTIN_SKILLS_DIR || '/app/skills';
assert.ok(existsSync(join(sourceDir, 'web-reading', 'SKILL.md')), '須唯讀掛載本期技能 source 至 /app/skills');
for (const directory of ['config', 'cache', 'data', 'state', 'workspace']) mkdirSync(join(root, directory));
const projectSkills = join(root, 'workspace', '.opencode', 'skills');
const globalSkills = join(root, 'config', 'opencode', 'skills');
for (const directory of [projectSkills, globalSkills]) mkdirSync(directory, { recursive: true });
const authPath = join(root, 'data', 'opencode', 'auth.json');
mkdirSync(dirname(authPath), { recursive: true });
const authSentinel = 'ISSUE10_AUTH_SENTINEL_20261004';
const auth = JSON.stringify({ probe: { type: 'api', key: authSentinel } });
writeFileSync(authPath, auth, { mode: 0o600 });
const configPath = join(root, 'config', 'opencode', 'opencode.json');
const persistentConfig = JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: {
  memory: { type: 'local', command: ['node', '/probe/memory-mcp-fixture.mjs'] },
  custom: { type: 'local', command: ['node', '/probe/memory-mcp-fixture.mjs'] }
} });
writeFileSync(configPath, persistentConfig);
const customSkill = '---\nname: fixture-custom-skill\ndescription: ISSUE10_CUSTOM_SKILL_DESCRIPTION\n---\n\nISSUE10_CUSTOM_SKILL_CONTENT\n';
for (const directory of [projectSkills, globalSkills]) {
  mkdirSync(join(directory, 'fixture-custom-skill'));
  writeFileSync(join(directory, 'fixture-custom-skill', 'SKILL.md'), customSkill);
  if (mode === 'legacy') {
    assert.ok(existsSync('/legacy/skills/agent-browser/SKILL.md'), 'legacy 須唯讀掛載 git archive 04f5f2d fixture');
    cpSync('/legacy/skills/agent-browser', join(directory, 'agent-browser'), { recursive: true });
  }
}
function tree(directory) {
  const entries = [];
  function walk(current, prefix) {
    for (const name of readdirSync(current).sort()) {
      const file = join(current, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(file);
      assert.ok(!stat.isSymbolicLink(), 'fixture tree 不能意外跟隨 symlink');
      if (stat.isDirectory()) { entries.push({ path: relative, type: 'directory' }); walk(file, relative); }
      else { assert.ok(stat.isFile()); entries.push({ path: relative, type: 'file', sha256: createHash('sha256').update(readFileSync(file)).digest('hex') }); }
    }
  }
  walk(directory, '');
  return entries;
}
const legacyTree = mode === 'legacy' ? tree('/legacy/skills/agent-browser') : null;
const marker = 'ISSUE10_TEXT_SESSION_SENTINEL_20261004';
let phase = 'first';
let calls = 0;
let fixtureError;
let historyVerified = false;
let nativeSkillsVerified = false;
let oldSkillPositiveControl = false;
const provider = createServer(async (request, response) => {
  try {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const tools = body.tools ?? [];
    let delta;
    let finish = 'stop';
    if (!tools.length) delta = { role: 'assistant', content: 'Migration session fixture' };
    else {
      assert.equal(request.headers.authorization, `Bearer ${authSentinel}`, '僅使用 synthetic fixture 認證');
      const skill = tools.find(tool => tool.function.name === 'skill');
      emit({ event: 'native-skill-diagnostic', phase, skillDescriptor: skill,
        systemMessages: body.messages.filter(message => message.role === 'system'),
        cwd: process.cwd(), productCwd: join(process.env.APP_PROJECT_DIR, 'workspace'),
        environment: Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS', 'OPENCODE_DISABLE_EXTERNAL_SKILLS'].map(name => [name, process.env[name] ?? null])),
        ownedSkillPaths: [projectSkills, globalSkills].map(directory => ({ directory, names: readdirSync(directory) })) });
      assert.ok(skill?.function.parameters?.properties?.name, '真原生 skill tool 必須接受 name；不自行假造工具契約');
      const systemText = body.messages.filter(message => message.role === 'system').map(message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n');
      const blocks = [...systemText.matchAll(/<available_skills>([\s\S]*?)<\/available_skills>/g)];
      assert.equal(blocks.length, 1, '須辨識唯一真正原生 available_skills XML，不以生成 AGENTS 索引代替');
      const availableSkills = [...blocks[0][1].matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map(match => ({ name: match[1].match(/<name>([\s\S]*?)<\/name>/)?.[1].trim(), location: match[1].match(/<location>([\s\S]*?)<\/location>/)?.[1].trim() }));
      const ownSkill = name => availableSkills.some(item => item.name === name && [projectSkills, globalSkills].some(directory => item.location === join(directory, name, 'SKILL.md')));
      assert.ok(tools.some(tool => tool.function.name === 'memory_merge_sentinel') && tools.some(tool => tool.function.name === 'custom_merge_sentinel'), 'memory 與 custom MCP 真工具清單必須保留');
      assert.ok(ownSkill('fixture-custom-skill'), '原生探索必須保留 custom skill 與真檔案位置');
      if (mode === 'legacy' && phase === 'first') {
        assert.ok(ownSkill('agent-browser'), '遷移前正對照必須探索到舊內建技能與真檔案位置');
        oldSkillPositiveControl = true;
      } else {
        assert.ok(ownSkill('web-reading') && !availableSkills.some(item => item.name === 'agent-browser') && !availableSkills.some(item => item.location?.includes('/retired-skills/')), '遷移後原生 skill 清單須有新技能，且不得從 backup 探索到舊內建');
        nativeSkillsVerified = true;
      }
      const users = body.messages.filter(message => message.role === 'user');
      const currentUser = JSON.stringify(users.at(-1));
      if (phase === 'first') assert.ok(currentUser.includes(marker));
      else {
        assert.ok(!currentUser.includes(marker), '第二回 prompt 不得自行提供 sentinel');
        assert.ok(users.slice(0, -1).some(message => JSON.stringify(message).includes(marker)), '真 -c 必須在歷史 user message 看見第一回 marker');
        historyVerified = true;
      }
      emit({ event: 'native-tools-verified', phase, toolNames: tools.map(tool => tool.function.name), availableSkills, authSentinelOnly: true, historyVerified });
      if (calls++ === 0) {
        const name = mode === 'legacy' && phase === 'first' ? 'agent-browser' : 'web-reading';
        delta = { role: 'assistant', tool_calls: [{ index: 0, id: `migration-${phase}`, type: 'function', function: { name: 'skill', arguments: JSON.stringify({ name }) } }] };
        finish = 'tool_calls';
      } else {
        emit({ event: 'native-skill-result-diagnostic', phase, calls, toolMessages: body.messages.filter(message => message.role === 'tool'), lastMessages: body.messages.slice(-8) });
        const lastTool = JSON.stringify(body.messages.filter(message => message.role === 'tool').at(-1));
        assert.ok(lastTool.includes(mode === 'legacy' && phase === 'first' ? 'Browser Automation with agent-browser' : '公開網頁閱讀'), '真 skill call 必須回傳實際檔案內容');
        const firstUser = users.find(message => JSON.stringify(message).includes(marker));
        const observedMarker = JSON.stringify(firstUser).match(/ISSUE10_TEXT_SESSION_SENTINEL_\d{8}/)?.[0];
        assert.equal(observedMarker, marker);
        delta = { role: 'assistant', content: JSON.stringify({ marker: observedMarker, phase, loadedSkill: mode === 'legacy' && phase === 'first' ? 'agent-browser' : 'web-reading' }) };
      }
    }
    const common = { id: `migration-${phase}-${calls}`, object: 'chat.completion.chunk', created: 1, model: 'contract' };
    if (body.stream) {
      response.setHeader('Content-Type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: delta, finish_reason: finish }] }));
    }
  } catch (error) {
    fixtureError = error.message;
    emit({ event: 'fixture-error', phase, message: fixtureError });
    response.writeHead(500); response.end(fixtureError);
  }
});
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${provider.address().port}`;
const inline = { provider: { probe: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `${base}/v1` }, models: { contract: { name: 'Migration contract fixture', limit: { context: 32768, output: 4096 } } } } }, model: 'probe/contract' };
Object.assign(process.env, { APP_PROJECT_DIR: root, BUILTIN_SKILLS_DIR: sourceDir, OPENCODE_SKILLS_DIRS: `${projectSkills},${globalSkills}`, OPENCODE_CONFIG_CONTENT: JSON.stringify(inline), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_TASK_TIMEOUT_MS: '60000', TMPDIR: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state') });
process.chdir(join(root, 'workspace'));
const baseline = new Set(snapshot().map(row => `${row.pid}:${row.starttime}`));
const tracked = new Map();
const chromeSeen = new Set();
function observe() {
  const rows = snapshot();
  for (const row of rows) {
    const id = `${row.pid}:${row.starttime}`;
    if (baseline.has(id)) continue;
    tracked.set(id, row);
    try { row.exe = readlinkSync(`/proc/${row.pid}/exe`); } catch { row.exe = null; }
    if (row.exe === '/opt/telenexus/chrome/chrome-linux64/chrome') chromeSeen.add(id);
  }
  return rows.filter(row => tracked.has(`${row.pid}:${row.starttime}`));
}
const watcher = setInterval(observe, 50);
const sampler = setInterval(() => emit({ event: 'running-sample', owned: observe() }), 1000);
async function migrateTwice() {
  for (let iteration = 1; iteration <= 2; iteration++) {
    const child = spawn('node', ['/app/scripts/sync-skills.mjs'], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise(resolve => child.on('close', resolve));
    emit({ event: 'migration-run', iteration, code, stdout, stderr });
    assert.equal(code, 0);
    for (const directory of [projectSkills, globalSkills]) {
      assert.ok(existsSync(join(directory, 'web-reading', 'SKILL.md')) && !existsSync(join(directory, 'agent-browser')), '兩個 owned skills 位置均完成退役／新技能同步');
      assert.equal(readFileSync(join(directory, 'fixture-custom-skill', 'SKILL.md'), 'utf8'), customSkill);
      const backups = join(dirname(directory), 'retired-skills');
      if (mode === 'legacy') {
        const entries = readdirSync(backups).filter(name => lstatSync(join(backups, name)).isDirectory());
        assert.equal(entries.length, 1, '第二次遷移不能新增重複備份');
        assert.deepEqual(tree(join(backups, entries[0])), legacyTree, '完整備份不得丟失 references/templates');
      }
    }
    assert.equal(readFileSync(authPath, 'utf8'), auth);
    assert.equal(readFileSync(configPath, 'utf8'), persistentConfig);
  }
}
emit({ event: 'start', mode, root, sourceDir, projectSkills, globalSkills, marker });
if (mode === 'fresh') await migrateTwice();
async function chat(prompt, forceNewSession) {
  const child = spawn('node', ['/probe/product-migration-agent-client.mjs', prompt, String(forceNewSession)], { env: { ...process.env }, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; emit({ event: 'migration-client-output', phase, text: String(chunk) }); });
  child.stderr.on('data', chunk => emit({ event: 'migration-client-stderr', phase, text: String(chunk) }));
  const code = await new Promise(resolve => child.on('close', resolve));
  const record = stdout.split('\n').flatMap(line => { try { const parsed = JSON.parse(line); return parsed.event === 'migration-client-result' ? [parsed] : []; } catch { return []; } }).at(-1);
  assert.equal(code, 0, '產品入口子程序須成功，原始 stdout／stderr 均保存');
  assert.ok(record?.result, '不能把非 JSON logger 文字當成產品結果');
  return record.result;
}
const first = await chat(`請記住本回合的文字標記 ${marker}，並使用原生技能工具讀取${mode === 'legacy' ? 'agent-browser' : 'web-reading'}。`, true);
assert.ok(!fixtureError && first.text.includes(marker), fixtureError || '第一回須完成真正文字 session');
const sessionIds = result => [...new Set(result.events?.map(event => event.sessionID || event.part?.sessionID).filter(Boolean))];
const firstIds = sessionIds(first);
assert.equal(firstIds.length, 1, '第一回真 OpenCode events 須有唯一 sessionID');
emit({ event: 'first-session', sessionIds: firstIds, text: first.text, oldSkillPositiveControl });
if (mode === 'legacy') await migrateTwice();
phase = 'second'; calls = 0;
const secondPrompt = '請續接先前的文字標記，使用原生技能工具讀取 web-reading，回報歷史標記。';
assert.ok(!secondPrompt.includes(marker));
const second = await chat(secondPrompt, false);
const secondIds = sessionIds(second);
assert.deepEqual(secondIds, firstIds, '實際 -c 必須續接同一 sessionID');
assert.ok(!fixtureError && historyVerified && nativeSkillsVerified && second.text.includes(marker), fixtureError || '不能以第二回硬編碼 prompt／provider 代替歷史延續');
assert.ok(mode === 'fresh' || oldSkillPositiveControl);
emit({ event: 'second-session', sessionIds: secondIds, text: second.text, historyVerified, nativeSkillsVerified });
clearInterval(sampler);
let final;
for (let second = 0; second <= 15; second++) {
  const owned = observe();
  const roots = readdirSync('/tmp').filter(name => name.startsWith('tnb-'));
  final = { owned, roots, liveCount: owned.filter(row => row.state !== 'Z').length, zombieCount: owned.filter(row => row.state === 'Z').length };
  emit({ event: 'sample', second, ...final });
  if (second < 15) await wait(1000);
}
clearInterval(watcher);
assert.equal(readFileSync(authPath, 'utf8'), auth);
assert.equal(readFileSync(configPath, 'utf8'), persistentConfig);
assert.equal(chromeSeen.size, 0, '文字／skill 工具本身不得啟動 Chrome');
assert.ok(final.owned.length === 0 && final.roots.length === 0, '15 秒內必須沒有工作程序與臨時 browser root');
emit({ event: 'measurement-complete', scn: 'SCN-006', mode, sessionIds: firstIds, historyVerified, nativeSkillsVerified, oldSkillPositiveControl, authPreserved: true, configPreserved: true, customSkillsPreserved: true, browserObserved: chromeSeen.size, cleanupPassed: final.owned.length === 0 && final.roots.length === 0, observerStillAlive: true });
provider.close();
