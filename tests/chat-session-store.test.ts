import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatSessionStore } from '../src/services/chat-session-store.js';
import { addIssueHook } from '../src/utils/errors.js';

function tempStatePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-session-'));
  return path.join(dir, 'chat-session-state.json');
}

function captureIssueScopes(): { scopes: string[]; unhook: () => void } {
  const scopes: string[] = [];
  const unhook = addIssueHook(({ scope }) => {
    scopes.push(scope);
  });
  return { scopes, unhook };
}

test('SCN-002: 狀態檔不存在時沒有綁定，也不算異常', () => {
  const { scopes, unhook } = captureIssueScopes();
  try {
    const store = new ChatSessionStore(tempStatePath());
    assert.equal(store.get('u1'), undefined);
    assert.deepEqual(scopes, []);
  } finally {
    unhook();
  }
});

test('SCN-001: 綁定寫入後重新載入仍在，各使用者互不影響', () => {
  const statePath = tempStatePath();
  const store = new ChatSessionStore(statePath);
  store.set('u1', 'ses_aaa');
  store.set('u2', 'ses_bbb');
  store.set('u1', 'ses_ccc');

  const reloaded = new ChatSessionStore(statePath);
  assert.equal(reloaded.get('u1'), 'ses_ccc');
  assert.equal(reloaded.get('u2'), 'ses_bbb');
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')), {
    u1: 'ses_ccc',
    u2: 'ses_bbb'
  });
});

test('SCN-002: clear 只清除該使用者，且寫回檔案', () => {
  const statePath = tempStatePath();
  const store = new ChatSessionStore(statePath);
  store.set('u1', 'ses_aaa');
  store.set('u2', 'ses_bbb');
  store.clear('u1');

  assert.equal(store.get('u1'), undefined);
  const reloaded = new ChatSessionStore(statePath);
  assert.equal(reloaded.get('u1'), undefined);
  assert.equal(reloaded.get('u2'), 'ses_bbb');
});

test('狀態檔毀損時視為沒有綁定，記 runtime issue，之後仍可寫入', () => {
  const statePath = tempStatePath();
  fs.writeFileSync(statePath, '{"u1": "ses_aaa"', 'utf8');
  const { scopes, unhook } = captureIssueScopes();
  try {
    const store = new ChatSessionStore(statePath);
    assert.equal(store.get('u1'), undefined);
    assert.deepEqual(scopes, ['chat-session:state-read']);

    store.set('u1', 'ses_new');
    assert.equal(new ChatSessionStore(statePath).get('u1'), 'ses_new');
  } finally {
    unhook();
  }
});

test('狀態檔內容不是物件，或值不是非空字串時忽略該筆', () => {
  const arrayPath = tempStatePath();
  fs.writeFileSync(arrayPath, '["ses_aaa"]', 'utf8');
  const { scopes, unhook } = captureIssueScopes();
  try {
    assert.equal(new ChatSessionStore(arrayPath).get('0'), undefined);
    assert.deepEqual(scopes, ['chat-session:state-read']);
  } finally {
    unhook();
  }

  const mixedPath = tempStatePath();
  fs.writeFileSync(mixedPath, '{"u1": 123, "u2": "ses_bbb", "u3": "  "}', 'utf8');
  const store = new ChatSessionStore(mixedPath);
  assert.equal(store.get('u1'), undefined);
  assert.equal(store.get('u2'), 'ses_bbb');
  assert.equal(store.get('u3'), undefined);
});

test('寫入失敗時記 runtime issue，本次行程內仍回傳新綁定', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-session-'));
  // 狀態檔路徑是一個目錄，寫入必然失敗
  const statePath = path.join(dir, 'state-as-dir');
  fs.mkdirSync(statePath);
  const { scopes, unhook } = captureIssueScopes();
  try {
    const store = new ChatSessionStore(statePath);
    scopes.length = 0;
    store.set('u1', 'ses_aaa');
    assert.equal(store.get('u1'), 'ses_aaa');
    assert.deepEqual(scopes, ['chat-session:state-write']);
  } finally {
    unhook();
  }
});
