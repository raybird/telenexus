import fs from 'fs';
import path from 'path';

const sourceDir = process.env.BUILTIN_SKILLS_DIR || '/app/skills';
const targetDirs = [
  process.env.OPENCODE_SKILLS_DIR || '/app/workspace/.opencode/skills'
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function syncBuiltinSkills() {
  if (!fs.existsSync(sourceDir)) {
    console.log(`[SkillSync] Builtin skills source not found: ${sourceDir}`);
    return;
  }

  targetDirs.forEach(ensureDir);

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  let copied = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

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
  const opencodeSkillsDir = process.env.OPENCODE_SKILLS_DIR || '/app/workspace/.opencode/skills';
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
