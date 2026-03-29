import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const allowedBumps = new Set(['patch', 'minor', 'major']);
const allowedReleaseBranches = new Set(['main', 'master']);
const readmeVersionBadgePattern = /version-v(\d+\.\d+\.\d+)-/;

export function parseArgs(argv) {
  let bump = 'patch';
  let message = '';
  let dryRun = false;

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

    if (value === '--dry-run') {
      dryRun = true;
    }
  }

  return { bump, message: message.trim(), dryRun };
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

export function isAllowedReleaseBranch(branchName) {
  return allowedReleaseBranches.has(branchName) || branchName.startsWith('release/');
}

export function extractReadmeVersionBadge(readmeContent) {
  const match = readmeContent.match(readmeVersionBadgePattern);
  return match ? match[1] : null;
}

export function updateReadmeVersionBadge(readmeContent, packageVersion) {
  if (!extractReadmeVersionBadge(readmeContent)) {
    return null;
  }

  return readmeContent.replace(readmeVersionBadgePattern, `version-v${packageVersion}-`);
}

export function validateReadmeVersionBadge(readmeContent, packageVersion) {
  const badgeVersion = extractReadmeVersionBadge(readmeContent);
  if (!badgeVersion) {
    return {
      ok: false,
      reason: 'README version badge not found.'
    };
  }

  if (badgeVersion !== packageVersion) {
    return {
      ok: false,
      reason: `README version badge (${badgeVersion}) does not match package.json version (${packageVersion}).`
    };
  }

  return { ok: true };
}

function ensureGitRepo() {
  const inside = capture('git', ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') {
    process.stderr.write('Not inside a git repository.\n');
    process.exit(1);
  }
}

function ensureReleaseBranch() {
  const branch = capture('git', ['branch', '--show-current']);
  if (!isAllowedReleaseBranch(branch)) {
    process.stderr.write(
      `Release workflow only runs on main/master or release/* branches. Current branch: ${branch || '(detached)'}\n`
    );
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

function ensureReadmeVersionBadgeUpToDate() {
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');
  const readmePath = path.resolve(process.cwd(), 'README.md');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const readme = fs.readFileSync(readmePath, 'utf8');
  const result = validateReadmeVersionBadge(readme, String(packageJson.version || '').trim());
  if (!result.ok) {
    process.stderr.write(`${result.reason}\n`);
    process.exit(1);
  }
}

function ensureReadmeVersionBadgeExists() {
  const readmePath = path.resolve(process.cwd(), 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  if (!extractReadmeVersionBadge(readme)) {
    process.stderr.write('README version badge not found.\n');
    process.exit(1);
  }
}

function readPackageVersion() {
  const packageJsonPath = path.resolve(process.cwd(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return String(packageJson.version || '').trim();
}

function syncReadmeVersionBadge(packageVersion) {
  const readmePath = path.resolve(process.cwd(), 'README.md');
  const current = fs.readFileSync(readmePath, 'utf8');
  const next = updateReadmeVersionBadge(current, packageVersion);
  if (next === null) {
    process.stderr.write('README version badge not found.\n');
    process.exit(1);
  }
  if (next === current) {
    return false;
  }

  fs.writeFileSync(readmePath, next, 'utf8');
  run('git', ['add', '--', 'README.md']);
  return true;
}

function printStep(label) {
  process.stdout.write(`\n=== ${label} ===\n`);
}

function main() {
  const { bump, message, dryRun } = parseArgs(process.argv.slice(2));

  ensureGitRepo();
  ensureReleaseBranch();
  ensureCommitMessage(message);
  ensureNoUnstagedChanges();
  ensureStagedChanges();
  ensureReadmeVersionBadgeExists();

  const currentVersion = readPackageVersion();

  if (dryRun) {
    process.stdout.write('Release checks passed (dry-run).\n');
    process.stdout.write(
      `Would sync README badge to current version if needed: ${currentVersion}\n`
    );
    process.stdout.write(`Would run: git commit -m "${message}"\n`);
    process.stdout.write(`Would run: npm version ${bump} --no-git-tag-version\n`);
    process.stdout.write('Would sync README badge to new package version\n');
    process.stdout.write('Would run: git commit -m "<new-version>"\n');
    process.stdout.write('Would run: git tag v<new-version>\n');
    process.stdout.write('Would run: git push\n');
    process.stdout.write('Would run: git push --tags\n');
    return;
  }

  syncReadmeVersionBadge(currentVersion);
  ensureReadmeVersionBadgeUpToDate();

  printStep('git commit');
  run('git', ['commit', '-m', message]);

  printStep(`npm version ${bump}`);
  run('npm', ['version', bump, '--no-git-tag-version']);

  const nextVersion = readPackageVersion();
  syncReadmeVersionBadge(nextVersion);

  printStep(`git commit ${nextVersion}`);
  run('git', ['add', '--', 'package.json', 'package-lock.json', 'README.md']);
  run('git', ['commit', '-m', nextVersion]);

  printStep(`git tag v${nextVersion}`);
  run('git', ['tag', `v${nextVersion}`]);

  printStep('git push');
  run('git', ['push']);

  printStep('git push --tags');
  run('git', ['push', '--tags']);

  process.stdout.write('\nRelease workflow completed.\n');
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main();
}
