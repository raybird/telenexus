#!/usr/bin/env node
// 假 MCP:被 opencode 啟動時在 MARKER_DIR 寫一個標記檔就結束,用來觀察 MCP 有沒有被啟動。
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.MARKER_DIR || '/probe/markers';
const name = process.argv[2] || 'mcp';
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${name}-${process.pid}`), new Date().toISOString());
