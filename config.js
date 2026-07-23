// Supabase 專案連線資訊。這兩個值設計上就是給前端瀏覽器用的，可以進版控、部署到 GitHub Pages，
// 真正的權限控管靠資料表 RLS + 登入，真正機密的 GEMINI_API_KEY 另外只放在 Supabase 後端。
window.LAND_DEED_CONFIG = {
  SUPABASE_URL: "https://ryjsjavdmdljntmzjoyl.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_5PQaOD5bBIOhJ3E5_XHx5A_SjGFZwzC",
};
