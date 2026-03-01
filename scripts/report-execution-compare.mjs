import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

function printHelp() {
  console.log(`Usage: node scripts/report-execution-compare.mjs [options]

Options:
  --hours <n>        Time window in hours (default: 24)
  --since <iso>      Start time (ISO-8601, overrides --hours)
  --until <iso>      End time (ISO-8601, default: now)
  --output <path>    Report output path (default: workspace/context/execution-compare.md)
  --no-write         Do not write file, print report only
  --help             Show this help
`);
}

function parseArgs(argv) {
  const args = {
    hours: 24,
    since: null,
    until: null,
    output: path.resolve(process.cwd(), 'workspace', 'context', 'execution-compare.md'),
    write: true
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help') {
      printHelp();
      process.exit(0);
    }
    if (token === '--hours') {
      const value = Number.parseInt(argv[i + 1] || '', 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --hours value: ${argv[i + 1] || '(missing)'}`);
      }
      args.hours = value;
      i += 1;
      continue;
    }
    if (token === '--since') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value for --since');
      }
      args.since = value;
      i += 1;
      continue;
    }
    if (token === '--until') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value for --until');
      }
      args.until = value;
      i += 1;
      continue;
    }
    if (token === '--output') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value for --output');
      }
      args.output = path.resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    if (token === '--no-write') {
      args.write = false;
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  const untilDate = args.until ? new Date(args.until) : new Date();
  if (Number.isNaN(untilDate.getTime())) {
    throw new Error(`Invalid --until timestamp: ${args.until}`);
  }

  let sinceDate;
  if (args.since) {
    sinceDate = new Date(args.since);
    if (Number.isNaN(sinceDate.getTime())) {
      throw new Error(`Invalid --since timestamp: ${args.since}`);
    }
  } else {
    sinceDate = new Date(untilDate.getTime() - args.hours * 60 * 60 * 1000);
  }

  if (sinceDate.getTime() >= untilDate.getTime()) {
    throw new Error('--since must be earlier than --until');
  }

  return {
    ...args,
    sinceDate,
    untilDate
  };
}

function runDockerLogs(service, sinceIso, untilIso) {
  const cmdArgs = ['compose', 'logs', service, '--since', sinceIso, '--tail', '5000'];
  if (untilIso) {
    cmdArgs.push('--until', untilIso);
  }
  const result = spawnSync('docker', cmdArgs, {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });

  if (result.status !== 0) {
    return {
      ok: false,
      output: '',
      error: (result.stderr || result.stdout || 'docker compose logs failed').trim()
    };
  }

  return { ok: true, output: result.stdout || '', error: '' };
}

function parseTelenexusLogs(text) {
  const lines = text.split(/\r?\n/);
  const counts = {
    chatModeRunner: 0,
    chatModeLocal: 0,
    schedulerTriggered: 0,
    schedulerIncomplete: 0,
    schedulerTaskErrors: 0,
    runnerSuccess: 0,
    runnerFailures: 0
  };

  const providerGlobal = new Map();
  const providerBySource = {
    chat: new Map(),
    scheduler: new Map(),
    unknown: new Map()
  };
  let pendingScheduler = 0;
  let pendingChat = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.includes('[Scheduler] Triggered:')) {
      counts.schedulerTriggered += 1;
      pendingScheduler += 1;
    }
    if (line.includes('[Scheduler] Error executing task')) {
      counts.schedulerTaskErrors += 1;
    }
    if (line.includes('AI returned incomplete execution response')) {
      counts.schedulerIncomplete += 1;
    }
    if (line.includes('Runner success.')) {
      counts.runnerSuccess += 1;
    }
    if (line.includes('Runner failed:')) {
      counts.runnerFailures += 1;
    }

    const modeMatch = line.match(/\[System\] Message execution mode: (runner|local)/);
    if (modeMatch) {
      if (modeMatch[1] === 'runner') {
        counts.chatModeRunner += 1;
      } else {
        counts.chatModeLocal += 1;
      }
      pendingChat += 1;
    }

    const providerMatch = line.match(
      /\[DynamicAgent\] Provider: (\w+), Model: ([^,]+), PreferRunner: (\w+)/
    );
    if (providerMatch) {
      const provider = providerMatch[1];
      const model = providerMatch[2];
      const preferRunner = providerMatch[3];
      const key = `${provider} | ${model} | preferRunner=${preferRunner}`;
      providerGlobal.set(key, (providerGlobal.get(key) || 0) + 1);

      let source = 'unknown';
      if (pendingScheduler > 0) {
        source = 'scheduler';
        pendingScheduler -= 1;
      } else if (pendingChat > 0) {
        source = 'chat';
        pendingChat -= 1;
      }
      const sourceMap = providerBySource[source];
      sourceMap.set(key, (sourceMap.get(key) || 0) + 1);
    }
  }

  return { counts, providerGlobal, providerBySource };
}

function parseRunnerAudit(auditPath, sinceMs, untilMs) {
  if (!fs.existsSync(auditPath)) {
    return {
      exists: false,
      total: 0,
      failures: 0,
      byTaskProviderModel: new Map(),
      byErrorType: new Map(),
      suspiciousModelPairs: new Map(),
      recentRows: []
    };
  }

  const lines = fs.readFileSync(auditPath, 'utf8').split(/\r?\n/);
  const byTaskProviderModel = new Map();
  const byErrorType = new Map();
  const suspiciousModelPairs = new Map();
  const recentRows = [];
  let total = 0;
  let failures = 0;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = Number(row.timestamp || 0);
    if (!Number.isFinite(ts) || ts < sinceMs || ts >= untilMs) {
      continue;
    }

    total += 1;
    const ok = row.ok === true;
    if (!ok) {
      failures += 1;
    }

    const task = row.task || '(unknown)';
    const provider = row.provider || '(unknown)';
    const model = row.model || '(default)';
    const key = `${task} | ${provider} | ${model}`;
    byTaskProviderModel.set(key, (byTaskProviderModel.get(key) || 0) + 1);

    if (!ok) {
      const errorType = row.errorType || 'runner_error_other';
      byErrorType.set(errorType, (byErrorType.get(errorType) || 0) + 1);
    }

    if (provider === 'opencode' && /gemini/i.test(String(model))) {
      const suspiciousKey = `${provider} with model=${model}`;
      suspiciousModelPairs.set(suspiciousKey, (suspiciousModelPairs.get(suspiciousKey) || 0) + 1);
    }

    recentRows.push({
      timestamp: ts,
      task,
      provider,
      model,
      ok,
      errorType: row.errorType || '-'
    });
  }

  recentRows.sort((a, b) => a.timestamp - b.timestamp);

  return {
    exists: true,
    total,
    failures,
    byTaskProviderModel,
    byErrorType,
    suspiciousModelPairs,
    recentRows: recentRows.slice(-12)
  };
}

function mapToMarkdownTable(map, headers) {
  const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return '_無資料_';
  }
  const lines = [];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const [key, value] of entries) {
    lines.push(`| ${key} | ${value} |`);
  }
  return lines.join('\n');
}

function rowsToMarkdownTable(rows) {
  if (rows.length === 0) {
    return '_無資料_';
  }
  const lines = [
    '| 時間 (Asia/Taipei) | task | provider | model | ok | errorType |',
    '| --- | --- | --- | --- | --- | --- |'
  ];
  for (const row of rows) {
    const time = new Date(row.timestamp).toLocaleString('zh-TW', {
      hour12: false,
      timeZone: 'Asia/Taipei'
    });
    lines.push(
      `| ${time} | ${row.task} | ${row.provider} | ${row.model} | ${row.ok ? 'true' : 'false'} | ${row.errorType} |`
    );
  }
  return lines.join('\n');
}

function buildReport(options, telenexusParsed, runnerParsed, telenexusLogState, runnerLogState) {
  const generatedAt = new Date().toLocaleString('zh-TW', {
    hour12: false,
    timeZone: 'Asia/Taipei'
  });
  const sinceText = options.sinceDate.toLocaleString('zh-TW', {
    hour12: false,
    timeZone: 'Asia/Taipei'
  });
  const untilText = options.untilDate.toLocaleString('zh-TW', {
    hour12: false,
    timeZone: 'Asia/Taipei'
  });

  const c = telenexusParsed.counts;

  const report = [
    '# Chat vs Scheduler Execution Compare Report',
    '',
    `- Generated: ${generatedAt}`,
    `- Window: ${sinceText} ~ ${untilText}`,
    `- Telenexus logs: ${telenexusLogState.ok ? 'ok' : `failed (${telenexusLogState.error})`}`,
    `- Runner logs: ${runnerLogState.ok ? 'ok' : `failed (${runnerLogState.error})`}`,
    `- Runner audit: ${runnerParsed.exists ? 'found' : 'missing'}`,
    '',
    '## Execution Summary',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Chat mode runner count | ${c.chatModeRunner} |`,
    `| Chat mode local count | ${c.chatModeLocal} |`,
    `| Scheduler triggers | ${c.schedulerTriggered} |`,
    `| Scheduler incomplete responses | ${c.schedulerIncomplete} |`,
    `| Scheduler task errors | ${c.schedulerTaskErrors} |`,
    `| DynamicAgent runner success | ${c.runnerSuccess} |`,
    `| DynamicAgent runner failures | ${c.runnerFailures} |`,
    '',
    '## DynamicAgent Provider Distribution (from telenexus logs)',
    '',
    mapToMarkdownTable(telenexusParsed.providerGlobal, ['provider|model|preferRunner', 'count']),
    '',
    '### Approximate Source Split',
    '',
    '**chat**',
    mapToMarkdownTable(telenexusParsed.providerBySource.chat, [
      'provider|model|preferRunner',
      'count'
    ]),
    '',
    '**scheduler**',
    mapToMarkdownTable(telenexusParsed.providerBySource.scheduler, [
      'provider|model|preferRunner',
      'count'
    ]),
    '',
    '**unknown**',
    mapToMarkdownTable(telenexusParsed.providerBySource.unknown, [
      'provider|model|preferRunner',
      'count'
    ]),
    '',
    '## Runner Audit Breakdown',
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Total requests | ${runnerParsed.total} |`,
    `| Failed requests | ${runnerParsed.failures} |`,
    '',
    mapToMarkdownTable(runnerParsed.byTaskProviderModel, ['task|provider|model', 'count']),
    '',
    '### Runner Error Types',
    '',
    mapToMarkdownTable(runnerParsed.byErrorType, ['errorType', 'count']),
    '',
    '### Suspicious Provider/Model Pairing',
    '',
    mapToMarkdownTable(runnerParsed.suspiciousModelPairs, ['pair', 'count']),
    '',
    '### Recent Runner Audit Rows',
    '',
    rowsToMarkdownTable(runnerParsed.recentRows),
    ''
  ];

  return report.join('\n');
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const sinceIso = options.sinceDate.toISOString();
  const untilIso = options.untilDate.toISOString();

  const telenexusLogs = runDockerLogs('telenexus', sinceIso, untilIso);
  const runnerLogs = runDockerLogs('agent-runner', sinceIso, untilIso);

  const telenexusParsed = parseTelenexusLogs(telenexusLogs.output);
  const auditPath = path.resolve(process.cwd(), 'workspace', 'context', 'runner-audit.log');
  const runnerParsed = parseRunnerAudit(
    auditPath,
    options.sinceDate.getTime(),
    options.untilDate.getTime()
  );

  const report = buildReport(options, telenexusParsed, runnerParsed, telenexusLogs, runnerLogs);
  console.log(report);

  if (options.write) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, report, 'utf8');
    console.log(`\n[report] wrote ${options.output}`);
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[report] failed: ${message}`);
  process.exit(1);
}
