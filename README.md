# land-deed-tool — 土地謄本管理工具

媽媽做土地開發／銷售用的內部工具：上傳土地謄本（電子 PDF 或照片），AI 自動解析成結構化總表（地號主檔＋共有人明細），存在雲端，兩人共用。

## 本機開發

純前端、零建置，直接用瀏覽器開 `index.html` 即可（`file://` 也能開，但登入/資料功能需要網路連到 Supabase）。

1. 複製 `config.example.js` → `config.js`，填入你自己 Supabase 專案的 `Project URL` 與 `anon public key`（Supabase Studio → Settings → API）。
2. `config.js` 已被 `.gitignore` 排除，不會進版控。

## 第一次建置 Supabase 專案的步驟

1. 到 supabase.com 開一個新專案。
2. 在 Studio 的 SQL Editor 執行 `supabase/schema.sql`（建表＋RLS＋view）。
3. 在 Studio → Storage 建立一個 **private** bucket，名稱 `deeds`，並在 Storage 的 policy 加上：
   ```sql
   create policy "deeds bucket authenticated only" on storage.objects
     for all to authenticated
     using (bucket_id = 'deeds') with check (bucket_id = 'deeds');
   ```
4. 在 Studio → Authentication → Providers 把「開放註冊」關掉，手動建立兩個帳號（媽媽＋使用者）。
5. 設定 Gemini API Key 並部署 Edge Function：
   - 到 https://aistudio.google.com 申請一組免費的 API Key（不用綁信用卡）
   - 在 Supabase Studio → Project Settings → Edge Functions → Secrets，新增 `GEMINI_API_KEY`
   - 部署方式二選一：
     - **有裝 [Supabase CLI](https://supabase.com/docs/guides/cli)**：`supabase login` → `supabase link --project-ref <你的 project ref>` → `supabase functions deploy parse-deed`
     - **沒裝 CLI（本機沒有 Node 的情況）**：在 Supabase Studio → Edge Functions 直接建立新 function，把 `supabase/functions/parse-deed/index.ts` 的內容貼進去部署

   之後如果想換成 Claude（Anthropic），只要改 `parse-deed/index.ts` 裡呼叫 API 的部分＋把 secret 換成 `ANTHROPIC_API_KEY`，前端完全不用動。

## 部署上線

跟 `linkou-crm`／`rental-mgmt` 一樣：新建一個 GitHub repo，push 到 `main` 分支，在 repo Settings → Pages 設定從 `main` 分支根目錄部署即可，沒有 CI/Actions。

## 紅線提醒

真實謄本檔案、真實地主姓名住址：**不准 commit 進這個 repo**。程式碼本身不含任何個資，真實資料都在 Supabase 後面，靠登入保護。細節見 `CLAUDE.md`。
