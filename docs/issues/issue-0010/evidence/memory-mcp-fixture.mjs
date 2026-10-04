import { createInterface } from 'node:readline';

// 2026-10-04：測試設定合併用的假 memory MCP；不連正式 Memoria、不讀寫記憶。
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'memory-merge-fixture', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'merge_sentinel', description: 'Issue 10 existing MCP merge sentinel', inputSchema: { type: 'object', properties: {} } }] };
  else result = { content: [{ type: 'text', text: 'MEMORY_MERGE_SENTINEL' }] };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
