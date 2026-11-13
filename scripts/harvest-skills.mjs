#!/usr/bin/env node
// 技能收成（issue 0025）：列出 agent 在 workspace 做出的技能，並可收進 repo 的 skills/。
// 在 TeleNexus 的 git checkout 裡執行；比對基準是該 repo 的 skills/ 與它的 git 歷史。
// 只在主機上使用，不進任何服務的執行路徑。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function fail(message) {
  console.error(`[harvest] ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const options = { from: null, promote: null, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--from' || arg === '--promote') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail(`${arg} 需要一個值`);
      options[arg.slice(2)] = value;
      i += 1;
    } else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('用法：npm run skills:harvest -- [--from <workspace>] [--promote <名稱> [--force]]');
      process.exit(0);
    } else fail(`不認得的參數：${arg}`);
  }
  if (options.force && !options.promote) fail('--force 只能和 --promote 一起使用');
  return options;
}

function git(repo, args, encoding = 'utf8') {
  return execFileSync('git', args, { cwd: repo, encoding, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function repoRoot() {
  try {
    return git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  } catch {
    return fail('目前目錄不在 git checkout 裡；請在 TeleNexus 的 repo 裡執行。');
  }
}

/** 目錄樹裡的一般檔案（相對路徑，已排序）；遇到 symlink 回傳 null。 */
function listFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return null;
    if (entry.isDirectory()) {
      const nested = listFiles(full);
      if (nested === null) return null;
      files.push(...nested.map((name) => `${entry.name}/${name}`));
    } else if (entry.isFile()) files.push(entry.name);
  }
  return files.sort();
}

/** 相對路徑 → git blob id；與 git ls-tree 的結果可以直接比對。 */
function blobMap(repo, dir, files) {
  if (files.length === 0) return new Map();
  const ids = git(repo, ['hash-object', '--no-filters', '--', ...files.map((name) => path.join(dir, name))]).trim().split('\n');
  return new Map(files.map((name, index) => [name, ids[index]]));
}

/** commit 裡 skills/<name> 的檔案（相對路徑 → blob id）。 */
function treeAt(repo, commit, name) {
  const prefix = `skills/${name}/`;
  const map = new Map();
  // -z：不加引號、不跳脫。預設輸出會替含中文或 " 的路徑加引號，那些檔案就比對不到（2026-11-12 審查 MUST FIX）。
  for (const line of git(repo, ['ls-tree', '-r', '-z', commit, '--', prefix]).split('\0')) {
    const match = /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(line);
    if (match?.[2]?.startsWith(prefix)) map.set(match[2].slice(prefix.length), match[1]);
  }
  return map;
}

function sameTree(a, b) {
  if (a.size !== b.size) return false;
  for (const [name, id] of a) if (b.get(name) !== id) return false;
  return true;
}

/** skills/<name> 曾經存在過的每個版本，由新到舊。 */
function historyOf(repo, name) {
  const commits = git(repo, ['log', '--format=%H', '--', `skills/${name}`]).split('\n').filter(Boolean);
  return commits.map((commit) => ({ commit, tree: treeAt(repo, commit, name) })).filter((version) => version.tree.size > 0);
}

function diffAgainstCurrent(repo, name, candidate) {
  try {
    git(repo, ['diff', '--no-index', '--no-color', '--', path.join(repo, 'skills', name), candidate]);
    return '';
  } catch (error) {
    // git diff --no-index 有差異時結束碼是 1，差異在 stdout。
    if (error.status === 1) return String(error.stdout);
    throw error;
  }
}

function classify(repo, skillsDir) {
  const groups = { added: [], modified: [], skipped: [] };
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith('.'));
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    const candidate = path.join(skillsDir, name);
    if (entry.isSymbolicLink()) {
      groups.skipped.push({ name, reason: 'symlink' });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const files = listFiles(candidate);
    if (files === null) {
      groups.skipped.push({ name, reason: '目錄裡含 symlink' });
      continue;
    }
    const blobs = blobMap(repo, candidate, files);
    const current = treeAt(repo, 'HEAD', name);
    const history = historyOf(repo, name);
    if (current.size > 0) {
      if (sameTree(blobs, current)) groups.skipped.push({ name, reason: '與內建相同' });
      else {
        const match = history.find((version) => sameTree(blobs, version.tree));
        if (match) {
          const short = git(repo, ['rev-parse', '--short', match.commit]).trim();
          groups.skipped.push({ name, reason: `舊版內建，未被修改（與 ${short} 相同）` });
        } else groups.modified.push({ name, diff: diffAgainstCurrent(repo, name, candidate) });
      }
    } else if (history.length > 0) groups.skipped.push({ name, reason: '已退役內建' });
    else groups.added.push({ name, files: files.length });
  }
  return groups;
}

function report(repo, skillsDir, groups) {
  const pad = Math.max(0, ...[...groups.added, ...groups.modified, ...groups.skipped].map((item) => item.name.length)) + 2;
  const lines = [`[harvest] 掃描 ${skillsDir}，比對 ${path.join(repo, 'skills')} 與它的 git 歷史`, ''];
  lines.push(`新技能（${groups.added.length}）`);
  for (const item of groups.added) lines.push(`  ${item.name.padEnd(pad)}${item.files} 個檔案`);
  lines.push('');
  lines.push(`被改過的內建技能（${groups.modified.length}）`);
  for (const item of groups.modified) {
    lines.push(`  ${item.name}`);
    lines.push(...item.diff.trimEnd().split('\n').map((line) => `    ${line}`));
  }
  lines.push('');
  lines.push(`略過（${groups.skipped.length}）`);
  for (const item of groups.skipped) lines.push(`  ${item.name.padEnd(pad)}${item.reason}`);
  console.log(lines.join('\n'));
}

// 只用來提醒的格式：常見的雲端與聊天服務 token、Telegram bot token。
// Telegram token 常接在 /bot 後面（api.telegram.org/bot<token>），前面不能用 \b（2026-11-12 審查 S1）。
const TOKEN_PATTERN = /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|xox[bp]-[A-Za-z0-9-]{10,})\b|(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/;
const LOCAL_PATH_PATTERN = /\/home\/[^/\s]+/;

/** 收進 skills/ 前要提醒的內容；只回報位置，不回傳疑似 token 本身。 */
function promoteWarnings(name, source, files) {
  const warnings = [];
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(source, 'SKILL.md'), 'utf8'));
  const declared = frontmatter && /^name:\s*(.+?)\s*$/m.exec(frontmatter[1])?.[1];
  if (declared && declared !== name) warnings.push(`SKILL.md 的 name 是 ${declared}，與目錄名 ${name} 不同`);
  for (const file of files) {
    const lines = fs.readFileSync(path.join(source, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (TOKEN_PATTERN.test(line)) warnings.push(`${file}:${index + 1} 疑似含 token`);
      if (LOCAL_PATH_PATTERN.test(line)) warnings.push(`${file}:${index + 1} 含本機絕對路徑`);
    });
  }
  return warnings;
}

function promote(repo, skillsDir, name, force) {
  // 含 .. 一律拒絕，不只整個名稱等於 ..（2026-11-13 審查 S2，使用者選 a）。
  if (name === '.' || name.includes('..') || /[/\\]/.test(name)) fail(`技能名稱不能含路徑：${name}`);
  const source = path.join(skillsDir, name);
  let stat;
  try {
    stat = fs.lstatSync(source);
  } catch {
    return fail(`workspace 沒有這個技能：${source}`);
  }
  if (stat.isSymbolicLink()) fail(`${name} 是 symlink，不收進 skills/`);
  if (!stat.isDirectory()) fail(`${name} 不是目錄`);
  const files = listFiles(source);
  if (files === null) fail(`${name} 的目錄裡含 symlink，不收進 skills/`);
  if (!files.includes('SKILL.md')) fail(`${name} 沒有 SKILL.md，不是技能`);
  const target = path.join(repo, 'skills', name);
  const exists = fs.existsSync(target);
  if (exists && !force) fail(`skills/${name} 已存在；確定要覆寫時加 --force（舊版可從 git 找回）`);

  // 先完整複製到暫存目錄再換上，複製失敗時 skills/ 不會留下一半的技能。
  const staging = fs.mkdtempSync(path.join(repo, 'skills', `.harvest-${name}-`));
  const retired = exists ? fs.mkdtempSync(path.join(repo, 'skills', `.harvest-old-${name}-`)) : null;
  try {
    fs.cpSync(source, staging, { recursive: true });
    if (retired) fs.renameSync(target, path.join(retired, name));
    fs.renameSync(staging, target);
  } catch (error) {
    if (retired && !fs.existsSync(target) && fs.existsSync(path.join(retired, name))) fs.renameSync(path.join(retired, name), target);
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    if (retired) fs.rmSync(retired, { recursive: true, force: true });
  }

  for (const warning of promoteWarnings(name, source, files)) console.warn(`[harvest] 警告：${warning}`);
  console.log(`[harvest] 已${exists ? '覆寫' : '複製'} ${source} → skills/${name}（${files.length} 個檔案）`);
  console.log('[harvest] 沒有建立 commit；commit 前請先自己檢查內容（skills/ 會隨公開 repo 與 release bundle 出貨）。');
}

const options = parseArgs(process.argv.slice(2));
const repo = repoRoot();
const workspace = options.from ? path.resolve(options.from) : path.join(repo, 'workspace');
const skillsDir = path.join(workspace, '.opencode', 'skills');
if (!fs.existsSync(skillsDir) || !fs.statSync(skillsDir).isDirectory()) fail(`找不到技能目錄：${skillsDir}`);

if (options.promote) {
  try {
    promote(repo, skillsDir, options.promote, options.force);
  } catch (error) {
    fail(`複製失敗，skills/ 維持原狀：${error instanceof Error ? error.message : String(error)}`);
  }
}
else report(repo, skillsDir, classify(repo, skillsDir));
