/**
 * SAR 檢索品質回歸測試
 *
 * 目的：建立本地 SAR 召回品質基準。每條測試定義「查詢 → 預期出現關鍵詞」，
 * 同時驗證跨規則隔離（查 release 不應拉出 scheduler）。
 * A2 加入 Memoria recall 後，此檔案作為本地側品質對照組持續保留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryManager } from '../src/core/memory.js';
import { buildMemoryContext } from '../src/prompt/builder.js';

// ── 測試輔助 ────────────────────────────────────────────────────────────────

export function withTempDb<T>(fn: (memory: MemoryManager) => T): T {
  const prevDbPath = process.env.DB_PATH;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sar-quality-test-'));
  const dbPath = path.join(tempDir, 'test.db');
  process.env.DB_PATH = dbPath;

  const memory = new MemoryManager();
  try {
    return fn(memory);
  } finally {
    if (prevDbPath === undefined) {
      delete process.env.DB_PATH;
    } else {
      process.env.DB_PATH = prevDbPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * 標準治理規則 fixture — 四條 impact_level=3 的 canonical anchors。
 * A2 Memoria recall 測試可 import 此函式建立相同語料集。
 */
export function seedGovernanceFixtures(memory: MemoryManager, userId: string): void {
  const fixtures = [
    {
      offsetMs: 1_000,
      content: 'Opencode recovery memory',
      summary:
        'Opencode Recovery Rule: RESOURCE_EXHAUSTED / rate-limit 則等待重試或錯開排程；' +
        'compress 失敗時改用 /compact 指令。',
      impactLevel: 3,
      tags: ['opencode', 'runner', 'memory', 'infra']
    },
    {
      offsetMs: 2_000,
      content: 'Web chat history memory',
      summary:
        'Web Chat History Rule: 採用 cursor-based loading、incremental prepend、' +
        'top-anchor scroll preserve，避免 offset pagination 與全量 re-render。',
      impactLevel: 3,
      tags: ['web', 'memory']
    },
    {
      offsetMs: 3_000,
      content: 'Release workflow memory',
      summary:
        'Release Workflow Rule: 使用 npm run release:patch -- -m <commit message>，' +
        '流程固定為 commit > npm version > tag > push，ai-config.yaml 不入版。',
      impactLevel: 3,
      tags: ['release', 'memory']
    },
    {
      offsetMs: 4_000,
      content: 'Scheduler management memory',
      summary:
        'Scheduler CLI Management Rule: 以 scheduler-cli 作為主要治理入口，' +
        '支援 list / add / update / remove / reload / health；更新後優先 HTTP reload。',
      impactLevel: 3,
      tags: ['scheduler', 'memory']
    }
  ] as const;

  const baseTs = Date.parse('2026-04-20T00:00:00Z');
  const originalNow = Date.now;
  try {
    for (const f of fixtures) {
      Date.now = () => baseTs + f.offsetMs;
      memory.addMessage(userId, 'model', f.content, {
        summary: f.summary,
        impactLevel: f.impactLevel,
        tags: [...f.tags]
      });
    }
  } finally {
    Date.now = originalNow;
  }
}

// ── 參數化測試定義 ────────────────────────────────────────────────────────────

type RecallCase = {
  name: string;
  query: string;
  mustContain: string[];
  mustNotContain?: string[];
};

const POSITIVE_CASES: RecallCase[] = [
  {
    name: 'opencode rate-limit 直接查詢',
    query: '之前 opencode 常出錯是怎麼處理的？',
    mustContain: ['Opencode Recovery Rule', 'rate-limit', 'compress', '/compact']
  },
  {
    name: 'opencode compress 別名展開',
    query: 'opencode compress 壞掉時怎麼救？',
    mustContain: ['Opencode Recovery Rule', 'compress']
  },
  {
    name: 'RESOURCE_EXHAUSTED 別名展開',
    query: 'RESOURCE_EXHAUSTED 出現時怎麼辦？',
    mustContain: ['Opencode Recovery Rule', 'RESOURCE_EXHAUSTED']
  },
  {
    name: 'release SOP 直接查詢',
    query: 'release SOP 是什麼？',
    mustContain: ['Release Workflow Rule', 'npm run release:patch']
  },
  {
    name: '發版流程別名展開',
    query: '發版流程現在怎麼走？',
    mustContain: ['Release Workflow Rule', 'npm run release:patch', 'commit > npm version > tag > push', 'ai-config.yaml 不入版']
  },
  {
    name: '發布流程別名展開',
    query: '發布流程是什麼',
    mustContain: ['Release Workflow Rule', 'npm run release:patch']
  },
  {
    name: 'scheduler CLI 直接查詢',
    query: 'scheduler CLI 現在的管理方式是什麼？',
    mustContain: ['Scheduler CLI Management Rule', 'scheduler-cli', 'reload', 'health']
  },
  {
    name: '排程管理查詢',
    query: '排程的增刪改怎麼操作？',
    mustContain: ['Scheduler CLI Management Rule', 'scheduler-cli']
  },
  {
    name: 'web chat history cursor 查詢',
    query: 'chat history 上滑載入最後怎麼修的？',
    mustContain: ['Web Chat History Rule', 'cursor-based loading', 'incremental prepend', 'top-anchor scroll preserve']
  },
  {
    name: 'web chat history offset pagination 查詢',
    query: '上滑載入為什麼不用 offset pagination？',
    mustContain: ['Web Chat History Rule', 'offset pagination']
  }
];

// 隔離測試：針對 anchor 區塊驗證排名，語意區塊允許帶入其他高信號規則
type AnchorIsolationCase = {
  name: string;
  query: string;
  anchorMustContain: string[];
  anchorMustNotContain: string[];
};

// ── 測試執行 ────────────────────────────────────────────────────────────────

for (const tc of POSITIVE_CASES) {
  test(`[SAR recall] ${tc.name}`, () => {
    withTempDb((memory) => {
      seedGovernanceFixtures(memory, 'user-a');
      const context = buildMemoryContext(memory, 'user-a', tc.query);

      for (const keyword of tc.mustContain) {
        assert.ok(
          context.includes(keyword),
          `query "${tc.query}" 應包含 "${keyword}" 但實際 context:\n${context}`
        );
      }

      for (const keyword of tc.mustNotContain ?? []) {
        assert.ok(
          !context.includes(keyword),
          `query "${tc.query}" 不應包含 "${keyword}" 但實際 context:\n${context}`
        );
      }
    });
  });
}

const ANCHOR_ISOLATION_CASES: AnchorIsolationCase[] = [
  {
    name: 'release 查詢 anchor 不含 scheduler',
    query: '發版流程現在怎麼走？',
    anchorMustContain: ['Release Workflow Rule'],
    anchorMustNotContain: ['Scheduler CLI Management Rule']
  },
  {
    name: 'scheduler 查詢 anchor 不含 release',
    query: 'scheduler-cli 怎麼用？',
    anchorMustContain: ['Scheduler CLI Management Rule'],
    anchorMustNotContain: ['Release Workflow Rule']
  },
  {
    name: 'opencode 查詢 anchor 不含 web chat',
    query: 'opencode compress 失敗怎麼辦？',
    anchorMustContain: ['Opencode Recovery Rule'],
    anchorMustNotContain: ['Web Chat History Rule']
  },
  {
    name: 'web chat 查詢 anchor 不含 opencode',
    query: 'web 聊天記錄上滑怎麼設計的？',
    anchorMustContain: ['Web Chat History Rule'],
    anchorMustNotContain: ['Opencode Recovery Rule']
  }
];

function extractAnchorSection(context: string): string {
  const start = context.indexOf('【核心決策回顧】\n');
  if (start === -1) return '';
  const after = context.slice(start + '【核心決策回顧】\n'.length);
  const end = after.indexOf('\n\n');
  return end === -1 ? after : after.slice(0, end);
}

for (const tc of ANCHOR_ISOLATION_CASES) {
  test(`[SAR isolation] ${tc.name}`, () => {
    withTempDb((memory) => {
      seedGovernanceFixtures(memory, 'user-a');
      const context = buildMemoryContext(memory, 'user-a', tc.query);
      const anchor = extractAnchorSection(context);

      for (const keyword of tc.anchorMustContain) {
        assert.ok(
          anchor.includes(keyword),
          `isolation "${tc.name}" anchor 應含 "${keyword}"，實際 anchor:\n${anchor}`
        );
      }
      for (const keyword of tc.anchorMustNotContain) {
        assert.ok(
          !anchor.includes(keyword),
          `isolation "${tc.name}" anchor 不應含 "${keyword}"，實際 anchor:\n${anchor}`
        );
      }
    });
  });
}

// ── 結構完整性測試 ────────────────────────────────────────────────────────────

test('[SAR structure] context 包含 SAR wrapper 標題', () => {
  withTempDb((memory) => {
    seedGovernanceFixtures(memory, 'user-a');
    const context = buildMemoryContext(memory, 'user-a', 'release SOP');
    assert.match(context, /^【記憶參考（TeleNexus SAR）】/);
    assert.match(context, /【核心決策回顧】/);
  });
});

test('[SAR structure] 同一規則不重複出現於不同區塊', () => {
  withTempDb((memory) => {
    seedGovernanceFixtures(memory, 'user-a');
    const context = buildMemoryContext(memory, 'user-a', 'opencode compress 失敗怎麼辦？');
    const occurrences = (context.match(/Opencode Recovery Rule/g) ?? []).length;
    assert.equal(occurrences, 1, 'anchor 不應同時出現於 anchor 與 semantic 區塊');
  });
});

test('[SAR structure] context 總長度不超過 budget 上限', () => {
  withTempDb((memory) => {
    seedGovernanceFixtures(memory, 'user-a');
    const originalNow = Date.now;
    const baseTs = Date.parse('2026-04-20T00:00:00Z');
    let ts = baseTs + 5_000;
    Date.now = () => (ts += 500);
    try {
      for (let i = 0; i < 10; i++) {
        memory.addMessage('user-a', i % 2 === 0 ? 'user' : 'model', `recent chat ${i} ${'x'.repeat(260)}`);
      }
    } finally {
      Date.now = originalNow;
    }
    const context = buildMemoryContext(memory, 'user-a', 'release SOP');
    assert.ok(context.length <= 1500, `context 長度 ${context.length} 超過 1500 字元 budget`);
  });
});

test('[SAR structure] 無相關記憶時回傳空字串', () => {
  withTempDb((memory) => {
    const context = buildMemoryContext(memory, 'user-empty', '任意查詢');
    assert.equal(context, '');
  });
});
