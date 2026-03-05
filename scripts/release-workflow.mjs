import { spawnSync } from 'node:child_process';

const allowedBumps = new Set(['patch', 'minor', 'major']);

function parseArgs(argv) {
  let bump = 'patch';
  let message = '';

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];

    if (allowedBumps.has(value)) {
      bump = value;
      continue;
    }

    if (value === '-m' || value === '--message') {
      message = argv[i + 1] || '';
      i += 1;
      continue;
    }
  }

  return { bump, message: message.trim() };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `Failed: ${command} ${args.join(' ')}\n`);
    process.exit(result.status || 1);
  }
  return (result.stdout || '').trim();
}

function ensureGitRepo() {
  const inside = capture('git', ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    process.stderr.write('Not inside a git repository.\n');
    process.exit(1);
  }
}

function ensureNoUnstagedChanges() {
  const unstaged = capture('git', ['diff', '--name-only']);
  if (unstaged.length > 0) {
    process.stderr.write('Found unstaged changes. Please stage or stash them first.\n');
    process.stderr.write(`${unstaged}\n`);
    process.exit(1);
  }
}

function ensureStagedChanges() {
  const staged = capture('git', ['diff', '--cached', '--name-only']);
  if (!staged) {
    process.stderr.write('No staged changes found. Stage files before running release workflow.\n');
    process.exit(1);
  }
}

function ensureCommitMessage(message) {
  if (!message) {
    process.stderr.write('Missing commit message. Use -m or --message.\n');
    process.stderr.write(
      'Example: npm run release:patch -- -m "feat(web): improve mobile layout"\n'
    );
    process.exit(1);
  }
}

function printStep(label) {
  process.stdout.write(`\n=== ${label} ===\n`);
}

function main() {
  const { bump, message } = parseArgs(process.argv.slice(2));

  ensureGitRepo();
  ensureCommitMessage(message);
  ensureNoUnstagedChanges();
  ensureStagedChanges();

  printStep('git commit');
  run('git', ['commit', '-m', message]);

  printStep(`npm version ${bump}`);
  run('npm', ['version', bump]);

  printStep('git push');
  run('git', ['push']);

  printStep('git push --tags');
  run('git', ['push', '--tags']);

  process.stdout.write('\nRelease workflow completed.\n');
}

main();
