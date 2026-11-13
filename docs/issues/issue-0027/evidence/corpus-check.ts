// 用法：npx tsx corpus.ts <old|new> <replies.json> <out.json>
// {repo} 是本 repo 根目錄；{tmp}/old/ 放 `git show 8945e22:src/telegram/render/markdown-v2.ts` 與 escape.ts（import 改成 {repo}/node_modules 的絕對路徑）。
// replies.json：`sqlite3 -readonly -json {部署目錄}/data/moltbot.db` 取 role=model、2026-09-14 至 2026-11-13 的 id 與 content。原文與輸出都不進 repo。
import { readFileSync, writeFileSync } from 'node:fs';
import { unified } from '{repo}/node_modules/unified/index.js';
import remarkParse from '{repo}/node_modules/remark-parse/index.js';
import { TelegramConnector } from '{repo}/src/connectors/telegram.ts';
import { renderMarkdownV2 as renderOld } from '{tmp}/old/markdown-v2.ts';
import { renderMarkdownV2 as renderNew } from '{repo}/src/telegram/render/markdown-v2.ts';

const [label, inFile, outFile] = process.argv.slice(2) as [string, string, string];
const render = label === 'old' ? renderOld : renderNew;
const rows = JSON.parse(readFileSync(inFile, 'utf8')) as { id: number; content: string }[];
const conn = Object.create(TelegramConnector.prototype) as any;
const parser = unified().use(remarkParse);
const unescape = (s: string) => s.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, '$1');

function tokens(tree: any): string[] {
  const out: string[] = [];
  const visit = (n: any) => {
    for (const v of [n.value, n.alt, n.type === 'link' || n.type === 'image' ? n.url : undefined]) {
      if (typeof v === 'string') out.push(...v.split(/\s+/).filter(Boolean));
    }
    (n.children ?? []).forEach(visit);
  };
  visit(tree);
  return out;
}

function isAc6(tree: any): boolean {
  let ok = true;
  const visit = (n: any, inList: boolean) => {
    if (n.type === 'heading') ok = false;
    if (n.type === 'list') { if (n.ordered || inList) ok = false; }
    if (n.type === 'listItem' || n.type === 'blockquote') {
      for (const c of n.children) if (c.type !== 'paragraph') ok = false;
    }
    (n.children ?? []).forEach((c: any) => visit(c, inList || n.type === 'list'));
  };
  visit(tree, false);
  return ok;
}

let lossy = 0, ac6 = 0, missingTotal = 0;
const outputs: Record<string, { out: string; ac6: boolean; missing: number }> = {};
for (const r of rows) {
  const normalized = conn.normalizeMarkdownTables(r.content) as string;
  const tree = parser.parse(normalized);
  const out = render(normalized);
  const plain = unescape(out);
  const missing = tokens(tree).filter((t) => !plain.includes(t)).length;
  if (missing > 0) lossy++;
  missingTotal += missing;
  const a = isAc6(tree);
  if (a) ac6++;
  outputs[String(r.id)] = { out, ac6: a, missing };
}
writeFileSync(outFile, JSON.stringify(outputs));
console.log(JSON.stringify({ renderer: label, replies: rows.length, lossyReplies: lossy, missingTokens: missingTotal, ac6Replies: ac6 }));
