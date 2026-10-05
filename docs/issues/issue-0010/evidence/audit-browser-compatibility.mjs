import { createRequire } from 'node:module';
import { statSync } from 'node:fs';

// 2026-10-04：只讀 toolcall 輸入並輸出聚合；不輸出 command、URL、聊天正文或認證。
const require = createRequire('/app/package.json');
const Database = require('/app/node_modules/better-sqlite3');
const dbPath = '/home/node/.local/share/opencode/opencode.db';
const from = Date.parse('2026-09-04T00:00:00+08:00');
const until = Date.parse('2026-10-05T00:00:00+08:00');
const limit = 20000;
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma('query_only=ON');
const partCount = db.prepare('SELECT COUNT(*) AS count, MIN(time_created) AS earliest, MAX(time_created) AS latest FROM part').get();
const messageCount = db.prepare('SELECT COUNT(*) AS count FROM message').get().count;
const toolWhere = "time_created >= ? AND time_created < ? AND json_valid(data) AND json_extract(data, '$.type') = 'tool'";
const total = db.prepare(`SELECT COUNT(*) AS count FROM part WHERE ${toolWhere}`).get(from, until).count;
const rows = db.prepare(`SELECT session_id, message_id, time_created, data FROM part WHERE ${toolWhere} ORDER BY time_created DESC LIMIT ?`).all(from, until, limit);
const categories = { stateSave: 0, stateLoad: 0, loginRelated: 0, fill: 0, click: 0, explicitSession: 0, readOnly: 0, other: 0 };
const tools = {};
const sessions = new Map();
const operations = {};
const allowed = new Set(['open', 'goto', 'navigate', 'snapshot', 'get', 'wait', 'eval', 'close', 'click', 'tap', 'press', 'fill', 'type', 'select', 'check', 'state', 'session', 'screenshot', 'pdf', 'scroll', 'find', 'install', '--help', '--version']);
const valueOptions = new Set(['--session', '--profile', '--browser', '--cdp', '--executable-path', '--headers', '--user-agent', '--proxy', '--proxy-bypass']);
const userBefore = db.prepare("SELECT id, time_created FROM message WHERE session_id = ? AND time_created <= ? AND json_valid(data) AND json_extract(data, '$.role') = 'user' ORDER BY time_created DESC LIMIT 1");
const snapshotsBefore = db.prepare("SELECT data FROM part WHERE session_id = ? AND time_created >= ? AND time_created <= ? AND json_valid(data) AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.state.input.command') LIKE '%agent-browser%snapshot%' ORDER BY time_created DESC LIMIT 50");
const clickRoles = { link: 0, button: 0, input: 0, unknown: 0 };
const clickStatuses = { completed: 0, error: 0, other: 0 };
const clickLookup = { refTargets: 0, snapshotRows: 0, stringOutputs: 0, targetRefMatches: 0, truncatedLookups: 0 };
let browserCalls = 0;
let recognizableInvocations = 0;
let malformedToolInput = 0;
for (const row of rows) {
  const part = JSON.parse(row.data);
  tools[part.tool || 'unknown'] = (tools[part.tool || 'unknown'] || 0) + 1;
  const command = part.state?.input?.command;
  if (typeof command !== 'string') { malformedToolInput++; continue; }
  if (!/\bagent-browser\b/.test(command)) continue;
  browserCalls++;
  const tokens = command.match(/"(?:\\.|[^"])*"|'[^']*'|[^\s;&|]+|[;&|]/g) || [];
  for (let index = 0; index < tokens.length; index++) {
    if (!/(?:^|\/)agent-browser$/.test(tokens[index])) continue;
    let next = index + 1;
    while (tokens[next]?.startsWith('--') && !allowed.has(tokens[next])) {
      const option = tokens[next++].split('=')[0];
      if (valueOptions.has(option) && !tokens[next - 1].includes('=')) next++;
    }
    const operation = tokens[next];
    if (!allowed.has(operation)) continue;
    const detail = ['state', 'session'].includes(operation) && ['save', 'load', 'list', 'close'].includes(tokens[next + 1]) ? `${operation}-${tokens[next + 1]}` : operation;
    operations[detail] = (operations[detail] || 0) + 1;
    recognizableInvocations++;
    if (operation === 'click') {
      const status = part.state?.status;
      clickStatuses[status === 'completed' ? 'completed' : status === 'error' ? 'error' : 'other']++;
      const target = tokens[next + 1]?.replace(/^["']|["']$/g, '');
      let role = 'unknown';
      const user = userBefore.get(row.session_id, row.time_created);
      if (user && /^@e\d+$/.test(target || '')) {
        clickLookup.refTargets++;
        const snapshotRows = snapshotsBefore.all(row.session_id, user.time_created, row.time_created);
        clickLookup.snapshotRows += snapshotRows.length;
        if (snapshotRows.length === 50) clickLookup.truncatedLookups++;
        for (const snapshotRow of snapshotRows) {
          const output = JSON.parse(snapshotRow.data).state?.output;
          if (typeof output !== 'string') continue;
          clickLookup.stringOutputs++;
          const line = output.split('\n').find(item => new RegExp(`\\[ref=@?${target.slice(1)}\\]`).test(item));
          if (line) clickLookup.targetRefMatches++;
          const matched = line?.match(/^\s*-?\s*(link|button|input|textbox)\b/i);
          if (matched) { role = matched[1].toLowerCase() === 'textbox' ? 'input' : matched[1].toLowerCase(); break; }
        }
      }
      clickRoles[role]++;
    }
  }
  const flags = {
    stateSave: /\bagent-browser\b[^\n;&|]*\bstate\s+save\b/.test(command),
    stateLoad: /\bagent-browser\b[^\n;&|]*\bstate\s+load\b/.test(command),
    loginRelated: /\b(?:login|signin|sign-in|oauth)\b/i.test(command),
    fill: /\bagent-browser\b[^\n;&|]*\b(?:fill|type)\b/.test(command),
    click: /\bagent-browser\b[^\n;&|]*\b(?:click|tap|press|select|check)\b/.test(command),
    explicitSession: /\bagent-browser\b[^\n;&|]*(?:--session\b|\bsession\s+(?:list|close)\b)/.test(command),
    readOnly: /\bagent-browser\b[^\n;&|]*\b(?:open|goto|navigate|snapshot|get|wait|screenshot|close)\b/.test(command),
  };
  for (const [name, present] of Object.entries(flags)) if (present) categories[name]++;
  if (!Object.values(flags).some(Boolean)) categories.other++;
  const seen = sessions.get(row.session_id) || { calls: 0, messages: new Set(), userTurns: new Set(), missingUser: 0, earliest: row.time_created, latest: row.time_created };
  seen.calls++;
  seen.messages.add(row.message_id);
  const precedingUser = userBefore.get(row.session_id, row.time_created);
  if (precedingUser) seen.userTurns.add(precedingUser.id);
  else seen.missingUser++;
  seen.earliest = Math.min(seen.earliest, row.time_created);
  seen.latest = Math.max(seen.latest, row.time_created);
  sessions.set(row.session_id, seen);
}
const sessionValues = [...sessions.values()];
const stat = statSync(dbPath);
console.log(JSON.stringify({
  date: '2026-10-04', dbPath, dbIdentity: { device: stat.dev, inode: stat.ino },
  window: { from: '2026-09-04T00:00:00+08:00', untilExclusive: '2026-10-05T00:00:00+08:00', fromEpochMs: from, untilEpochMs: until },
  partCount, messageCount, totalToolPartsInWindow: total, limit, inspectedToolParts: rows.length, truncated: total > limit,
  toolCounts: tools, toolPartsWithoutStringCommand: malformedToolInput,
  browserCandidateParts: browserCalls, candidateRegexCategories: categories, recognizableInvocations, fixedOperationCounts: operations,
  clickContextAggregates: { snapshotLookupLimitPerClick: 50, lookup: clickLookup, roles: clickRoles, statuses: clickStatuses },
  sessionAggregates: { withBrowserCandidates: sessionValues.length, multipleBrowserCalls: sessionValues.filter(item => item.calls > 1).length, multipleAssistantMessages: sessionValues.filter(item => item.messages.size > 1).length, multiplePrecedingUserTurns: sessionValues.filter(item => item.userTurns.size > 1).length, missingPrecedingUserParts: sessionValues.reduce((sum, item) => sum + item.missingUser, 0), durationOverOneHour: sessionValues.filter(item => item.latest - item.earliest > 3600000).length },
}));
db.close();
