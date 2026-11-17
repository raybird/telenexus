import fs from 'fs';
import path from 'path';

// Web Console 的 public/，以及 issue 0030 模型面板的 panel-public/
const dirs = ['public', 'panel-public'];

for (const name of dirs) {
  const srcDir = path.resolve(process.cwd(), 'src', 'web', name);
  const destDir = path.resolve(process.cwd(), 'dist', 'web', name);
  if (!fs.existsSync(srcDir)) {
    console.warn(`[copy-web-assets] source not found: ${srcDir}`);
    continue;
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true, force: true });
  console.log(`[copy-web-assets] copied ${srcDir} -> ${destDir}`);
}
