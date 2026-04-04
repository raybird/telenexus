import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiJsonOutput } from '../src/core/gemini.js';

test('parseGeminiJsonOutput extracts response, session id, and stats', () => {
  const result = parseGeminiJsonOutput(
    JSON.stringify({
      session_id: 'ses-123',
      response: 'OK',
      stats: { total_tokens: 42 }
    })
  );

  assert.deepEqual(result, {
    provider: 'gemini',
    text: 'OK',
    sessionId: 'ses-123',
    stats: { total_tokens: 42 },
    raw: {
      session_id: 'ses-123',
      response: 'OK',
      stats: { total_tokens: 42 }
    }
  });
});

test('parseGeminiJsonOutput returns null for non-json text', () => {
  assert.equal(parseGeminiJsonOutput('plain text output'), null);
});

test('parseGeminiJsonOutput returns null when response field is missing', () => {
  assert.equal(parseGeminiJsonOutput(JSON.stringify({ session_id: 'ses-123' })), null);
});
