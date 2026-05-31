import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatToolStatus, interpretEvent } from '../src/core/opencode-event-parser.js';

test('bash gets 💻 prefix and command target', () => {
  const status = formatToolStatus('bash', { command: 'ls -la' });
  assert.ok(status?.startsWith('💻'), `expected 💻, got: ${status}`);
  assert.ok(status?.includes('ls -la') || status?.includes('ls \\-la'));
});

test('read gets 📖 prefix and path target', () => {
  const status = formatToolStatus('read', { filePath: 'src/main.ts' });
  assert.ok(status?.startsWith('📖'), `expected 📖, got: ${status}`);
  assert.ok(status?.includes('src/main.ts'));
});

test('grep gets 🔍 prefix and pattern target', () => {
  const status = formatToolStatus('grep', { pattern: 'TODO' });
  assert.ok(status?.startsWith('🔍'), `expected 🔍, got: ${status}`);
});

test('glob gets 📁 prefix', () => {
  const status = formatToolStatus('glob', { pattern: '**/*.ts' });
  assert.ok(status?.startsWith('📁'), `expected 📁, got: ${status}`);
});

test('skill gets 🧩 prefix', () => {
  const status = formatToolStatus('skill', { name: 'review' });
  assert.ok(status?.startsWith('🧩'), `expected 🧩, got: ${status}`);
});

test('edit gets ✏️ prefix', () => {
  assert.ok(formatToolStatus('edit', { filePath: 'a.ts' })?.startsWith('✏️'));
});

test('write gets ✏️ prefix', () => {
  assert.ok(formatToolStatus('write', { filePath: 'a.ts' })?.startsWith('✏️'));
});

test('unknown tool falls back to ⚙️', () => {
  const status = formatToolStatus('weird-tool', { name: 'x' });
  assert.ok(status?.startsWith('⚙️'), `expected ⚙️, got: ${status}`);
});

test('interpretEvent surfaces tool_use status with emoji', () => {
  const out = interpretEvent({
    type: 'tool_use',
    part: { tool: 'bash', state: { input: { command: 'echo hi' } } }
  });
  assert.ok(out.statusText?.startsWith('💻'), `expected 💻, got: ${out.statusText}`);
});
