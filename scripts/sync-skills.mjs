import fs from 'fs';
import path from 'path';

const sourceDir = process.env.BUILTIN_SKILLS_DIR || '/app/skills';
const targetDirs = [
  process.env.GEMINI_SKILLS_DIR || '/app/workspace/.gemini/skills',
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

try {
  syncBuiltinSkills();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[SkillSync] Failed: ${message}`);
}
