// 複製這個檔案成 config.js（會被 .gitignore 排除，不進版控），填入你自己的 Supabase 專案資訊。
// anon key 設計上可以公開（真正的權限控管靠 RLS + 登入），但仍統一走 .gitignore，
// 避免以後跟 service_role key 或其他真正需要保密的 key 搞混。
window.LAND_DEED_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "your-anon-key-here",
};
