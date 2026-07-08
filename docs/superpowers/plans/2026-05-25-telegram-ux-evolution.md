# Telegram UX 進化計畫（Tier 1 全做 + Tier 2 #8）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 借鏡 grinev/opencode-telegram-bot 的設計精神，把 moltbot-lite 從「丟訊息等回應」進化為「即時對話感」的個人助理：MarkdownV2 渲染、串流預設開啟、工具活動 Feed、`/abort`、Interaction Guard、Pinned 狀態訊息。

**Architecture:** 分六個 phase，每個 phase 獨立可發佈、可 revert。共用既有的 `event-bus` / `execution-queue` / `cli-agent-base` 基礎建設，新增 `telegram/render/`、`services/interaction-guard.ts`、`services/pinned-status-manager.ts`。`Connector` 介面新增 `pinMessage` / `unpinMessage`，並把 cancel 路徑從 `executionQueue` 一路打通到 `CliAgentBase.streamChat` 的 spawn 子程序。

**Tech Stack:** TypeScript (ESM, strict)、`node:test` + `node:assert/strict`、telegraf、SQLite (better-sqlite3)、既有的 event-bus pub/sub、`remark-parse` / `mdast-util-to-string` 用於 MarkdownV2 AST 處理。

---

## File Structure

| 路徑 | 動作 | 責任 |
|------|------|------|
| `src/telegram/render/markdown-v2.ts` | 新增 | MarkdownV2 主入口 `renderMarkdownV2(text)` |
| `src/telegram/render/escape.ts` | 新增 | MarkdownV2 字元 escape (`_*[]()~``>#+-=|{}.!`) |
| `src/telegram/render/chunker.ts` | 新增 | 4096 字元切分，code block / list 邊界保護 |
| `src/connectors/telegram.ts` | 修改 | 接 MarkdownV2 pipeline；新增 `pinMessage` / `unpinMessage` |
| `src/types/index.ts` | 修改 | `Connector` 介面加 `pinMessage` / `unpinMessage`；`sendMessage` options 加 `parseMode` |
| `src/core/execution-queue.ts` | 修改 | `enqueue(...)` 內層 fn 收 `{signal}`；新增 `cancel(userId)` |
| `src/core/process-runner.ts` | 修改 | `runProcess` 支援 `AbortSignal` |
| `src/core/cli-agent-base.ts` | 修改 | `streamChat` options 加 `signal`，spawn 收 abort 時 kill |
| `src/core/command-router.ts` | 修改 | 註冊 `/abort` 指令；在 dispatch 前 consult InteractionGuard |
| `src/core/opencode-event-parser.ts` | 修改 | `formatToolStatus` 多語意（emoji + 中文工具名） |
| `src/services/interaction-guard.ts` | 新增 | 互動狀態 in-memory store；提供 `start/transition/clear/getState` |
| `src/services/pinned-status-manager.ts` | 新增 | 訂閱 event-bus，維護釘選訊息；節流 5s |
| `src/main.ts` | 修改 | 啟動 `PinnedStatusManager`；wire `/abort` 到 ExecutionQueue.cancel |
| `tests/telegram/render-markdown-v2.test.ts` | 新增 | escape / heading / list / code block 測試 |
| `tests/telegram/render-chunker.test.ts` | 新增 | 切分邊界測試 |
| `tests/execution-queue-cancel.test.ts` | 新增 | cancel 行為與 pending 清理 |
| `tests/interaction-guard.test.ts` | 新增 | start / expire / allowedCommands |
| `tests/pinned-status-manager.test.ts` | 新增 | 訂閱與節流 |
| `tests/opencode-event-parser-tool.test.ts` | 修改 | 增加新工具狀態文字測試 |

---

# Phase 1：MarkdownV2 渲染管線

**動機：** 目前 `telegram.ts` 用簡陋的 markdown → HTML 字串替換，碰到巢狀格式或 escape 容易失敗。改用 MarkdownV2（Telegram 推薦格式）並以 `remark-parse` AST walking 取代正規式替換。

**範圍：** 只處理 heading / list / bold / italic / inline code / fenced code / link / blockquote。表格沿用現有 `normalizeMarkdownTables` 轉成 code block 或 card。

### Task 1.1：安裝 remark-parse 依賴

**Files:**
- Modify: `package.json`

- [ ] **Step 1：加上 dependency**

```bash
npm install remark-parse@^11.0.0 unified@^11.0.5 mdast-util-to-string@^4.0.0
```

- [ ] **Step 2：驗證沒破壞既有編譯**

```bash
npm run build
```
Expected: 成功，無 type error。

- [ ] **Step 3：Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add remark-parse for markdown-v2 pipeline"
```

### Task 1.2：實作 escape.ts（先寫測試）

**Files:**
- Create: `src/telegram/render/escape.ts`
- Test: `tests/telegram/render-escape.test.ts`

- [ ] **Step 1：先寫失敗測試**

```typescript
// tests/telegram/render-escape.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeMarkdownV2, escapeMarkdownV2Code } from '../../src/telegram/render/escape.js';

test('escape special chars: _*[]()~`>#+-=|{}.!', () => {
  assert.equal(
    escapeMarkdownV2('hello_world (test) 1.2!'),
    'hello\\_world \\(test\\) 1\\.2\\!'
  );
});

test('escape preserves CJK and ASCII alphanumerics', () => {
  assert.equal(escapeMarkdownV2('你好 abc 123'), '你好 abc 123');
});

test('code escape only handles ` and \\', () => {
  assert.equal(escapeMarkdownV2Code('a`b\\c'), 'a\\`b\\\\c');
});
```

- [ ] **Step 2：驗證測試失敗**

```bash
npx tsx --test tests/telegram/render-escape.test.ts
```
Expected: FAIL（檔案不存在）。

- [ ] **Step 3：實作 escape.ts**

```typescript
// src/telegram/render/escape.ts
const MD_V2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MD_V2_SPECIAL, (m) => `\\${m}`);
}

export function escapeMarkdownV2Code(text: string): string {
  return text.replace(/[`\\]/g, (m) => `\\${m}`);
}

export function escapeMarkdownV2Link(url: string): string {
  return url.replace(/[)\\]/g, (m) => `\\${m}`);
}
```

- [ ] **Step 4：驗證測試通過**

```bash
npx tsx --test tests/telegram/render-escape.test.ts
```
Expected: PASS。

- [ ] **Step 5：Commit**

```bash
git add src/telegram/render/escape.ts tests/telegram/render-escape.test.ts
git commit -m "feat(telegram/render): add markdown-v2 escape helpers"
```

### Task 1.3：實作 markdown-v2.ts（AST → MarkdownV2）

**Files:**
- Create: `src/telegram/render/markdown-v2.ts`
- Test: `tests/telegram/render-markdown-v2.test.ts`

- [ ] **Step 1：寫失敗測試（覆蓋主要 markdown 結構）**

```typescript
// tests/telegram/render-markdown-v2.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownV2 } from '../../src/telegram/render/markdown-v2.js';

test('plain paragraph escapes specials', () => {
  assert.equal(renderMarkdownV2('hello (world).'), 'hello \\(world\\)\\.');
});

test('bold via **', () => {
  assert.equal(renderMarkdownV2('see **here** now'), 'see *here* now');
});

test('italic via _', () => {
  assert.equal(renderMarkdownV2('a *b* c'), 'a _b_ c');
});

test('inline code', () => {
  assert.equal(renderMarkdownV2('use `npm run` to start'), 'use `npm run` to start');
});

test('fenced code with language', () => {
  const md = '```ts\nconst x = 1;\n```';
  const out = renderMarkdownV2(md);
  assert.ok(out.startsWith('```ts\n'));
  assert.ok(out.endsWith('\n```'));
  assert.ok(out.includes('const x \\= 1\\;') === false);
  assert.ok(out.includes('const x = 1;'));
});

test('heading -> bold line', () => {
  assert.equal(renderMarkdownV2('# Title'), '*Title*');
});

test('bullet list', () => {
  const out = renderMarkdownV2('- a\n- b');
  assert.equal(out, '• a\n• b');
});

test('link', () => {
  assert.equal(
    renderMarkdownV2('[GH](https://github.com/foo)'),
    '[GH](https://github.com/foo)'
  );
});

test('blockquote', () => {
  assert.equal(renderMarkdownV2('> quoted line'), '>quoted line');
});

test('falls back to escaped plain text on parse error', () => {
  const broken = '**unclosed';
  const out = renderMarkdownV2(broken);
  assert.ok(out.includes('unclosed'));
});
```

- [ ] **Step 2：驗證測試失敗**

```bash
npx tsx --test tests/telegram/render-markdown-v2.test.ts
```
Expected: FAIL（模組未實作）。

- [ ] **Step 3：實作 markdown-v2.ts**

```typescript
// src/telegram/render/markdown-v2.ts
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, Content, PhrasingContent } from 'mdast';
import { escapeMarkdownV2, escapeMarkdownV2Code, escapeMarkdownV2Link } from './escape.js';

const parser = unified().use(remarkParse);

export function renderMarkdownV2(input: string): string {
  try {
    const tree = parser.parse(input) as Root;
    return tree.children.map(renderBlock).filter(Boolean).join('\n\n');
  } catch {
    return escapeMarkdownV2(input);
  }
}

function renderBlock(node: Content): string {
  switch (node.type) {
    case 'heading':
      return `*${renderInlineChildren(node.children)}*`;
    case 'paragraph':
      return renderInlineChildren(node.children);
    case 'code': {
      const lang = node.lang || '';
      const safe = escapeMarkdownV2Code(node.value);
      return '```' + lang + '\n' + safe + '\n```';
    }
    case 'list': {
      const bullet = '• ';
      return node.children
        .map((item) =>
          'children' in item
            ? bullet +
              item.children
                .map((child) =>
                  child.type === 'paragraph'
                    ? renderInlineChildren(child.children)
                    : ''
                )
                .filter(Boolean)
                .join('\n')
            : ''
        )
        .join('\n');
    }
    case 'blockquote':
      return node.children
        .map((c) => {
          if (c.type === 'paragraph') {
            return '>' + renderInlineChildren(c.children);
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    case 'thematicBreak':
      return '\\-\\-\\-';
    default:
      return '';
  }
}

function renderInlineChildren(children: PhrasingContent[]): string {
  return children.map(renderInline).join('');
}

function renderInline(node: PhrasingContent): string {
  switch (node.type) {
    case 'text':
      return escapeMarkdownV2(node.value);
    case 'strong':
      return `*${renderInlineChildren(node.children)}*`;
    case 'emphasis':
      return `_${renderInlineChildren(node.children)}_`;
    case 'inlineCode':
      return '`' + escapeMarkdownV2Code(node.value) + '`';
    case 'link': {
      const label = renderInlineChildren(node.children);
      const url = escapeMarkdownV2Link(node.url);
      return `[${label}](${url})`;
    }
    case 'break':
      return '\n';
    default:
      return '';
  }
}
```

- [ ] **Step 4：驗證測試通過**

```bash
npx tsx --test tests/telegram/render-markdown-v2.test.ts
```
Expected: 全部 PASS。

- [ ] **Step 5：Commit**

```bash
git add src/telegram/render/markdown-v2.ts tests/telegram/render-markdown-v2.test.ts
git commit -m "feat(telegram/render): add markdown-v2 renderer with remark AST"
```

### Task 1.4：實作 chunker.ts（4096 切分保留格式邊界）

**Files:**
- Create: `src/telegram/render/chunker.ts`
- Test: `tests/telegram/render-chunker.test.ts`

- [ ] **Step 1：寫失敗測試**

```typescript
// tests/telegram/render-chunker.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdownV2 } from '../../src/telegram/render/chunker.js';

test('short text returns single chunk', () => {
  const chunks = chunkMarkdownV2('hello', 4096);
  assert.deepEqual(chunks, ['hello']);
});

test('splits at paragraph boundary', () => {
  const para = 'a'.repeat(2000);
  const input = `${para}\n\n${para}\n\n${para}`;
  const chunks = chunkMarkdownV2(input, 4096);
  assert.equal(chunks.length, 2);
  assert.ok(chunks[0].length <= 4096);
});

test('does not break inside fenced code block', () => {
  const code = '```\n' + 'x'.repeat(100) + '\n```';
  const filler = 'y'.repeat(4000);
  const input = `${filler}\n\n${code}`;
  const chunks = chunkMarkdownV2(input, 4096);
  for (const chunk of chunks) {
    const opens = (chunk.match(/```/g) || []).length;
    assert.equal(opens % 2, 0, 'code fences must be balanced inside a chunk');
  }
});

test('hard split a single oversized line', () => {
  const huge = 'a'.repeat(10000);
  const chunks = chunkMarkdownV2(huge, 4096);
  assert.ok(chunks.length >= 3);
  for (const c of chunks) assert.ok(c.length <= 4096);
});
```

- [ ] **Step 2：驗證測試失敗**

```bash
npx tsx --test tests/telegram/render-chunker.test.ts
```
Expected: FAIL。

- [ ] **Step 3：實作 chunker.ts**

```typescript
// src/telegram/render/chunker.ts
const CODE_FENCE = /^```/;

export function chunkMarkdownV2(text: string, limit: number = 4096): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const lines = text.split('\n');
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let openFence = false;
  let openFenceLang = '';

  const flush = () => {
    if (current.length === 0) return;
    let out = current.join('\n');
    if (openFence) {
      out += '\n```';
    }
    chunks.push(out);
    current = [];
    currentLen = 0;
    if (openFence) {
      current.push('```' + openFenceLang);
      currentLen = current[0].length + 1;
    }
  };

  for (const line of lines) {
    const fenceMatch = CODE_FENCE.exec(line);
    if (fenceMatch) {
      if (openFence) {
        openFence = false;
        openFenceLang = '';
      } else {
        openFence = true;
        openFenceLang = line.slice(3);
      }
    }

    const newLen = currentLen + (currentLen ? 1 : 0) + line.length;
    if (newLen > limit) {
      flush();
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) {
          chunks.push(line.slice(i, i + limit));
        }
        continue;
      }
    }
    current.push(line);
    currentLen += (currentLen ? 1 : 0) + line.length;
  }

  flush();
  return chunks;
}
```

- [ ] **Step 4：驗證測試通過**

```bash
npx tsx --test tests/telegram/render-chunker.test.ts
```
Expected: PASS。

- [ ] **Step 5：Commit**

```bash
git add src/telegram/render/chunker.ts tests/telegram/render-chunker.test.ts
git commit -m "feat(telegram/render): add markdown-v2 aware chunker"
```

### Task 1.5：Connector 介面與 telegram.ts 整合 MarkdownV2

**Files:**
- Modify: `src/types/index.ts:25-68`
- Modify: `src/connectors/telegram.ts`

- [ ] **Step 1：擴充 Connector 介面**

修改 `src/types/index.ts`：

```typescript
export interface Connector {
  name: string;
  initialize(): Promise<void>;

  sendMessage(
    chatId: string,
    text: string,
    options?: {
      retries?: number;
      throwOnError?: boolean;
      retryOnTimeout?: boolean;
      parseMode?: 'auto' | 'plain' | 'markdown-v2';
    }
  ): Promise<void>;

  sendFile(chatId: string, filePath: string, caption?: string): Promise<void>;

  sendPlaceholder(chatId: string, text: string): Promise<string>;

  editMessage(
    chatId: string,
    messageId: string,
    newText: string,
    options?: {
      retries?: number;
      suppressFallbackSend?: boolean;
      formatMode?: 'auto' | 'plain' | 'markdown-v2';
    }
  ): Promise<void>;

  pinMessage?(chatId: string, messageId: string): Promise<void>;
  unpinMessage?(chatId: string, messageId: string): Promise<void>;

  onMessage(handler: (msg: UnifiedMessage) => void): void;
}
```

- [ ] **Step 2：telegram.ts 接入 MarkdownV2 渲染**

修改 `src/connectors/telegram.ts` 的 `formatChunkForTelegram` 與 `sendChunk`：

```typescript
// 在 imports 區加入
import { renderMarkdownV2 } from '../telegram/render/markdown-v2.js';
import { chunkMarkdownV2 } from '../telegram/render/chunker.js';

// 在 class 內加 helper
private renderForMarkdownV2(text: string): string {
  return renderMarkdownV2(this.normalizeMarkdownTables(text));
}

// sendMessage 內判斷 parseMode
async sendMessage(
  chatId: string,
  text: string,
  options?: { retries?: number; throwOnError?: boolean; retryOnTimeout?: boolean; parseMode?: 'auto' | 'plain' | 'markdown-v2' }
): Promise<void> {
  try {
    const useMarkdownV2 = (options?.parseMode ?? 'auto') === 'markdown-v2';
    const rendered = useMarkdownV2 ? this.renderForMarkdownV2(text) : text;
    const chunks = useMarkdownV2 ? chunkMarkdownV2(rendered, 4096) : this.splitMessage(text);
    console.log(`[Telegram] Sending message chat=${chatId} chunks=${chunks.length} mode=${options?.parseMode || 'auto'}`);
    for (let i = 0; i < chunks.length; i += 1) {
      await this.sendChunkRaw(chatId, chunks[i]!, i, chunks.length, useMarkdownV2 ? 'MarkdownV2' : null, options?.retries, options?.retryOnTimeout);
    }
  } catch (error) {
    console.error(`[Telegram] Failed to send message to ${chatId}:`, error);
    recordRuntimeIssue(`telegram:sendMessage:${chatId}`, error);
    if (options?.throwOnError) throw error;
  }
}

private async sendChunkRaw(
  chatId: string,
  chunk: string,
  chunkIndex: number,
  totalChunks: number,
  parseMode: TelegramParseMode | null,
  retries?: number,
  retryOnTimeout?: boolean
) {
  const label = `sendMessage chat=${chatId} chunk=${chunkIndex + 1}/${totalChunks}`;
  const callOptions = retries !== undefined || retryOnTimeout !== undefined
    ? { ...(retries !== undefined ? { retries } : {}), ...(retryOnTimeout !== undefined ? { retryOnTimeout } : {}) }
    : undefined;
  if (!parseMode) {
    await this.callTelegram(label, () => this.bot.telegram.sendMessage(chatId, chunk), callOptions);
    return;
  }
  try {
    await this.callTelegram(label, () => this.bot.telegram.sendMessage(chatId, chunk, { parse_mode: parseMode }), callOptions);
  } catch (error) {
    if (!this.isParseModeError(error)) throw error;
    console.warn(`[Telegram] ${label} parse_mode failed, fallback to plain text.`);
    recordRuntimeIssue(`${label}:parse-mode-fallback`, error);
    await this.callTelegram(label, () => this.bot.telegram.sendMessage(chatId, chunk), callOptions);
  }
}
```

- [ ] **Step 3：editMessage 同步加入 markdown-v2 分支**

```typescript
async editMessage(
  chatId: string,
  messageId: string,
  newText: string,
  options?: { retries?: number; suppressFallbackSend?: boolean; formatMode?: 'auto' | 'plain' | 'markdown-v2' }
): Promise<void> {
  try {
    const useMarkdownV2 = options?.formatMode === 'markdown-v2';
    const rendered = useMarkdownV2 ? this.renderForMarkdownV2(newText) : newText;
    const chunks = useMarkdownV2 ? chunkMarkdownV2(rendered, 4096) : this.splitMessage(newText);
    const firstChunk = chunks[0] || '';
    const callOptions = options?.retries !== undefined ? { retries: options.retries } : undefined;

    try {
      if (useMarkdownV2) {
        await this.callTelegram(
          `editMessage chat=${chatId} message=${messageId}`,
          () => this.bot.telegram.editMessageText(chatId, parseInt(messageId, 10), undefined, firstChunk, { parse_mode: 'MarkdownV2' }),
          callOptions
        );
      } else {
        // 保留原本 auto/plain 邏輯
        const allowFormatting = chunks.length === 1;
        const formatted = options?.formatMode === 'plain'
          ? { text: firstChunk }
          : allowFormatting
            ? this.formatChunkForTelegram(firstChunk)
            : { text: firstChunk };
        if (formatted.parseMode) {
          const parseMode = formatted.parseMode;
          await this.callTelegram(
            `editMessage chat=${chatId} message=${messageId}`,
            () => this.bot.telegram.editMessageText(chatId, parseInt(messageId, 10), undefined, formatted.text, { parse_mode: parseMode }),
            callOptions
          );
        } else {
          await this.callTelegram(
            `editMessage chat=${chatId} message=${messageId}`,
            () => this.bot.telegram.editMessageText(chatId, parseInt(messageId, 10), undefined, formatted.text),
            callOptions
          );
        }
      }
    } catch (error) {
      if (!this.isParseModeError(error)) throw error;
      console.warn(`[Telegram] editMessage chat=${chatId} parse_mode failed, fallback to plain.`);
      await this.callTelegram(
        `editMessage chat=${chatId} message=${messageId}`,
        () => this.bot.telegram.editMessageText(chatId, parseInt(messageId, 10), undefined, firstChunk),
        callOptions
      );
    }

    if (chunks.length > 1) {
      for (let i = 1; i < chunks.length; i++) {
        await this.sendChunkRaw(chatId, chunks[i]!, i, chunks.length, useMarkdownV2 ? 'MarkdownV2' : null);
      }
    }
  } catch (error) {
    console.error(`[Telegram] Failed to edit message ${messageId}:`, error);
    if (!options?.suppressFallbackSend) {
      await this.sendMessage(chatId, newText, { throwOnError: true, retries: Math.max(this.apiRetryCount, 3) });
    }
  }
}
```

- [ ] **Step 4：新增 pinMessage / unpinMessage**

```typescript
async pinMessage(chatId: string, messageId: string): Promise<void> {
  await this.callTelegram(
    `pinChatMessage chat=${chatId} message=${messageId}`,
    () => this.bot.telegram.pinChatMessage(chatId, parseInt(messageId, 10), { disable_notification: true }),
    { retries: 1 }
  );
}

async unpinMessage(chatId: string, messageId: string): Promise<void> {
  await this.callTelegram(
    `unpinChatMessage chat=${chatId} message=${messageId}`,
    () => this.bot.telegram.unpinChatMessage(chatId, parseInt(messageId, 10)),
    { retries: 1 }
  );
}
```

- [ ] **Step 5：跑整體編譯與既有測試**

```bash
npm run build && npm run test
```
Expected: 全部通過（既有測試未動到 connector 行為）。

- [ ] **Step 6：Commit**

```bash
git add src/types/index.ts src/connectors/telegram.ts
git commit -m "feat(telegram): wire markdown-v2 pipeline and pin helpers into connector"
```

---

# Phase 2：串流預設開啟 + Markdown V2 整合到 finalize

**動機：** `TelegramStreamRenderer` 已成熟但 `TELEGRAM_STREAMING_ENABLED` 預設關閉。打開後，finalize 階段（完整回覆）應用 MarkdownV2 渲染，串流中間更新仍走 plain（避免半完成的 markdown 觸發 parse error）。

### Task 2.1：把串流預設打開

**Files:**
- Modify: `src/core/message-pipeline.ts:70`

- [ ] **Step 1：改預設值**

把 `src/core/message-pipeline.ts:70` 的

```typescript
const telegramStreamingEnabled = parseBool(process.env.TELEGRAM_STREAMING_ENABLED, false);
```

改為

```typescript
const telegramStreamingEnabled = parseBool(process.env.TELEGRAM_STREAMING_ENABLED, true);
```

- [ ] **Step 2：跑既有 lint / build**

```bash
npm run lint && npm run build
```
Expected: PASS。

- [ ] **Step 3：手動驗證**

啟動 `npm run dev`，在 Telegram 發一則訊息，觀察是否出現「✍️ 回覆中...」並逐步更新。確認後再進下一步。

- [ ] **Step 4：Commit**

```bash
git add src/core/message-pipeline.ts
git commit -m "feat(message-pipeline): enable telegram streaming by default"
```

### Task 2.2：finalize 階段走 MarkdownV2

**Files:**
- Modify: `src/core/telegram-stream-renderer.ts:291-326`

- [ ] **Step 1：找到 finalize 內 editMessage / sendMessage 的呼叫處**

把現有的

```typescript
await this.connector.editMessage(this.chatId, this.placeholderMsgId, resolvedText, {
  retries: 0,
  suppressFallbackSend: true
});
```

改為

```typescript
await this.connector.editMessage(this.chatId, this.placeholderMsgId, resolvedText, {
  retries: 0,
  suppressFallbackSend: true,
  formatMode: 'markdown-v2'
});
```

同檔內 `await this.connector.sendMessage(this.chatId, resolvedText, { ... })`（finalize 與 fail 中）皆改為帶 `parseMode: 'markdown-v2'`。

- [ ] **Step 2：補上若 parseMode 失敗會 fallback 的測試**

在 `tests/` 加 `tests/telegram-stream-renderer-finalize.test.ts`：

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TelegramStreamRenderer } from '../src/core/telegram-stream-renderer.js';
import type { Connector } from '../src/types/index.js';

function makeStubConnector(): Connector & { sent: string[]; edits: string[]; lastFormatMode?: string } {
  const sent: string[] = [];
  const edits: string[] = [];
  let lastFormatMode: string | undefined;
  return {
    name: 'stub',
    sent,
    edits,
    get lastFormatMode() { return lastFormatMode; },
    async initialize() {},
    async sendMessage(_chatId, text) { sent.push(text); },
    async sendFile() {},
    async sendPlaceholder() { return 'PH'; },
    async editMessage(_chat, _mid, text, opts) {
      edits.push(text);
      lastFormatMode = opts?.formatMode;
    },
    onMessage() {}
  } as unknown as Connector & { sent: string[]; edits: string[]; lastFormatMode?: string };
}

test('finalize uses markdown-v2 formatMode', async () => {
  const stub = makeStubConnector();
  const r = new TelegramStreamRenderer(stub, '123', { editThrottleMs: 0, forceFlushMs: 0 });
  await r.start();
  await r.handleEvent({ type: 'delta', text: 'hello' });
  await r.finalize('**bold**');
  assert.equal(stub.lastFormatMode, 'markdown-v2');
});
```

- [ ] **Step 3：跑測試**

```bash
npx tsx --test tests/telegram-stream-renderer-finalize.test.ts
```
Expected: PASS。

- [ ] **Step 4：Commit**

```bash
git add src/core/telegram-stream-renderer.ts tests/telegram-stream-renderer-finalize.test.ts
git commit -m "feat(stream-renderer): finalize via markdown-v2 format"
```

---

# Phase 3：工具活動 Feed 強化

**動機：** `opencode-event-parser.ts` 已會把 `tool_use` 事件轉成 `statusText`，但訊息平淡。借鏡 grinev 在訊息前加 emoji（💻 / 📖 / 🔍）讓使用者一眼看出當前動作。

### Task 3.1：增強 formatToolStatus 輸出格式

**Files:**
- Modify: `src/core/opencode-event-parser.ts:59-79`
- Test: `tests/opencode-event-parser.test.ts`（既有；新增 case）

- [ ] **Step 1：先寫測試**

在 `tests/opencode-event-parser.test.ts` 內加（若檔案不存在則新建）：

```typescript
// tests/opencode-event-parser-tool.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatToolStatus, interpretEvent } from '../src/core/opencode-event-parser.js';

test('bash gets 💻 prefix and command target', () => {
  const status = formatToolStatus('bash', { command: 'ls -la' });
  assert.ok(status?.startsWith('💻'));
  assert.ok(status?.includes('ls \\-la') || status?.includes('ls -la'));
});

test('read gets 📖 prefix and path target', () => {
  const status = formatToolStatus('read', { filePath: 'src/main.ts' });
  assert.ok(status?.startsWith('📖'));
  assert.ok(status?.includes('src/main.ts'));
});

test('grep gets 🔍 prefix and pattern target', () => {
  const status = formatToolStatus('grep', { pattern: 'TODO' });
  assert.ok(status?.startsWith('🔍'));
});

test('glob gets 📁 prefix', () => {
  const status = formatToolStatus('glob', { pattern: '**/*.ts' });
  assert.ok(status?.startsWith('📁'));
});

test('skill gets 🧩 prefix', () => {
  const status = formatToolStatus('skill', { name: 'review' });
  assert.ok(status?.startsWith('🧩'));
});

test('edit/write gets ✏️ prefix', () => {
  assert.ok(formatToolStatus('edit', { filePath: 'a.ts' })?.startsWith('✏️'));
  assert.ok(formatToolStatus('write', { filePath: 'a.ts' })?.startsWith('✏️'));
});

test('unknown tool falls back to ⚙️', () => {
  const status = formatToolStatus('weird-tool', { name: 'x' });
  assert.ok(status?.startsWith('⚙️'));
});

test('interpretEvent surfaces tool_use status', () => {
  const out = interpretEvent({
    type: 'tool_use',
    part: { tool: 'bash', state: { input: { command: 'echo hi' } } }
  });
  assert.ok(out.statusText?.startsWith('💻'));
});
```

- [ ] **Step 2：驗證測試失敗**

```bash
npx tsx --test tests/opencode-event-parser-tool.test.ts
```
Expected: FAIL（emoji 還沒加）。

- [ ] **Step 3：修改 formatToolStatus**

```typescript
// src/core/opencode-event-parser.ts:59
export function formatToolStatus(tool: string | undefined, input: unknown): string | null {
  const target = getToolTarget(input);
  const suffix = target ? `：${target}` : '';

  switch (tool) {
    case 'grep':
      return `🔍 搜尋專案${suffix}`;
    case 'glob':
      return `📁 掃描檔案${suffix}`;
    case 'read':
      return `📖 讀取${suffix}`;
    case 'bash':
      return `💻 執行指令${suffix}`;
    case 'skill':
      return `🧩 載入技能${suffix}`;
    case 'edit':
    case 'write':
      return `✏️ 編輯${suffix}`;
    case 'webfetch':
    case 'fetch':
      return `🌐 抓取網頁${suffix}`;
    case undefined:
      return null;
    default:
      return `⚙️ 使用工具 ${tool}${suffix}`;
  }
}
```

- [ ] **Step 4：驗證測試通過**

```bash
npx tsx --test tests/opencode-event-parser-tool.test.ts
```
Expected: PASS。

- [ ] **Step 5：Commit**

```bash
git add src/core/opencode-event-parser.ts tests/opencode-event-parser-tool.test.ts
git commit -m "feat(opencode-parser): emoji-prefixed tool activity status"
```

### Task 3.2：把 status 訊息節流時間調短，提升即時感

**Files:**
- Modify: `src/core/telegram-stream-renderer.ts`

- [ ] **Step 1：把 status update 節流獨立**

在 renderer 內把 `renderStatus` 用的節流從 `editThrottleMs`（預設 1000ms）改為更積極的常數（例如 600ms），確保工具切換時能即時刷新。

修改 `renderStatus` 內：

```typescript
const STATUS_MIN_INTERVAL_MS = 600;
// ...
if (now - this.lastRenderAt < STATUS_MIN_INTERVAL_MS) {
  return;
}
```

- [ ] **Step 2：跑既有 streaming 測試**

```bash
npm run test
```
Expected: 全部 PASS（既有測試不依賴具體節流值）。

- [ ] **Step 3：Commit**

```bash
git add src/core/telegram-stream-renderer.ts
git commit -m "tweak(stream-renderer): tighter throttle for tool activity status"
```

---

# Phase 4：/abort 指令與取消機制

**動機：** 排程或長任務跑到一半要中止時，現在只能等 timeout。引入 AbortSignal 讓使用者透過 `/abort` 立即終止。

### Task 4.1：process-runner 支援 AbortSignal

**Files:**
- Modify: `src/core/process-runner.ts`
- Test: `tests/process-runner-signal.test.ts`

- [ ] **Step 1：先寫測試**

```typescript
// tests/process-runner-signal.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProcess, ProcessError } from '../src/core/process-runner.js';

test('abort signal kills child and rejects with EABORTED', async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(
    runProcess('sleep', ['10'], { signal: ac.signal }),
    (err: unknown) => err instanceof ProcessError && err.code === 'EABORTED'
  );
});

test('completed-before-abort does not reject', async () => {
  const ac = new AbortController();
  const result = await runProcess('echo', ['hi'], { signal: ac.signal });
  ac.abort();
  assert.equal(result.stdout.trim(), 'hi');
});
```

- [ ] **Step 2：驗證測試失敗**

```bash
npx tsx --test tests/process-runner-signal.test.ts
```
Expected: FAIL（`signal` 還沒被支援）。

- [ ] **Step 3：修改 runProcess**

```typescript
// src/core/process-runner.ts
export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  stdin?: string;
  abortOnStderr?: { pattern: RegExp; code: string; message: string };
  signal?: AbortSignal;
};

export function runProcess(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let aborted = false;
    let settled = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGTERM');
          if (!settled) { settled = true; reject(new ProcessError('Process timed out', { code: 'ETIMEDOUT' })); }
        }, options.timeoutMs)
      : null;

    const onAbort = () => {
      if (settled) return;
      aborted = true;
      child.kill('SIGTERM');
      if (timer) clearTimeout(timer);
      settled = true;
      reject(new ProcessError('Process aborted by signal', { code: 'EABORTED', stdout, stderr }));
    };

    if (options.signal) {
      if (options.signal.aborted) {
        queueMicrotask(onAbort);
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (!aborted && !settled && options.abortOnStderr && options.abortOnStderr.pattern.test(stderr)) {
        aborted = true;
        if (timer) clearTimeout(timer);
        child.kill('SIGTERM');
        settled = true;
        reject(new ProcessError(options.abortOnStderr.message, { code: options.abortOnStderr.code, stdout, stderr }));
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      if (timer) clearTimeout(timer);
      settled = true;
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (aborted) return;
      if (signal) { reject(new ProcessError(`Process terminated with signal ${signal}`, { signal, stdout, stderr })); return; }
      if (code && code !== 0) { reject(new ProcessError(`Process exited with code ${code}`, { code, stdout, stderr })); return; }
      resolve({ stdout, stderr });
    });

    if (options.stdin && child.stdin) child.stdin.write(options.stdin);
    child.stdin?.end();
  });
}
```

- [ ] **Step 4：驗證測試通過**

```bash
npx tsx --test tests/process-runner-signal.test.ts
```
Expected: PASS。

- [ ] **Step 5：Commit**

```bash
git add src/core/process-runner.ts tests/process-runner-signal.test.ts
git commit -m "feat(process-runner): support AbortSignal cancellation"
```

### Task 4.2：ExecutionQueue 加 cancel(userId)

**Files:**
- Modify: `src/core/execution-queue.ts`
- Test: `tests/execution-queue-cancel.test.ts`

- [ ] **Step 1：寫測試**

```typescript
// tests/execution-queue-cancel.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionQueue } from '../src/core/execution-queue.js';

test('cancel rejects current task with EABORTED and aborts signal', async () => {
  const q = new ExecutionQueue();
  let observedAbort = false;
  const task = q.enqueue('u1', 'chat', 'high', async ({ signal }) => {
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { observedAbort = true; reject(new Error('aborted')); });
    });
  });
  setTimeout(() => q.cancel('u1'), 30);
  await assert.rejects(task, /aborted/);
  assert.equal(observedAbort, true);
});

test('cancel clears pending tasks', async () => {
  const q = new ExecutionQueue();
  let running = 0;
  const slow = q.enqueue('u1', 'a', 'high', async () => {
    running++;
    await new Promise((r) => setTimeout(r, 100));
    return 'slow-done';
  });
  const pending = q.enqueue('u1', 'b', 'normal', async () => 'pending-done');
  setTimeout(() => q.cancel('u1'), 20);
  await assert.rejects(slow);
  await assert.rejects(pending);
  assert.equal(running, 1);
});

test('cancel on idle user is a no-op', () => {
  const q = new ExecutionQueue();
  assert.equal(q.cancel('nobody'), false);
});
```

- [ ] **Step 2：驗證失敗**

```bash
npx tsx --test tests/execution-queue-cancel.test.ts
```
Expected: FAIL。

- [ ] **Step 3：重構 ExecutionQueue 支援 signal + cancel**

```typescript
// src/core/execution-queue.ts
type QueuePriority = 'high' | 'normal' | 'low';

type RunContext = {
  signal: AbortSignal;
};

type QueueTask<T> = {
  id: number;
  source: string;
  priority: QueuePriority;
  run: (ctx: RunContext) => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type QueueState = {
  running: boolean;
  currentSource?: string;
  currentAbort?: AbortController;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pending: QueueTask<any>[];
};

const priorityWeight: Record<QueuePriority, number> = { high: 0, normal: 1, low: 2 };

export class ExecutionQueue {
  private states = new Map<string, QueueState>();
  private seq = 0;

  getStatus(userId: string): { running: boolean; pending: number; currentSource?: string } {
    const state = this.states.get(userId);
    if (!state) return { running: false, pending: 0 };
    return { running: state.running, pending: state.pending.length, ...(state.currentSource ? { currentSource: state.currentSource } : {}) };
  }

  enqueue<T>(
    userId: string,
    source: string,
    priority: QueuePriority,
    run: (ctx: RunContext) => Promise<T>
  ): Promise<T> {
    const state = this.states.get(userId) || { running: false, pending: [] };
    this.states.set(userId, state);

    return new Promise<T>((resolve, reject) => {
      const task: QueueTask<T> = { id: ++this.seq, source, priority, run, resolve, reject };
      const tw = priorityWeight[priority];
      let lo = 0; let hi = state.pending.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const mp = priorityWeight[state.pending[mid]!.priority];
        if (mp < tw || (mp === tw && state.pending[mid]!.id <= task.id)) lo = mid + 1;
        else hi = mid;
      }
      state.pending.splice(lo, 0, task);
      this.drain(userId).catch(() => {});
    });
  }

  /**
   * 中止 userId 當前執行中的任務並清空 pending。
   * @returns true 表示有任務被中止/取消，false 表示該 user 沒任務。
   */
  cancel(userId: string): boolean {
    const state = this.states.get(userId);
    if (!state) return false;

    let touched = false;
    if (state.running && state.currentAbort) {
      state.currentAbort.abort();
      touched = true;
    }
    if (state.pending.length > 0) {
      const pending = state.pending.splice(0, state.pending.length);
      for (const task of pending) {
        task.reject(new Error(`Task cancelled by user (source=${task.source})`));
      }
      touched = true;
    }
    return touched;
  }

  private async drain(userId: string): Promise<void> {
    const state = this.states.get(userId);
    if (!state || state.running) return;
    const task = state.pending.shift();
    if (!task) return;

    state.running = true;
    state.currentSource = task.source;
    const ac = new AbortController();
    state.currentAbort = ac;
    try {
      const result = await task.run({ signal: ac.signal });
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      state.running = false;
      delete state.currentSource;
      delete state.currentAbort;
      if (state.pending.length === 0) this.states.delete(userId);
      else void this.drain(userId);
    }
  }
}

export const executionQueue = new ExecutionQueue();
```

- [ ] **Step 4：驗證測試通過**

```bash
npx tsx --test tests/execution-queue-cancel.test.ts
```
Expected: PASS。

- [ ] **Step 5：Commit**

```bash
git add src/core/execution-queue.ts tests/execution-queue-cancel.test.ts
git commit -m "feat(execution-queue): support cancel(userId) with AbortSignal"
```

### Task 4.3：CliAgentBase / Opencode 接收 signal

**Files:**
- Modify: `src/core/cli-agent-base.ts`
- Modify: `src/core/opencode.ts`
- Modify: `src/core/agent.ts`（介面）

- [ ] **Step 1：擴充 AIAgentOptions**

在 `src/core/agent.ts` 的 `AIAgentOptions` 加：

```typescript
export type AIAgentOptions = {
  model?: string;
  isPassthroughCommand?: boolean;
  forceNewSession?: boolean;
  autoRecoveryNotice?: boolean;
  signal?: AbortSignal; // 新增
};
```

- [ ] **Step 2：CliAgentBase.streamChat 接 signal 並 kill child**

修改 `src/core/cli-agent-base.ts:93` 起的 `streamChat` 內：

```typescript
async streamChat(
  prompt: string,
  options: AIAgentOptions | undefined,
  onEvent: (event: AgentEvent) => Promise<void> | void
): Promise<AgentStructuredResult> {
  // ...既有 setup...
  const child = spawn(this.config.binary, [...args, prompt], { cwd: this.getCwd(), env: this.getEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

  let externallyAborted = false;
  const onAbort = () => {
    externallyAborted = true;
    child.kill('SIGTERM');
  };
  if (options?.signal) {
    if (options.signal.aborted) {
      queueMicrotask(onAbort);
    } else {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  // ...既有 child handlers...

  // 在 child.on('close', ...) 內加入：
  // if (externallyAborted) {
  //   const aborted = buildTextOnlyStructuredResult(provider, '⏹️ 任務已被使用者中止。');
  //   if (!started) await emitStart();
  //   await onEvent({ type: 'done', text: aborted.text });
  //   resolve(aborted);
  //   return;
  // }
}
```

具體位置：`child.on('close', ...)` 內、`signal || (code && code !== 0)` 那段最開頭加：

```typescript
if (externallyAborted) {
  const abortedResult = buildTextOnlyStructuredResult(provider, '⏹️ 任務已被使用者中止。');
  if (!started) await emitStart();
  await onEvent({ type: 'done', text: abortedResult.text });
  resolve(abortedResult);
  return;
}
```

- [ ] **Step 3：opencode.ts 的非串流路徑也接 signal**

修改 `src/core/opencode.ts` 的 `executeChatProcess`：

```typescript
return runProcess('opencode', argsWithPrompt, {
  timeoutMs: getOpencodeTaskTimeoutMs(),
  cwd: workspacePath,
  env: { ...process.env },
  abortOnStderr: { /* unchanged */ },
  ...(options?.signal ? { signal: options.signal } : {})
});
```

- [ ] **Step 4：message-pipeline 把 signal 傳給 agent**

修改 `src/core/message-pipeline.ts:213-241` 區段：

```typescript
const rawResponse = await executionQueue.enqueue(userId, 'chat', 'high', async ({ signal }) => {
  const eventHandler = async (event: AgentEvent): Promise<void> => {
    if (streamResponse) await streamResponse(event);
    if (telegramStreamRenderer) await telegramStreamRenderer.handleEvent(event);
  };

  const baseOpts = {
    isPassthroughCommand: context.isPassthroughCommand,
    forceNewSession: context.forceNewSession,
    autoRecoveryNotice: true,
    signal
  };

  if ((streamResponse || telegramStreamRenderer) && context.activeAgent.streamChat) {
    const result = await context.activeAgent.streamChat(promptForAgent, baseOpts, eventHandler);
    return result.text;
  }
  return context.activeAgent.chat(promptForAgent, baseOpts);
});
```

- [ ] **Step 5：跑既有 streaming 測試**

```bash
npm run test
```
Expected: PASS。

- [ ] **Step 6：Commit**

```bash
git add src/core/agent.ts src/core/cli-agent-base.ts src/core/opencode.ts src/core/message-pipeline.ts
git commit -m "feat(agent): propagate AbortSignal from queue to child process"
```

### Task 4.4：註冊 /abort 指令

**Files:**
- Modify: `src/core/command-router.ts`（或對應的 registerDefaultCommands 區段）

- [ ] **Step 1：找到 registerDefaultCommands 並加入 /abort**

定位 `src/core/command-router.ts` 內 `registerDefaultCommands()`，加入：

```typescript
this.registerCommand({
  name: 'abort',
  match: (content) => /^\/abort(\s|$)/i.test(content),
  execute: async ({ msg, connector, userId }) => {
    const { executionQueue } = await import('./execution-queue.js');
    const ok = executionQueue.cancel(userId);
    const reply = ok ? '⏹️ 已中止當前任務並清空佇列。' : 'ℹ️ 目前沒有正在執行的任務。';
    await connector.sendMessage(msg.chatId || userId, reply);
  }
});
```

- [ ] **Step 2：加單元測試**

```typescript
// tests/command-router-abort.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRouter } from '../src/core/command-router.js';
import { executionQueue } from '../src/core/execution-queue.js';

test('/abort cancels the running task', async () => {
  const router = new CommandRouter();
  const sent: string[] = [];
  const connector = {
    name: 'stub',
    initialize: async () => {},
    sendMessage: async (_c: string, text: string) => { sent.push(text); },
    sendFile: async () => {},
    sendPlaceholder: async () => '',
    editMessage: async () => {},
    onMessage: () => {}
  };

  // 模擬正在跑
  void executionQueue.enqueue('u1', 'chat', 'high', async ({ signal }) =>
    new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('done'))))
  ).catch(() => {});

  await new Promise((r) => setTimeout(r, 10));

  await router.handleMessage(
    {
      id: '1', chatId: 'u1', content: '/abort',
      sender: { id: 'u1', name: 'x', platform: 'telegram' },
      timestamp: Date.now()
    },
    {
      connector: connector as never,
      memory: {} as never, scheduler: {} as never,
      requestNewSession: () => {}
    }
  );

  assert.ok(sent.length > 0);
  assert.ok(sent[0]!.includes('已中止'));
});
```

- [ ] **Step 3：跑測試**

```bash
npx tsx --test tests/command-router-abort.test.ts
```
Expected: PASS。

- [ ] **Step 4：Commit**

```bash
git add src/core/command-router.ts tests/command-router-abort.test.ts
git commit -m "feat(command-router): add /abort command wired to execution queue"
```

---

# Phase 5：Interaction Guard 中介層

**動機：** 目前 `/add_schedule` 等多步驟流程用 `MemoryManager` 內的臨時 state，散落各處。引入統一的 InteractionGuard：記錄當前流程、允許的指令白名單、過期時間，避免使用者中途下別的指令搞亂狀態。

### Task 5.1：實作 InteractionGuard 服務

**Files:**
- Create: `src/services/interaction-guard.ts`
- Test: `tests/interaction-guard.test.ts`

- [ ] **Step 1：寫測試**

```typescript
// tests/interaction-guard.test.ts
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
```

- [ ] **Step 2：驗證測試失敗**

```bash
npx tsx --test tests/interaction-guard.test.ts
```
Expected: FAIL。

- [ ] **Step 3：實作 interaction-guard.ts**

```typescript
// src/services/interaction-guard.ts
import { createLogger } from '../core/logger.js';

const log = createLogger('interaction-guard');

export type InteractionState = {
  kind: string;
  expectedInput: string;
  allowedCommands: string[];
  metadata: Record<string, unknown>;
  createdAt: number;
  expiresAt: number | null;
};

export type StartOptions = {
  kind: string;
  expectedInput: string;
  allowedCommands?: string[];
  metadata?: Record<string, unknown>;
  expiresInMs?: number;
};

export const DEFAULT_ALLOWED_COMMANDS = ['/help', '/status', '/abort'];

export class InteractionGuard {
  private states = new Map<string, InteractionState>();

  start(userId: string, options: StartOptions): InteractionState {
    if (this.states.has(userId)) {
      this.clear(userId, 'state_replaced');
    }
    const now = Date.now();
    const state: InteractionState = {
      kind: options.kind,
      expectedInput: options.expectedInput,
      allowedCommands: options.allowedCommands
        ? [...new Set(options.allowedCommands.map((c) => c.toLowerCase()))]
        : [...DEFAULT_ALLOWED_COMMANDS],
      metadata: options.metadata ? { ...options.metadata } : {},
      createdAt: now,
      expiresAt: typeof options.expiresInMs === 'number' ? now + options.expiresInMs : null
    };
    this.states.set(userId, state);
    log.info('start', { userId, kind: state.kind });
    return state;
  }

  getState(userId: string): InteractionState | null {
    const state = this.states.get(userId);
    if (!state) return null;
    if (state.expiresAt && Date.now() >= state.expiresAt) {
      this.states.delete(userId);
      log.info('expired', { userId, kind: state.kind });
      return null;
    }
    return state;
  }

  isCommandAllowed(userId: string, content: string): boolean {
    const state = this.getState(userId);
    if (!state) return true;
    const token = content.split(/\s+/)[0]?.toLowerCase() || '';
    return state.allowedCommands.includes(token);
  }

  clear(userId: string, reason: string): void {
    if (this.states.delete(userId)) {
      log.info('clear', { userId, reason });
    }
  }
}

export const interactionGuard = new InteractionGuard();
```

- [ ] **Step 4：驗證測試通過**

```bash
npx tsx --test tests/interaction-guard.test.ts
```
Expected: PASS。

- [ ] **Step 5：Commit**

```bash
git add src/services/interaction-guard.ts tests/interaction-guard.test.ts
git commit -m "feat(interaction-guard): add per-user interaction state service"
```

### Task 5.2：CommandRouter 諮詢 InteractionGuard

**Files:**
- Modify: `src/core/command-router.ts:48-93`

- [ ] **Step 1：在 handleMessage 中加 guard 檢查**

把 `handleMessage` 改成：

```typescript
async handleMessage(
  msg: UnifiedMessage,
  deps: {
    connector: Connector;
    memory: MemoryManager;
    scheduler: Scheduler;
    requestNewSession: (userId: string) => void;
  }
): Promise<boolean> {
  const content = msg.content.trim().replace(/[`'"]/g, '');
  const isCommand = content.startsWith('/');
  const userId = msg.sender.id;

  // 互動進行中時，只允許白名單指令
  const { interactionGuard } = await import('../services/interaction-guard.js');
  const guardState = interactionGuard.getState(userId);
  if (guardState && isCommand && !interactionGuard.isCommandAllowed(userId, content)) {
    await deps.connector.sendMessage(
      msg.chatId || userId,
      `⏳ 你目前正在「${guardState.kind}」流程中，請先完成或輸入 /abort 取消後再試。`
    );
    return true;
  }

  for (const command of this.commands) {
    if (command.match(content)) {
      await command.execute({
        msg, userId, content,
        connector: deps.connector, memory: deps.memory, scheduler: deps.scheduler,
        requestNewSession: deps.requestNewSession
      });
      return true;
    }
  }

  if (isCommand && this.isPassthroughCommand(content)) return false;

  if (isCommand) {
    await deps.connector.sendMessage(msg.sender.id, '❌ 未知指令。請使用 /start 查看可用指令列表。');
    return true;
  }

  return false;
}
```

- [ ] **Step 2：加整合測試**

```typescript
// tests/command-router-guard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRouter } from '../src/core/command-router.js';
import { interactionGuard } from '../src/services/interaction-guard.js';

function stubConnector() {
  const sent: string[] = [];
  return {
    sent,
    connector: {
      name: 'stub',
      initialize: async () => {},
      sendMessage: async (_c: string, text: string) => { sent.push(text); },
      sendFile: async () => {},
      sendPlaceholder: async () => '',
      editMessage: async () => {},
      onMessage: () => {}
    }
  };
}

test('blocks non-whitelisted command during interaction', async () => {
  interactionGuard.start('u1', { kind: 'add_schedule', expectedInput: 'time', allowedCommands: ['/abort'] });
  const { connector, sent } = stubConnector();
  const router = new CommandRouter();
  await router.handleMessage(
    { id: '1', chatId: 'u1', content: '/start', sender: { id: 'u1', name: 'x', platform: 'telegram' }, timestamp: 0 },
    { connector: connector as never, memory: {} as never, scheduler: {} as never, requestNewSession: () => {} }
  );
  assert.ok(sent[0]?.includes('add_schedule'));
  interactionGuard.clear('u1', 'test-cleanup');
});

test('allows /abort during interaction', async () => {
  interactionGuard.start('u1', { kind: 'add_schedule', expectedInput: 'time', allowedCommands: ['/abort'] });
  const { connector, sent } = stubConnector();
  const router = new CommandRouter();
  await router.handleMessage(
    { id: '1', chatId: 'u1', content: '/abort', sender: { id: 'u1', name: 'x', platform: 'telegram' }, timestamp: 0 },
    { connector: connector as never, memory: {} as never, scheduler: {} as never, requestNewSession: () => {} }
  );
  // /abort 應被 routed（沒有「正在 ... 流程」提示）
  assert.ok(!sent[0]?.includes('正在'));
  interactionGuard.clear('u1', 'test-cleanup');
});
```

- [ ] **Step 3：驗證測試通過**

```bash
npx tsx --test tests/command-router-guard.test.ts
```
Expected: PASS。

- [ ] **Step 4：Commit**

```bash
git add src/core/command-router.ts tests/command-router-guard.test.ts
git commit -m "feat(command-router): consult interaction-guard before dispatch"
```

### Task 5.3：把 /add_schedule 流程改用 InteractionGuard（範例遷移）

> **註：** 這一步是示範用法，實際遷移範圍依現有多步驟流程而定。先把 add_schedule 改了能驗證 guard 工作，其餘流程可後續批次遷移。

**Files:**
- Modify: `src/core/scheduler.ts`（或對應的 add_schedule 處理檔）

- [ ] **Step 1：定位 add_schedule 的多步驟 state 處**

```bash
grep -rn "add_schedule" src/
```
找到當前用什麼 state 儲存（很可能在 `MemoryManager` 內存或在 scheduler 內 Map）。

- [ ] **Step 2：在流程開始時呼叫 interactionGuard.start**

範例（具體欄位視原本實作調整）：

```typescript
import { interactionGuard } from '../services/interaction-guard.js';

// 在 /add_schedule 流程進入第一步時：
interactionGuard.start(userId, {
  kind: 'add_schedule',
  expectedInput: 'cron-or-natural-language',
  allowedCommands: ['/abort', '/help'],
  expiresInMs: 5 * 60 * 1000
});

// 流程完成或被 /abort 中止時：
interactionGuard.clear(userId, 'add_schedule_done');
```

- [ ] **Step 3：手動 e2e 驗證**

啟動 dev，發 `/add_schedule`，過程中試著輸入 `/start`，應收到「目前正在 add_schedule 流程中」提示。輸入 `/abort` 後流程應結束、Guard 應 clear。

- [ ] **Step 4：Commit**

```bash
git add src/core/scheduler.ts
git commit -m "refactor(scheduler): migrate add_schedule flow to interaction-guard"
```

---

# Phase 6：Pinned 狀態訊息

**動機：** 把 `workspace/context/runtime-status.md` 的精華（current model、active schedules count、recent errors、memory size）渲染成一則釘選訊息，狀態隨手可見、不用打 `/status`。

### Task 6.1：實作 PinnedStatusManager

**Files:**
- Create: `src/services/pinned-status-manager.ts`
- Test: `tests/pinned-status-manager.test.ts`

- [ ] **Step 1：寫測試**

```typescript
// tests/pinned-status-manager.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PinnedStatusManager } from '../src/services/pinned-status-manager.js';

function stubConnector() {
  const events: Array<{ op: string; payload: unknown }> = [];
  return {
    events,
    connector: {
      name: 'stub',
      initialize: async () => {},
      sendMessage: async () => {},
      sendFile: async () => {},
      sendPlaceholder: async (_c: string, text: string) => { events.push({ op: 'placeholder', payload: text }); return 'M1'; },
      editMessage: async (_c: string, _m: string, text: string) => { events.push({ op: 'edit', payload: text }); },
      onMessage: () => {},
      pinMessage: async () => { events.push({ op: 'pin', payload: null }); },
      unpinMessage: async () => { events.push({ op: 'unpin', payload: null }); }
    }
  };
}

test('initialize sends placeholder and pins it', async () => {
  const { connector, events } = stubConnector();
  const mgr = new PinnedStatusManager(connector as never, 'chat-1', { throttleMs: 0 });
  await mgr.initialize({ model: 'opus-4.7', activeSchedules: 0, recentErrors: 0, memorySize: 0 });
  assert.ok(events.some((e) => e.op === 'placeholder'));
  assert.ok(events.some((e) => e.op === 'pin'));
});

test('update is throttled', async () => {
  const { connector, events } = stubConnector();
  const mgr = new PinnedStatusManager(connector as never, 'chat-1', { throttleMs: 50 });
  await mgr.initialize({ model: 'm', activeSchedules: 0, recentErrors: 0, memorySize: 0 });
  const baseline = events.filter((e) => e.op === 'edit').length;
  for (let i = 0; i < 5; i++) {
    await mgr.update({ model: `m${i}`, activeSchedules: i, recentErrors: 0, memorySize: 0 });
  }
  // throttled：5 次連續 update 不應產生 5 次 edit
  const after = events.filter((e) => e.op === 'edit').length;
  assert.ok(after - baseline < 5);
});

test('update skips unchanged payload', async () => {
  const { connector, events } = stubConnector();
  const mgr = new PinnedStatusManager(connector as never, 'chat-1', { throttleMs: 0 });
  await mgr.initialize({ model: 'm', activeSchedules: 0, recentErrors: 0, memorySize: 0 });
  const before = events.filter((e) => e.op === 'edit').length;
  await mgr.update({ model: 'm', activeSchedules: 0, recentErrors: 0, memorySize: 0 });
  const after = events.filter((e) => e.op === 'edit').length;
  assert.equal(before, after);
});
```

- [ ] **Step 2：驗證測試失敗**

```bash
npx tsx --test tests/pinned-status-manager.test.ts
```
Expected: FAIL。

- [ ] **Step 3：實作 pinned-status-manager.ts**

```typescript
// src/services/pinned-status-manager.ts
import type { Connector } from '../types/index.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('pinned-status');

export type PinnedSnapshot = {
  model: string;
  activeSchedules: number;
  recentErrors: number;
  memorySize: number;
  lastRequestAt?: number;
};

type PinnedStatusManagerOptions = {
  throttleMs?: number;
};

export class PinnedStatusManager {
  private messageId: string | null = null;
  private lastRenderedText = '';
  private pendingSnapshot: PinnedSnapshot | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushAt = 0;
  private readonly throttleMs: number;

  constructor(
    private readonly connector: Connector,
    private readonly chatId: string,
    options: PinnedStatusManagerOptions = {}
  ) {
    this.throttleMs = options.throttleMs ?? 5000;
  }

  async initialize(snapshot: PinnedSnapshot): Promise<void> {
    const text = this.renderText(snapshot);
    this.messageId = await this.connector.sendPlaceholder(this.chatId, text);
    this.lastRenderedText = text;
    if (this.messageId && this.connector.pinMessage) {
      try {
        await this.connector.pinMessage(this.chatId, this.messageId);
      } catch (err) {
        log.warn('pin_failed', { err });
      }
    }
  }

  async update(snapshot: PinnedSnapshot): Promise<void> {
    this.pendingSnapshot = snapshot;
    const now = Date.now();
    const elapsed = now - this.lastFlushAt;
    if (this.flushTimer) return;
    if (elapsed >= this.throttleMs) {
      await this.flush();
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.throttleMs - elapsed);
  }

  private async flush(): Promise<void> {
    if (!this.pendingSnapshot || !this.messageId) return;
    const text = this.renderText(this.pendingSnapshot);
    this.pendingSnapshot = null;
    if (text === this.lastRenderedText) return;
    this.lastFlushAt = Date.now();
    try {
      await this.connector.editMessage(this.chatId, this.messageId, text, {
        retries: 0,
        suppressFallbackSend: true,
        formatMode: 'markdown-v2'
      });
      this.lastRenderedText = text;
    } catch (err) {
      log.warn('edit_failed', { err });
    }
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.messageId && this.connector.unpinMessage) {
      try {
        await this.connector.unpinMessage(this.chatId, this.messageId);
      } catch {
        // best-effort
      }
    }
    this.messageId = null;
  }

  private renderText(s: PinnedSnapshot): string {
    const lines = [
      '📌 *TeleNexus 狀態*',
      `Model: \`${s.model}\``,
      `Active schedules: ${s.activeSchedules}`,
      `Recent errors (24h): ${s.recentErrors}`,
      `Memory size: ${s.memorySize}`
    ];
    if (s.lastRequestAt) {
      const minutesAgo = Math.floor((Date.now() - s.lastRequestAt) / 60000);
      lines.push(`Last request: ${minutesAgo}m ago`);
    }
    return lines.join('\n');
  }
}
```

- [ ] **Step 4：驗證測試通過**

```bash
npx tsx --test tests/pinned-status-manager.test.ts
```
Expected: PASS。

- [ ] **Step 5：Commit**

```bash
git add src/services/pinned-status-manager.ts tests/pinned-status-manager.test.ts
git commit -m "feat(pinned-status): add manager with throttled edits and pin support"
```

### Task 6.2：在 main.ts 啟動 PinnedStatusManager 並訂閱 event-bus

**Files:**
- Modify: `src/main.ts`
- Modify: `src/services/event-bus.ts`（若 subscribe API 不存在則新增）

- [ ] **Step 1：確認 event-bus 已有 subscribe API**

```bash
grep -n "subscribe" src/services/event-bus.ts
```
Expected: 有 `subscribe` / `on` 之類的方法（CLAUDE.md 提到 in-process 訂閱）。若沒有，先在 `event-bus.ts` 加：

```typescript
type Handler = (event: { type: string; payload: unknown }) => void | Promise<void>;
const handlers: Set<Handler> = new Set();
export function subscribe(handler: Handler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}
// 在 emitEvent 內呼叫 handlers
```

- [ ] **Step 2：在 main.ts 啟動 manager 並 wire 事件**

在 `src/main.ts` 內、telegram connector 啟動後加：

```typescript
import { PinnedStatusManager } from './services/pinned-status-manager.js';
import { subscribe } from './services/event-bus.js';

const allowedChatId = process.env.ALLOWED_USER_ID;
if (allowedChatId && process.env.PINNED_STATUS_ENABLED !== 'false') {
  const pinned = new PinnedStatusManager(connector, allowedChatId);
  await pinned.initialize({
    model: aiConfig.activeModel || 'default',
    activeSchedules: scheduler.listAll().length,
    recentErrors: 0,
    memorySize: memoryManager.getStats().rowCount
  });

  const refresh = () => {
    void pinned.update({
      model: aiConfig.activeModel || 'default',
      activeSchedules: scheduler.listAll().length,
      recentErrors: getRecentIssuesCount(),
      memorySize: memoryManager.getStats().rowCount,
      lastRequestAt: Date.now()
    });
  };

  subscribe((event) => {
    if (['request_done', 'request_error', 'schedule_fire', 'runtime_issue'].includes(event.type)) {
      refresh();
    }
  });
}
```

> 注意：實際變數名要對齊現有 `main.ts` 的初始化（`scheduler` / `memoryManager` 的真實匯出）。

- [ ] **Step 3：手動 e2e**

啟動後檢查 Telegram 應出現一則「📌 TeleNexus 狀態」釘選訊息，發任一訊息或排程觸發後該訊息會更新。

- [ ] **Step 4：Commit**

```bash
git add src/main.ts src/services/event-bus.ts
git commit -m "feat(main): bootstrap pinned status manager and wire event-bus"
```

---

# 收尾

### Task 7.1：跑全測 + lint + build

- [ ] **Step 1：全測**

```bash
npm run lint && npm run build && npm run test
```
Expected: 三條全綠。

- [ ] **Step 2：手動 smoke test 流程**

1. `npm run dev` 啟動
2. Telegram 發任一訊息，觀察：
   - 出現「🤔 思考中」placeholder
   - 工具動作顯示 `💻 / 📖 / 🔍` 開頭的狀態
   - 回覆逐步串流更新
   - 結尾 finalize 為 MarkdownV2 格式
   - 釘選訊息更新最新 lastRequest
3. 發長任務 → 立刻 `/abort` → 應顯示「⏹️ 已中止」
4. 發 `/add_schedule` 開始流程 → 試 `/start` → 應被擋下；`/abort` → 流程清除

### Task 7.2：更新文件

**Files:**
- Modify: `README.md`（指令清單）
- Modify: `CLAUDE.md`（新模組簡介）

- [ ] **Step 1：README.md 補上 /abort 與 Pinned status 說明**

於 `README.md` 指令清單追加 `/abort` 行，並補一段「📌 狀態釘選訊息」說明。

- [ ] **Step 2：CLAUDE.md 模組對照表新增三列**

在 `CLAUDE.md` 的「Key Modules」表加：

```markdown
| `src/telegram/render/markdown-v2.ts`   | MarkdownV2 渲染（AST→entities），用於 streamer finalize 與 pinned message |
| `src/services/interaction-guard.ts`    | 多步驟互動的 per-user state，CommandRouter 在 dispatch 前 consult |
| `src/services/pinned-status-manager.ts` | 訂閱 event-bus 即時更新釘選訊息（節流 5s） |
```

- [ ] **Step 3：Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document /abort, pinned status, and new render modules"
```

---

## 風險與回退

| 風險 | 緩解 |
|------|------|
| MarkdownV2 escape 邊角案例失敗 → 訊息整段送不出 | `formatChunkForTelegram` 路徑有 `isParseModeError` fallback；`renderMarkdownV2` 內也用 try/catch fallback 到 escaped plain |
| 串流預設開啟後在某些網路條件下太多 editMessage 觸發 Telegram 429 | renderer 已有 `consecutiveEditFailures` 機制超過 3 次自動降級為純文字；節流參數可由 env 調整 |
| `/abort` 後 child process 沒有立即死掉（opencode 進行中的網路請求） | SIGTERM → 若 5s 仍存活可再 SIGKILL（process-runner 內 timer 既有邏輯，必要時可加 grace period） |
| InteractionGuard 與既有 add_schedule state 雙軌並存 → 互相覆蓋 | Phase 5 的遷移範圍僅 add_schedule；其餘流程後續批次遷移；上線後在 `runtime-issues` 觀察是否誤觸 |
| Pinned message 在不是私聊的群組頻道沒有權限 → API 失敗 | `pinMessage` try/catch 並 log，不影響主流程 |

每個 phase 是一個獨立 PR/feature flag，可單獨 revert：
- Phase 1：可直接刪掉 `telegram/render/` 與 import
- Phase 2：環境變數 `TELEGRAM_STREAMING_ENABLED=false` 即關閉
- Phase 3：emoji 視覺改動，回退僅需 revert 該檔
- Phase 4：環境變數可控（如需新增 `ABORT_ENABLED` flag）
- Phase 5：環境變數 `INTERACTION_GUARD_ENABLED=false` 短路 guard
- Phase 6：環境變數 `PINNED_STATUS_ENABLED=false` 即不啟動

---

## 執行順序建議

1. **先做 Phase 1**（MarkdownV2）—— 是 Phase 2/6 的基礎
2. **再做 Phase 3**（工具 Feed）—— 改動小，可獨立發
3. **接著 Phase 2**（串流預設開啟 + MarkdownV2 finalize）—— 立即看到體感提升
4. **然後 Phase 4**（/abort）—— 大改動，獨立 PR
5. **再做 Phase 5**（Interaction Guard）—— 觸及 command-router，建議單獨 PR
6. **最後 Phase 6**（Pinned status）—— 依賴所有前面組件，收尾

每個 phase 完成後手動 smoke test 至少一次 happy path + 一個錯誤路徑，再開始下一個。
