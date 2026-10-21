import fs from 'fs';
import path from 'path';

let cachedVersion: string | undefined;

/** TeleNexus 的版本（`package.json` 的 version），讀不到時為 `unknown`。程序執行期間不會變，只讀一次。 */
export function readAppVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const packageJsonPath = path.resolve(process.cwd(), 'package.json');
    const raw = fs.readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    cachedVersion =
      typeof parsed.version === 'string' && parsed.version.trim().length > 0
        ? parsed.version.trim()
        : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}
