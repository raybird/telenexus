# TeleNexus Docs Index

這份索引提供「依任務」找文件的快速入口。

建議把文件分成三層來看：

- `README.md`：專案首頁，定位、核心能力與快速上手
- `CLAUDE.md`：開發者入口，模組對照表、架構說明、程式慣例
- `docs/`：深層設計文件，只在需要維護、調整或追歷史時再深入

## 維護者先看

如果你是第一次維護這個 repo，建議先看這一組：

1. `README.md`
2. `CLAUDE.md`
3. `ARCHITECTURE.md`
4. `docs/configuration-reference.md`
5. `docs/runtime-boundary-and-security.md`

## 依目的閱讀

### 我想快速上手

- 專案首頁與指令速查：`README.md`
- 架構總覽：`ARCHITECTURE.md`
- 部署與切換 checklist：`docs/deployment-cutover-checklist.md`

### 我想先看目前系統怎麼跑

- 模組對照表與程式慣例：`CLAUDE.md`
- 架構總覽：`ARCHITECTURE.md`
- 配置與 runner/session：`docs/configuration-reference.md`
- Runtime 邊界與安全模型：`docs/runtime-boundary-and-security.md`
- CLI session 與 runner 整合：`docs/cli-session-integration.md`

### 我想看 Telegram UX 功能

目前 MarkdownV2 渲染、InteractionGuard、PinnedStatusManager、`/abort` 等功能說明位於：

- 模組職責說明：`CLAUDE.md`（Key Modules 表）
- 環境變數（`PINNED_STATUS_ENABLED` 等）：`docs/configuration-reference.md`
- 串流渲染設計背景（歷史）：`docs/telegram-streaming-design.md`

### 我想看 Web Console

- Web Console 詳細參考：`docs/web-console-reference.md`

### 我想看配置與執行模式

- 環境變數與 runner/session 設定：`docs/configuration-reference.md`
- Runtime 邊界與安全模型：`docs/runtime-boundary-and-security.md`
- 目前聊天 prompt 組裝：`docs/current-chat-prompt.md`
- 模型健康檢查規劃（尚未實作）：`docs/model-health-check-plan.md`
- 發版 SOP 指令流：`npm run release:minor -- -m "<commit message>"`
- 記憶健康檢查：`npm run memory:health`
- Sessions archive dry-run 回填：`npm run memory:backfill:dry-run`
- Sessions archive 寫入回填：`npm run memory:backfill:write`
- 記憶人工標記 CLI：`npm run memory:cli -- summaries`
- 核心規則記憶 seed：`npm run memory:seed-sar-anchors`

### 我想管理排程

- 排程操作手冊：`docs/scheduler-operation-runbook.md`
- chat vs scheduler 執行對照報表：`npm run report:compare:24h`

### 我想理解記憶與長對話能力

- 長對話記憶檢索主規劃（維護者主文件）：`docs/summary-aware-retrieval-plan.md`
- 核心規則記憶清單（固定規則 seed）：`docs/canonical-sar-anchors.md`
- SAR 驗收清單：`docs/sar-acceptance-checklist.md`
- SAR 驗證報告（v2.6.18）：`docs/sar-validation-report-v2.6.18.md`

### 我想看架構與歷史

- 目前架構入口：`ARCHITECTURE.md`
- 流程演進：`docs/flow-old-vs-new.md`
- 遷移紀錄（完整時序）：`docs/migration-log.md`
- Docker 重構路線：`docs/docker-refactor-roadmap.md`
- Phase 3 歷史：`docs/phase3-migration-history.md`

---

## 歷史提案 / 研究文件

這一區是歷史提案或較早期草案，不建議當成現況入口。

- `docs/telegram-streaming-design.md` — 串流渲染設計原始提案（v2.17 已實作）
- `docs/streaming-rollout-note-2026-04-04.md` — 串流分批上線紀錄
- `docs/cli-structured-output-streaming-plan.md` — CLI 結構化輸出 / 串流規劃草案
- `docs/cli-structured-output-streaming-implementation-plan.md` — 同上，實作計畫版
- `docs/prompt-session-injection-implementation-plan.md` — Prompt/session 注入改造計畫
- `docs/web-local-chat-dashboard-plan.md` — Web Console 規劃草案
- `docs/web-console-ux-evolution.md` — Web UI & UX 進化總結
- `docs/memoria-capability-hint-and-memory-intent-plan.md` — Memoria 提示計畫
- `docs/sessions-db-backfill-implementation-plan.md` — Sessions 回填實作計畫
- `docs/memory-system-analysis-2026-03-30.md` — 記憶系統分析報告
- `docs/sar-improvement-plan-minimal.md` — SAR 最小改進計畫（偏 roadmap）
- `docs/chat-prompt-config-proposal.md` — Chat prompt 設定提案
- `docs/memory-improvement-plan.md` — 記憶改進計畫草案
- `docs/memory-v3-architecture-plan.md` — 記憶 v3 架構草案
- `docs/commit-split-plan.md` — Commit 拆分計畫
- `docs/claude-code-leak-shell-takeaways-2026-04-01.md` — 安全事件紀錄
