import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InteractionGuard } from '../src/services/interaction-guard.js';

test('start sets state and clears prior', () => {
  const g = new InteractionGuard();
  g.start('u1', { kind: 'add_schedule', expectedInput: 'time', allowedCommands: ['/abort'] });
  const s = g.getState('u1');
  assert.equal(s?.kind, 'add_schedule');
  assert.deepEqual(s?.allowedCommands, ['/abort']);

  g.start('u1', { kind: 'rename', expectedInput: 'title' });
  assert.equal(g.getState('u1')?.kind, 'rename');
});

test('isCommandAllowed honors allowedCommands', () => {
  const g = new InteractionGuard();
  g.start('u1', { kind: 'add_schedule', expectedInput: 'cron', allowedCommands: ['/abort', '/help'] });
  assert.equal(g.isCommandAllowed('u1', '/abort'), true);
  assert.equal(g.isCommandAllowed('u1', '/help'), true);
  assert.equal(g.isCommandAllowed('u1', '/foo'), false);
  assert.equal(g.isCommandAllowed('u2', '/foo'), true);
});

test('expiresInMs auto-clears', async () => {
  const g = new InteractionGuard();
  g.start('u1', { kind: 'k', expectedInput: 'x', expiresInMs: 30 });
  assert.ok(g.getState('u1'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(g.getState('u1'), null);
});

test('clear removes state', () => {
  const g = new InteractionGuard();
  g.start('u1', { kind: 'k', expectedInput: 'x' });
  g.clear('u1', 'done');
  assert.equal(g.getState('u1'), null);
});
