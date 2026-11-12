import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

const retiredBrowser = JSON.parse(fs.readFileSync(new URL('./retired-agent-browser.json', import.meta.url), 'utf8'));
// 2026-11-12（issue 0024）：已出貨的舊版 web-reading，雜湊完全相同時才換成新版。
const legacyWebReading = JSON.parse(fs.readFileSync(new URL('./retired-web-reading.json', import.meta.url), 'utf8'));

const sourceDir = process.env.BUILTIN_SKILLS_DIR || '/app/skills';
// 支援多個同步目標：OPENCODE_SKILLS_DIRS (逗號分隔) 優先，
// 否則回退到單一 OPENCODE_SKILLS_DIR，最後預設專案層級。
// 第一個目標視為「主要 (專案層)」，用來產生 AGENTS.md / skills-summary 索引。
const targetDirs = (
  process.env.OPENCODE_SKILLS_DIRS ||
  process.env.OPENCODE_SKILLS_DIR ||
  '/app/workspace/.opencode/skills'
)
  .split(',')
  .map((dir) => dir.trim())
  .filter(Boolean);
const primarySkillsDir = targetDirs[0];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pathHasSymlink(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** 目錄的檔案雜湊與子目錄清單；含 symlink 或其他特殊檔案時回傳 null。 */
function scanDirectory(candidate) {
  if (pathHasSymlink(candidate)) return null;
  const files = Object.create(null);
  const directories = [];
  function scan(dir, prefix = '') {
    if (!fs.lstatSync(dir).isDirectory()) return false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const item = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        directories.push(relative);
        if (!scan(item, relative)) return false;
      } else if (entry.isFile()) {
        files[relative] = createHash('sha256').update(fs.readFileSync(item)).digest('hex');
      } else return false;
    }
    return true;
  }
  if (!scan(candidate)) return null;
  return { files, directories };
}

/** candidate 的內容是否與 manifest（files: 相對路徑→sha256、directories）完全相同。 */
function matchesManifest(candidate, manifest) {
  const scanned = scanDirectory(candidate);
  if (!scanned) return false;
  const expectedFiles = Object.keys(manifest.files).sort();
  return JSON.stringify(Object.keys(scanned.files).sort()) === JSON.stringify(expectedFiles) &&
    expectedFiles.every((name) => scanned.files[name] === manifest.files[name]) &&
    JSON.stringify(scanned.directories.sort()) === JSON.stringify([...manifest.directories].sort());
}

function matchesRetiredBrowser(candidate) {
  return matchesManifest(candidate, retiredBrowser);
}

function retireBuiltinBrowser(targetDir) {
  const candidate = path.join(targetDir, 'agent-browser');
  const backup = path.join(path.dirname(targetDir), 'retired-skills', `agent-browser-${retiredBrowser.id}`);
  function anotherWorkerFinished() {
    try {
      fs.lstatSync(candidate);
      return false;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return fs.existsSync(backup) && matchesRetiredBrowser(backup);
    }
  }
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  let matches = false;
  try {
    matches = matchesRetiredBrowser(candidate);
  } catch (error) {
    if (error.code === 'ENOENT' && anotherWorkerFinished()) return;
    throw error;
  }
  if (anotherWorkerFinished()) return;
  if (pathHasSymlink(backup) || !matches) {
    console.warn(`[SkillSync] agent-browser 無法自動遷移，已保留 ${candidate}；請人工確認自訂內容，舊瀏覽器後端不可用。`);
    return;
  }
  try {
    fs.lstatSync(backup);
    console.warn(`[SkillSync] agent-browser 備份已存在，保留 ${candidate} 與 ${backup}；舊瀏覽器後端不可用。`);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  ensureDir(path.dirname(backup));
  try {
    fs.renameSync(candidate, backup);
    console.log(`[SkillSync] Retired builtin agent-browser: ${backup}`);
  } catch (error) {
    if (error.code === 'ENOENT' && anotherWorkerFinished()) return;
    throw error;
  }
}

function isMissing(error) {
  return error.code === 'ENOENT';
}

// 只補缺少目錄的同步策略不會更新既有部署的 web-reading。workspace 的副本與已出貨的舊版
// 完全相同（沒被改過）時，先改名備份再複製新版；有客製內容、symlink 或備份已存在時原地保留並警告。
// telenexus 與 agent-runner 會同時執行本腳本，改名是兩者之間唯一的競爭點。
function upgradeBuiltinWebReading(targetDir) {
  const source = path.join(sourceDir, 'web-reading');
  const candidate = path.join(targetDir, 'web-reading');
  const backup = path.join(path.dirname(targetDir), 'retired-skills', `web-reading-${legacyWebReading.id}`);
  const current = scanDirectory(source);
  if (!current) return;
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  let matchesLegacy = false;
  try {
    if (matchesManifest(candidate, current)) return;
    matchesLegacy = matchesManifest(candidate, legacyWebReading);
  } catch (error) {
    // 另一個 worker 剛把它改名；之後的同步流程會補上新版。
    if (isMissing(error)) return;
    throw error;
  }
  if (!matchesLegacy) {
    console.warn(`[SkillSync] web-reading 有自訂內容，已保留 ${candidate}；新版網頁閱讀指引未套用，請人工比對 ${source}。`);
    return;
  }
  try {
    fs.lstatSync(backup);
    console.warn(`[SkillSync] web-reading 備份已存在，保留 ${candidate} 與 ${backup}；新版網頁閱讀指引未套用。`);
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (pathHasSymlink(path.dirname(backup))) {
    console.warn(`[SkillSync] web-reading 的備份位置含 symlink，已保留 ${candidate}；新版網頁閱讀指引未套用。`);
    return;
  }
  ensureDir(path.dirname(backup));
  try {
    fs.renameSync(candidate, backup);
  } catch (error) {
    // ENOENT：另一個 worker 已改名；ENOTEMPTY／EEXIST：另一個 worker 已完成備份。
    if (isMissing(error) || error.code === 'ENOTEMPTY' || error.code === 'EEXIST') return;
    throw error;
  }
  fs.cpSync(source, candidate, { recursive: true, force: false });
  console.log(`[SkillSync] Upgraded builtin web-reading; previous version: ${backup}`);
}

function syncBuiltinSkills() {
  targetDirs.forEach(ensureDir);
  targetDirs.forEach(retireBuiltinBrowser);
  targetDirs.forEach(upgradeBuiltinWebReading);
  if (!fs.existsSync(sourceDir)) {
    console.log(`[SkillSync] Builtin skills source not found: ${sourceDir}`);
    return;
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  let copied = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'agent-browser') continue;

    const src = path.join(sourceDir, entry.name);

    for (const targetDir of targetDirs) {
      const dst = path.join(targetDir, entry.name);

      if (fs.existsSync(dst)) {
        skipped += 1;
        continue;
      }

      fs.cpSync(src, dst, { recursive: true, force: false });
      copied += 1;
    }
  }

  console.log(
    `[SkillSync] Synced skills: copied=${copied}, skipped=${skipped}, targets=${targetDirs.join(', ')}`
  );
}

function extractFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
    // 跳過 YAML 多行語法 (|, >, |-) 或空值
    if (key && value && value !== '|' && value !== '>' && value !== '|-') fm[key] = value;
  }
  return fm;
}

// 掃描 opencode skills 目錄，自動產生 .opencode/AGENTS.md
// 讓每個新 session 都能知道有哪些 skills 以及如何使用它們
function generateOpencodeAgentsMd() {
  const opencodeSkillsDir = primarySkillsDir;
  const agentsMdPath = path.join(path.dirname(opencodeSkillsDir), 'AGENTS.md');

  if (!fs.existsSync(opencodeSkillsDir)) {
    console.log('[SkillSync] opencode skills dir not found, skipping AGENTS.md generation');
    return;
  }

  const entries = fs.readdirSync(opencodeSkillsDir, { withFileTypes: true });
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(opencodeSkillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const fm = extractFrontmatter(content);
    skills.push({
      name: fm.name || entry.name,
      description: fm.description || '',
      relativePath: `.opencode/skills/${entry.name}/SKILL.md`,
    });
  }

  if (skills.length === 0) {
    console.log('[SkillSync] No skills with SKILL.md found, skipping AGENTS.md generation');
    return;
  }

  const lines = [
    '<!-- 此文件由 sync-skills.mjs 自動生成，請勿手動編輯 -->',
    '# 可用技能索引 (Skills Index)',
    '',
    '**使用規則**：需要使用某項技能時，請先讀取對應的 SKILL.md 了解詳細操作說明，然後再執行。',
    '',
    '## 已安裝技能',
    '',
  ];

  for (const skill of skills) {
    lines.push(`### ${skill.name}`);
    if (skill.description) {
      lines.push(`- **描述**: ${skill.description}`);
    }
    lines.push(`- **說明文件**: \`${skill.relativePath}\``);
    lines.push('');
  }

  fs.writeFileSync(agentsMdPath, lines.join('\n'), 'utf-8');
  console.log(
    `[SkillSync] Generated .opencode/AGENTS.md with ${skills.length} skills: ${agentsMdPath}`
  );
}

function generateSkillsSummaryMd() {
  const opencodeSkillsDir = primarySkillsDir;
  const projectDir = process.env.APP_PROJECT_DIR || process.cwd();
  const contextDir = path.join(projectDir, 'workspace', 'context');
  const summaryPath = path.join(contextDir, 'skills-summary.md');

  if (!fs.existsSync(opencodeSkillsDir)) {
    console.log('[SkillSync] opencode skills dir not found, skipping skills-summary.md generation');
    return;
  }

  const entries = fs.readdirSync(opencodeSkillsDir, { withFileTypes: true });
  const lines = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillMdPath = path.join(opencodeSkillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) continue;

    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const fm = extractFrontmatter(content);
    const name = fm.name || entry.name;
    const description = fm.description || '';
    lines.push(description ? `- ${name}: ${description}` : `- ${name}`);
  }

  if (lines.length === 0) {
    console.log('[SkillSync] No skills found, skipping skills-summary.md generation');
    return;
  }

  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(summaryPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`[SkillSync] Generated skills-summary.md with ${lines.length} skills: ${summaryPath}`);
}

try {
  syncBuiltinSkills();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[SkillSync] Failed: ${message}`);
}

try {
  generateOpencodeAgentsMd();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[SkillSync] AGENTS.md generation failed: ${message}`);
}

try {
  generateSkillsSummaryMd();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[SkillSync] skills-summary.md generation failed: ${message}`);
}
