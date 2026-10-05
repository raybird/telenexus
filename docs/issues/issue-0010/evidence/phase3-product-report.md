# Phase 3 產品遷移驗證

日期：2026-10-05。T3.1／SCN-006。隔離映像 `sha256:445ce68d079d87c65a11bde4d9effcad26b2e1b6a0e2a4723a8557428cdbefb0`；[建置命令與來源雜湊](phase2-product-build-phase3-v3.json)、[原始建置輸出](phase2-product-build-phase3-v3.log)。OpenCode 1.18.34／MCP 1.10.1／Chrome 154.0.8037.92／linux amd64；非 root、init、network none、cap-drop ALL、no-new-privileges，不掛正式資料。

## 退役與安全遷移

舊套件、下載、環境變數及全域 close 移除；10 檔舊技能等位元搬至測試 fixture，不進 runtime skills。完整歷史 manifest 才可復原搬移，自訂／symlink／備份碰撞保留警告。[12 項安全遷移紅綠](phase3-skill-report.md)、[全域 close／映像紅燈](phase3-retirement-red.log)與[修正後綠燈](phase3-retirement-green.log)。本次精煉只移除自己造成的孤兒註解；其餘 no-op，保留基底 hook 契約，沒有擴大重構。

2026-10-05 的[最終映像唯讀檢查](phase3-final-image-check.json)：`/usr/local/bin/agent-browser`、`/usr/local/lib/node_modules/agent-browser` 均不存在；ripgrep 13.0.0。runtime sync-skills SHA256 `54840cb3f514a53facc027d7a96636028820b242fef650406bca015de8c93fa1`，manifest `760d8630a9d46455155b482b4eae22f0d98c43352b552685deec7979fd5f5acc` 與來源一致。

## 真實新安裝／升級與文字續接

命令為 `docker run --detach --init --network none --cap-drop ALL --security-opt no-new-privileges --memory 2g --pids-limit 1024 --user node --entrypoint node issue10-product:20261004 /probe/product-migration-contract.mjs MODE`，兩個具名容器 `issue10-migration-{fresh,legacy}-v3-20261004`，唯讀掛載本 issue evidence 至 `/probe`、repo skills 至 `/app/skills`、`git archive 04f5f2d` fixture 至 `/legacy`。名稱沿用測試窗口識別，實際執行／收集日期為 2026-10-05。

- [fresh 摘要](phase3-migration-fresh-v3-summary.json)／[完整 JSONL](phase3-migration-fresh-v3.jsonl)：同步兩次、原生 skill 讀新指引、第二回 prompt 不含 marker，真 provider 歷史仍含第一回 marker，前後 sessionID 相同。
- [legacy 摘要](phase3-migration-legacy-v3-summary.json)／[完整 JSONL](phase3-migration-legacy-v3.jsonl)：遷移前原生探索／真 skill 讀舊內建為正對照；兩次遷移後完整備份 byte-identical，原生清單有新指引及客製技能、沒有舊內建或備份路徑，文字 session 延續。
- 兩組 auth／持久 memory＋custom MCP 配置／客製技能 bytes 不變；兩個 MCP 的真工具清單保留；Chrome 啟動 0，15 秒 live／Z／root=0，收集時容器仍存活。只使用 synthetic 認證與受控 provider，不宣稱真模型自主選工具品質。

## 失敗與修正

v1 誤以工具 description 包含原生技能清單；[真診斷](phase3-migration-fresh-diagnostic.raw.log)證實固定版清單位於 system `<available_skills>`。測試改為只解析該區塊的 name/location，不以生成 AGENTS 文字代替；失敗 v1 保留，不當產品紅燈。

v2 真 skill 回傳 `ripgrep execution failed`，不是正文。2026-10-05 [回傳診斷](phase3-skill-tool-diagnostic.raw.log)、[同映像缺少／唯讀提供 ripgrep 對照](phase3-ripgrep-controls.json)證實 OpenCode 原先依賴即時下載；network none 缺少時 exit 1，提供 binary 後 exit 0 且不下載。[依賴紅燈](phase3-ripgrep-red.log)後，在共用 base apt 清單補 ripgrep。最終 v3 不掛宿主 rg，真技能／續接均通過。沒有弱化正文或技能退役斷言。

[最終專案 gate](phase3-project-gates.json)：2026-10-05 build、370 tests／0 fail、lint、installer 均 exit 0。移除舊 hook 及補依賴的內層紅燈與真 skill 故障涵蓋不同失敗面，均保留；純文件以 diff／連結查核作等價證據。正式切換、45 輪回歸及獨立 review 不由本報告冒稱完成。
