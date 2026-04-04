import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOpencodeJsonOutput } from '../src/core/opencode.js';

test('parseOpencodeJsonOutput collects text events and finish stats', () => {
  const result = parseOpencodeJsonOutput(
    [
      JSON.stringify({ type: 'step_start', part: { id: 'x' } }),
      JSON.stringify({ type: 'text', part: { text: 'Hello' } }),
      JSON.stringify({ type: 'text', part: { text: ' world' } }),
      JSON.stringify({
        type: 'step_finish',
        part: {
          reason: 'stop',
          tokens: { total: 10, input: 7, output: 3 },
          cost: 0
        }
      })
    ].join('\n')
  );

  assert.deepEqual(result, {
    provider: 'opencode',
    text: 'Hello world',
    raw: [
      { type: 'step_start', part: { id: 'x' } },
      { type: 'text', part: { text: 'Hello' } },
      { type: 'text', part: { text: ' world' } },
      {
        type: 'step_finish',
        part: {
          reason: 'stop',
          tokens: { total: 10, input: 7, output: 3 },
          cost: 0
        }
      }
    ],
    events: [
      { type: 'step_start', part: { id: 'x' } },
      { type: 'text', part: { text: 'Hello' } },
      { type: 'text', part: { text: ' world' } },
      {
        type: 'step_finish',
        part: {
          reason: 'stop',
          tokens: { total: 10, input: 7, output: 3 },
          cost: 0
        }
      }
    ],
    stats: {
      tokens: { total: 10, input: 7, output: 3 },
      cost: 0,
      reason: 'stop'
    }
  });
});

test('parseOpencodeJsonOutput returns null for non-json output', () => {
  assert.equal(parseOpencodeJsonOutput('plain text'), null);
});

test('parseOpencodeJsonOutput returns null when no text event exists', () => {
  assert.equal(parseOpencodeJsonOutput(JSON.stringify({ type: 'step_start' })), null);
});
