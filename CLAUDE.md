# CLAUDE.md — land-deed-tool（土地謄本管理工具・媽媽專用）

> 通用守則（開工儀式、完成三級定義、紅線、commit 慣例）在全域 `~/.claude/CLAUDE.md`，先讀它。
> 這個 repo 跟 swcasa／林口置產工具箱系列（`my-project`、`linkou-toolbox` 等）**完全無關**，是獨立專案，不要混用資料夾或部署流程。

## 1. 這是什麼

媽媽從事土地開發與銷售，工作上會下載大量「土地謄本」（地政系統電子 PDF，或紙本掃描/拍照），每份謄本記載一筆地號的所有共有人資料。這個工具讓她把謄本丟上去，自動解析成結構化總表，累積存在雲端，兒子（使用者）有時候也會幫忙調閱謄本並上傳，兩人共用同一份資料。

- 使用者：只有媽媽跟使用者本人兩個帳號，封閉註冊。
- Phase 1（目前）：上傳謄本 → AI 解析 → 人工複核 → 存入總表（地號主檔＋共有人明細）＋原始檔留底。
- Phase 2（之後再做，目前未實作）：地圖模式看地號位置、接實價登錄比對建議售價。

## 2. 架構（沿用 linkou-crm／rental-mgmt 已驗證的模式）

- **純前端、零建置**：`index.html` + `app.js` + `style.css`，CDN 引入 `@supabase/supabase-js`。沒有 npm/build，`file://` 可開（但 Supabase 相關功能需要網路）。
- **後端**：Supabase（Auth + Postgres + Storage + Edge Function）。
  - Auth：Email 帳密登入，封閉註冊，只開兩個帳號。
  - DB：`parcels`（地號主檔）／`documents`（謄本原始檔紀錄）／`owners`（共有人明細，見 `supabase/schema.sql`）。
  - Storage：private bucket `deeds`，存謄本原始檔案，路徑 `{段小段}-{地號}/{timestamp}-{原始檔名}`。
  - Edge Function `parse-deed`：收謄本檔案（PDF 或圖片皆可，base64），呼叫 Google Gemini API 解析成結構化 JSON（用 Gemini 是因為使用者明確要求這塊先不要花錢，Gemini 有免費額度）。**API key 只放在 Supabase Edge Function secrets（`GEMINI_API_KEY`），前端永遠拿不到**，這是全 repo 最重要的安全規則，不要為了方便把 key 寫進前端程式碼。
  - 免費模型有輸出長度上限，謄本共有人多達數百人時（多代繼承常見）單次解析可能被截斷失敗，這是已知限制，先不處理，真的常遇到再考慮分批解析。
  - 前端 UI 文案一律用中性字眼「AI 解析」，不要寫死「Gemini」或「Claude」——之後要換模型只改 `parse-deed/index.ts` 這一個檔案，UI 文案不用跟著改，避免重蹈 `rental-mgmt` 文案跟實際模型脫鉤的覆轍。
- **部署**：GitHub 公開 repo + GitHub Pages，push `main` 自動上線（跟 linkou-crm/rental-mgmt 一致）。程式碼本身不含任何個資，真實資料都在 Supabase 後面靠登入保護。

## 3. 本 repo 專屬紅線

- **謄本檔案（PDF/照片）本身、任何真實地主姓名/住址/持分資料**：不准 commit 進 git、不准貼進任何會公開的檔案（程式碼、issue、commit 訊息皆不行）。範例/測試資料一律用虛構的段小段、地號、假姓名假地址。
- `config.js`（存 Supabase URL + anon key）：anon key 設計上可公開沒關係，但仍統一走 `.gitignore`，只 commit `config.example.js` 範本，避免將來換成別的 key 類型時搞混。
- **解析結果一律要先給使用者複核確認過才寫入資料庫**——OCR/AI 解析難免有誤，真實地主資料要求正確，不可以解析完就無條件 upsert。
- Edge Function 的 `ANTHROPIC_API_KEY` 用 `supabase secrets set` 設定，絕不寫進任何程式碼或 commit。

## 4. 資料庫 schema

見 `supabase/schema.sql`。兩層設計：
- `parcels`：一個地號一列（段小段＋地號 unique）。
- `owners`：一個共有人一列，`parcel_id` 外鍵掛在對應地號底下，`document_id` 外鍵指向來源謄本。
- `documents`：每次上傳的謄本檔案紀錄，`storage_path` 指向 Storage 裡的原始檔案。

RLS 沿用 linkou-crm 的簡單模式：兩個帳號互信，policy 寫 `using (true) for authenticated`，靠「封閉註冊、只開白名單帳號」防外人，不做 owner_id 過濾（因為就只有兩個互信的人共用全部資料）。

## 5. 登入雷（複製 linkou-crm 已踩過的坑，不要重踩）

`app.js` 的 auth 處理要維持兩個修法：
1. 只用 `onAuthStateChange`（不額外呼叫 `getSession()`），用序列化佇列＋`uid` 去重，避免同一個 session 事件被重複處理。
2. 回呼內用 `setTimeout(...,0)` 延後處理，避免跟 `signInWithPassword` 互搶 Supabase 的 Web Lock 而卡在「登入中…」。

## 6. 擴充 Phase 2 時

地圖模式、實價登錄比對建議售價，都掛在 `parcels` 表加新欄位（例如經緯度、建議售價），不要動 `owners`／`documents` 兩張表的結構。
