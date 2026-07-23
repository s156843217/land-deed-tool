-- land-deed-tool 資料庫 schema
-- 兩層設計：parcels（地號主檔）＋ owners（共有人明細），documents 記錄謄本原始檔
-- RLS 沿用 linkou-crm 模式：只開兩個白名單帳號、互信共用全部資料，不做 owner_id 過濾

-- profiles：登入使用者的顯示名稱（比照 linkou-crm，auth.users 新增時自動建立）
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text
);

alter table profiles enable row level security;
create policy p_profiles_select on profiles for select to authenticated using (true);
create policy p_profiles_update_self on profiles for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- 新使用者註冊時自動建立 profiles 列（本專案封閉註冊，只會手動建兩個帳號）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name) values (new.id, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- parcels：地號主檔，一個地號一列
create table parcels (
  id uuid primary key default gen_random_uuid(),
  section text not null,       -- 段小段，例如「福山段」
  lot_no text not null,        -- 地號，例如「1680」
  area_sqm numeric,            -- 總面積(㎡)
  area_ping numeric,           -- 總面積(坪)
  land_use text,               -- 地目 / 使用分區，先留空，日後可人工補
  note text,
  created_at timestamptz not null default now(),
  unique (section, lot_no)
);

alter table parcels enable row level security;
create policy p_parcels_all on parcels for all to authenticated using (true) with check (true);

-- documents：每次上傳的謄本原始檔紀錄
create table documents (
  id uuid primary key default gen_random_uuid(),
  parcel_id uuid references parcels(id) on delete set null,
  storage_path text not null,        -- Supabase Storage 'deeds' bucket 內的路徑
  original_filename text,
  uploaded_by uuid references auth.users(id),
  uploaded_at timestamptz not null default now(),
  parse_status text not null default 'pending'  -- pending / parsed / failed
);

alter table documents enable row level security;
create policy p_documents_all on documents for all to authenticated using (true) with check (true);

-- owners：共有人明細，一個共有人一列，掛在對應地號底下
-- reg_sequence（登記次序）是謄本所有權部裡每筆登記事件的流水號，同一地號內遞增且唯一，
-- 所有權換手一定會產生新號碼——拿來當「同一地號+同一登記次序=同一筆登記」的天然防重複依據，
-- 重複上傳同一份謄本會 upsert 覆蓋掉同一筆，不會產生看起來像共有人變多的假重複。
-- AI 解析不到（例如舊 Excel 匯入沒有這欄）就留 null，null 彼此不會被當作衝突，一律當新資料插入。
create table owners (
  id uuid primary key default gen_random_uuid(),
  parcel_id uuid not null references parcels(id) on delete cascade,
  document_id uuid references documents(id) on delete set null,
  reg_sequence integer,        -- 登記次序，同地號內的唯一流水號
  name text,                   -- 所有權人姓名
  address text,                -- 住址
  phone text,                  -- 聯絡電話，謄本上沒有這欄，是後續人工得知才補上的，AI 不會填這欄
  share_numerator bigint,      -- 持分分子
  share_denominator bigint,    -- 持分分母
  share_area_sqm numeric,      -- 持分面積(㎡)
  share_area_ping numeric,     -- 持分面積(坪)
  reg_date text,               -- 登記日期（原文民國年格式，例如 068/07/31，不轉換以免失真）
  reg_reason text,             -- 登記原因，例如「繼承」
  reason_date text,            -- 原因發生日期（同樣保留原文格式）
  created_at timestamptz not null default now(),
  unique (parcel_id, reg_sequence)
);

alter table owners enable row level security;
create policy p_owners_all on owners for all to authenticated using (true) with check (true);

create index idx_owners_parcel on owners(parcel_id);
create index idx_documents_parcel on documents(parcel_id);

-- parcel_overview：地號總覽用的 view（共有人數、持分面積總和），查詢頁列表用這個
-- security_invoker 讓 view 沿用查詢者本人的 RLS，而不是用建立者權限繞過 RLS
create view parcel_overview
  with (security_invoker = true)
as
select
  p.*,
  count(o.id) as owner_count,
  coalesce(sum(o.share_area_ping), 0) as total_owner_share_ping
from parcels p
left join owners o on o.parcel_id = p.id
group by p.id;

-- Storage：需另外在 Supabase Studio 建立 private bucket "deeds"，
-- 並設定 storage.objects 的 RLS policy 只允許 authenticated 存取，例如：
--   create policy "deeds bucket authenticated only" on storage.objects
--     for all to authenticated
--     using (bucket_id = 'deeds') with check (bucket_id = 'deeds');
