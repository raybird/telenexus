# 審查後續（review-fe4504b）

- **日期**：2026-10-21
- **審查**：[review-fe4504b.md](../review-fe4504b.md)，RETURN TO execute-task

| 審查項目 | 處理 |
|---|---|
| MUST FIX：測試字串與第一版驗收集的 C17 一字不差 | 換成不在評估集裡、結構相同的句子：單字虛詞「要」接在內容詞前。另外有 3 處引用了 #15 公開過的對照題原句，也都改成主題代稱。 |
| SHOULD FIX 1：清單、套用順序與「只看第一筆 snippet」沒有測試守住 | 新增 2 個測試：<br>• 比對 TS 與 `function-words.mjs` 的兩份清單，並用多字詞與單字的組合比對輸出，可以抓到順序對調；<br>• 用 2 筆 hit 驗證只看第一筆 snippet。<br>審查存活的 R2（看全部 snippet）、R3（先拿掉單字虛詞）、R6（清單少了「幾」）重跑後都轉紅。 |
| SHOULD FIX 2：已知限制少了三點 | `docs/configuration-reference.md` 補上：<br>• 只剩 1 個內容 token 的問句一律不注入；<br>• 英文的疑問詞與虛詞不會被拿掉；<br>• 門檻設為 0 時問句仍會改寫。 |
| SHOULD FIX 3：方法論的揭露 | step2「已知限制」補上兩點：<br>• 新驗收題是在知道第二版方向之後寫的；<br>• 1/17 的 95% 信賴區間。<br>「新驗收集沒有使用者抽查」是 `需決策`，請使用者決定。 |
| SHOULD FIX 4：紅綠燈沒有命令與 exit code | step3 補上「命令與 exit code」一節。 |
| NICE：`evaluate.mjs` 的雜湊和定案時不同 | step2 寫明原因（只多了一個輸出欄位）與取回定案版的命令。 |
| NICE：測試字串取自 R01、B12 的用詞 | 換成中性的詞。 |
| NICE：有 hit 但 snippet 全部空白時被記為丟棄 | 修正：snippet 全部空白時，內容 token 的條件不參與判斷，只看 confidence。注入結果不變，比對 134 題仍然一致。新增 1 個測試，把條件改回去的突變會讓它轉紅。 |
| NICE：`verify-client` 又對驗收集發了一次 recall | step4 寫明這是比對實作，不是第二次驗收。 |
| NICE：私人目錄裡的檔案權限 | 改成 600。 |

**驗證**
- 兩個目標測試檔 27/27 通過。
- 全套 `# tests 594`：原本 591，加上這次新增的 3 個。
- build 與 lint 的 exit code 都是 0。
- 重新 build 之後，以 `verify-client.mjs` 比對 134 題，不一致 0 題。

**評估集掃描**：用正規化後的字串，比對測試檔與 `memoria-recall-query.ts` 裡所有含中文的字串字面值，以及這次 diff 新增的所有行，和兩份凍結評估集的問句。
- 只剩「17 乘以 23」是 C02 的一部分。
- 它是 GitHub #19 內文已經公開的運算式，而且不是完整句子。
