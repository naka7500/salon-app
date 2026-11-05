-- v1.2：カルテの手書き（複数ページ・背景画像つき）と、画像の保存先（Supabase Storage の非公開バケット karte）。
-- ※必ず 0009_options_pair.sql の後に流すこと（0009 が無いと最初で止まります。DBは何も変わりません）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists / on conflict）。
-- 0010 が未適用でもアプリは落ちない（手書きは今までどおり「画像1枚」で保存され、背景テンプレの設定は「準備中」になる）。
--
-- やること
--  1) karte_backgrounds：カルテの背景テンプレ（会社ごと・店舗を絞ることもできる）。書き込みは owner・manager だけ
--  2) karte_pages：カルテ1件の手書きページ（線のデータ＝あとで書き直せる／表示・印刷用の画像のパス／背景／背景の濃さ）
--  3) Storage：非公開バケット karte。パスは「<会社ID>/karte/<カルテID>/…」「<会社ID>/templates/…」
--     読み書きできるのは、その会社のスタッフ（ログイン中）だけ。templates/ への書き込みは owner・manager だけ
--     表示は期限つきURL（署名URL）で行う。公開URLでは見られない
--  4) 未ログイン（anon）からは触れない

do $$ begin
  if to_regclass('public.option_groups') is null then
    raise exception '0009 がまだ流れていません。先に 0009_options_pair.sql を流してから、この 0010 を流してください';
  end if;
  if to_regprocedure('public.my_role_in_company(uuid)') is null then
    raise exception '0008 がまだ流れていません。0008 → 0009 → 0010 の順に流してください';
  end if;
end $$;

-- =========================================================
-- 1) 背景テンプレ
-- =========================================================
create table if not exists karte_backgrounds (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  store_id uuid references stores(id) on delete cascade,      -- null＝会社の全店舗で使う
  name text not null,
  image_path text,                                             -- Storage のパス（<会社ID>/templates/…）
  builtin_key text,                                            -- 標準の背景（アプリに入っている線画）の表示・非表示の設定に使う
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table karte_backgrounds drop constraint if exists karte_backgrounds_src_check;
alter table karte_backgrounds add constraint karte_backgrounds_src_check check (image_path is not null or builtin_key is not null);
alter table karte_backgrounds drop constraint if exists karte_backgrounds_name_check;
alter table karte_backgrounds add constraint karte_backgrounds_name_check check (length(btrim(name)) between 1 and 40);
alter table karte_backgrounds drop constraint if exists karte_backgrounds_path_check;
alter table karte_backgrounds add constraint karte_backgrounds_path_check check (image_path is null or image_path like company_id::text || '/templates/%');
create index if not exists karte_backgrounds_company_idx on karte_backgrounds (company_id, sort_order);
create unique index if not exists karte_backgrounds_builtin_uq on karte_backgrounds (company_id, builtin_key) where builtin_key is not null;

-- =========================================================
-- 2) 手書きページ
-- =========================================================
create table if not exists karte_pages (
  id uuid primary key default gen_random_uuid(),
  karte_entry_id uuid not null references karte_entries(id) on delete cascade,
  page_no int not null default 1,
  strokes jsonb not null default '{"v":1,"w":1414,"h":1000,"items":[]}',   -- 線のデータ（ベクター）
  png_path text,                                                           -- 背景＋手書きを1枚にした画像（表示・印刷用。写真背景のときは JPEG）
  background_path text,                                                    -- 写真の背景（Storage のパス）
  background_template_id uuid references karte_backgrounds(id) on delete set null,
  background_builtin text,                                                 -- 標準の背景のキー（eyelash-eyes など）
  background_opacity numeric(3,2) not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table karte_pages drop constraint if exists karte_pages_opacity_check;
alter table karte_pages add constraint karte_pages_opacity_check check (background_opacity between 0.05 and 1);
alter table karte_pages drop constraint if exists karte_pages_page_no_check;
alter table karte_pages add constraint karte_pages_page_no_check check (page_no between 1 and 50);
create index if not exists karte_pages_entry_idx on karte_pages (karte_entry_id, page_no);

-- =========================================================
-- 3) RLS（今までの表と同じ：その会社のスタッフだけ。背景テンプレの書き込みは owner・manager）
-- =========================================================
alter table karte_backgrounds enable row level security;
alter table karte_pages enable row level security;

drop policy if exists karte_backgrounds_read on karte_backgrounds;
create policy karte_backgrounds_read on karte_backgrounds for select
  using (company_id in (select my_company_ids()));
drop policy if exists karte_backgrounds_insert on karte_backgrounds;
create policy karte_backgrounds_insert on karte_backgrounds for insert
  with check (coalesce(my_role_in_company(company_id) in ('owner', 'manager'), false)
              and (store_id is null or store_id in (select s.id from stores s where s.company_id = karte_backgrounds.company_id)));
drop policy if exists karte_backgrounds_update on karte_backgrounds;
create policy karte_backgrounds_update on karte_backgrounds for update
  using (coalesce(my_role_in_company(company_id) in ('owner', 'manager'), false))
  with check (coalesce(my_role_in_company(company_id) in ('owner', 'manager'), false)
              and (store_id is null or store_id in (select s.id from stores s where s.company_id = karte_backgrounds.company_id)));
drop policy if exists karte_backgrounds_delete on karte_backgrounds;
create policy karte_backgrounds_delete on karte_backgrounds for delete
  using (coalesce(my_role_in_company(company_id) in ('owner', 'manager'), false));

drop policy if exists karte_pages_rw on karte_pages;
create policy karte_pages_rw on karte_pages for all
  using (karte_entry_id in (select k.id from karte_entries k where k.store_id in (select st.id from stores st where st.company_id in (select my_company_ids()))))
  with check (karte_entry_id in (select k.id from karte_entries k where k.store_id in (select st.id from stores st where st.company_id in (select my_company_ids()))));

revoke all on karte_backgrounds, karte_pages from anon;
grant select, insert, update, delete on karte_backgrounds, karte_pages to authenticated;

-- =========================================================
-- 4) Storage（非公開バケット karte と、パスごとの権限）
-- =========================================================
-- パスの1つ目＝会社ID、2つ目＝karte か templates。ログイン中の人がその会社のスタッフなら読み書きできる。
-- templates/ に書けるのは owner・manager だけ。（search_path を固定して、Storage からの呼び出しでも同じ表を見る）
create or replace function karte_file_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare cid text := split_part(coalesce(p_name, ''), '/', 1); seg text := split_part(coalesce(p_name, ''), '/', 2);
begin
  if cid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  if seg not in ('karte', 'templates') then return false; end if;
  if not exists (select 1 from my_company_ids() c where c = cid::uuid) then return false; end if;
  if p_write and seg = 'templates' then return coalesce(my_role_in_company(cid::uuid) in ('owner', 'manager'), false); end if;
  return true;
end $$;
revoke all on function karte_file_ok(text, boolean) from public, anon;
grant execute on function karte_file_ok(text, boolean) to authenticated;

do $$ begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'storage スキーマが無いので、バケットと Storage の権限は作りませんでした（Supabase 以外での検証用）';
    return;
  end if;
  insert into storage.buckets (id, name, public) values ('karte', 'karte', false)
    on conflict (id) do update set public = false;
  begin
    -- 1ファイル10MBまで・画像だけ（古い Storage で列が無ければ飛ばす）
    update storage.buckets set file_size_limit = 10485760, allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp'] where id = 'karte';
  exception when undefined_column then null;
  end;
  execute 'drop policy if exists karte_files_select on storage.objects';
  execute 'drop policy if exists karte_files_insert on storage.objects';
  execute 'drop policy if exists karte_files_update on storage.objects';
  execute 'drop policy if exists karte_files_delete on storage.objects';
  execute $p$create policy karte_files_select on storage.objects for select to authenticated
    using (bucket_id = 'karte' and public.karte_file_ok(name, false))$p$;
  execute $p$create policy karte_files_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'karte' and public.karte_file_ok(name, true))$p$;
  execute $p$create policy karte_files_update on storage.objects for update to authenticated
    using (bucket_id = 'karte' and public.karte_file_ok(name, true))
    with check (bucket_id = 'karte' and public.karte_file_ok(name, true))$p$;
  execute $p$create policy karte_files_delete on storage.objects for delete to authenticated
    using (bucket_id = 'karte' and public.karte_file_ok(name, true))$p$;
end $$;

-- 未ログイン（anon）からは表を一切触れないように（新しい表にも付け直す）
revoke all on all tables in schema public from anon;

-- API（PostgREST）に新しい表をすぐ見せる
notify pgrst, 'reload schema';

-- 確認用（Run の結果に出る）
select '0010 OK：カルテの手書きページ・背景テンプレ・画像の保存先（karte）を用意しました' as result,
       (select count(*) from karte_backgrounds) as backgrounds, (select count(*) from karte_pages) as pages;
