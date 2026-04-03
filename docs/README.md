# TeleNexus Docs Index

這份索引提供「依任務」找文件的快速入口。

建議把文件分成三層來看：

- `README.md`：專案首頁，先看定位、能力與快速上手
- `docs/README.md`：文件入口，幫你找到正確的模組文件
- 深層設計文件：只在需要維護、調整或追歷史時再深入

## 第一次看建議先讀

- 想先知道這個專案是做什麼：`README.md`
- 想快速上線或切換環境：`docs/deployment-cutover-checklist.md`
- 想理解整體記憶與長對話能力：`docs/summary-aware-retrieval-plan.md`

## 依目的閱讀

### 我想快速上手

- 專案首頁：`README.md`
- 部署與切換 checklist：`docs/deployment-cutover-checklist.md`

### 我想看 Web Console

- Web Console 詳細參考：`docs/web-console-reference.md`
- Web 規劃與演進：`docs/web-local-chat-dashboard-plan.md`
- Web UI & UX 進化總結：`docs/web-console-ux-evolution.md`

### 我想看配置與執行模式

- 環境變數與 runner/session 設定：`docs/configuration-reference.md`
- Runtime 邊界與安全模型：`docs/runtime-boundary-and-security.md`
- Prompt / session 注入改造計畫：`docs/prompt-session-injection-implementation-plan.md`
- 發版 SOP 指令流：`npm run release:patch -- -m "<commit message>"`
- 記憶健康檢查：`npm run memory:health`
- Sessions archive dry-run 回填：`npm run memory:backfill:dry-run`
- Sessions archive 寫入回填：`npm run memory:backfill:write`
- 記憶 metadata 回填：`npm run memory:backfill-summary-metadata`
- 記憶人工標記 CLI：`npm run memory:cli -- summaries`
- 核心規則記憶 seed：`npm run memory:seed-sar-anchors`

### 我想管理排程

- 排程操作手冊：`docs/scheduler-operation-runbook.md`
- chat vs scheduler 執行對照報表：`npm run report:compare:24h`

### 我想理解記憶與長對話能力

- 記憶系統實作分析報告：`docs/memory-system-analysis-2026-03-30.md`
- 長對話記憶檢索主規劃（維護者主文件）：`docs/summary-aware-retrieval-plan.md`
- Memoria 提示與 memory intent 計畫：`docs/memoria-capability-hint-and-memory-intent-plan.md`
- Sessions archive -> 長期記憶回填實作計畫：`docs/sessions-db-backfill-implementation-plan.md`
- 最小改進計畫（偏 roadmap）：`docs/sar-improvement-plan-minimal.md`
- 核心規則記憶清單（固定規則 seed）：`docs/canonical-sar-anchors.md`
- SAR 驗收清單：`docs/sar-acceptance-checklist.md`
- SAR 驗證報告（v2.6.18）：`docs/sar-validation-report-v2.6.18.md`

### 我想看架構與歷史

- Docker 重構路線：`docs/docker-refactor-roadmap.md`
- Phase 3 歷史：`docs/phase3-migration-history.md`
- 遷移紀錄（完整時序）：`docs/migration-log.md`

### 其他提案 / 研究文件

- 這一區是歷史提案或較早期草案，不建議當成現況入口。

- `docs/claude-code-leak-shell-takeaways-2026-04-01.md`
- `docs/cli-session-integration.md`
- `docs/current-chat-prompt.md`
- `docs/chat-prompt-config-proposal.md`
- `docs/memory-improvement-plan.md`
- `docs/memory-v3-architecture-plan.md`
- `docs/flow-old-vs-new.md`
- `docs/commit-split-plan.md`
