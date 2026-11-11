-- 0025：同意書・問診票（フェーズ1：店のタブレットで署名）。
-- ※0014_security_checkout.sql（can_write_store）と 0021_security_hardening.sql（guard_customer_company）の後に流すこと。
--   無いと最初で止まります（DBは何も変わりません）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists / on conflict）。前のファイルの内容は触らない（足すだけ）。
-- 0025 が未適用でもアプリは落ちない（設定＞同意書・問診票 と、お客様の「同意書を取る」が「準備中」になるだけ）。
--
-- やること
--  1) consent_templates：テンプレ（PDF か画像）。会社ごと・店舗を絞ることもできる。書き込みは owner・manager だけ
--  2) consent_documents：署名済みの書類（お客様・店舗・テンプレ・署名日時・担当・PDFのパス）。
--     作るのは viewer 以外の在籍スタッフ。書き換え・削除は owner・manager だけ（署名した物は基本そのまま残す）
--  3) Storage：非公開バケット consents（PDF・JPEG・PNG、1ファイル10MBまで）
--       <会社ID>/consent-templates/…   … テンプレ（読む＝その会社のスタッフ／書く＝owner・manager）
--       <会社ID>/consents/<お客様ID>/… … 署名済みPDF（読む＝その会社のスタッフ／上げる＝viewer 以外／消す・差し替え＝owner・manager）
--     表示・ダウンロードは期限つきURL（署名URL）。公開URLでは見られない
--  4) 未ログイン（anon）からは触れない。ほかの会社のお客様にはつなげない（0021 の guard_customer_company）

do $$ begin
  if to_regprocedure('public.can_write_store(uuid)') is null or to_regprocedure('public.my_role_in_company(uuid)') is null then
    raise exception '0014 がまだ流れていません。先に 0014_security_checkout.sql を流してから、この 0025 を流してください';
  end if;
  if to_regprocedure('public.guard_customer_company()') is null then
    raise exception '0021 がまだ流れていません。先に 0021_security_hardening.sql を流してから、この 0025 を流してください';
  end if;
end $$;

-- =========================================================
-- 1) テンプレ
-- =========================================================
create table if not exists consent_templates (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  store_id uuid references stores(id) on delete cascade,      -- null＝会社の全店舗で使う
  title text not null,
  file_path text not null,                                     -- Storage のパス（<会社ID>/consent-templates/…）
  kind text not null default 'pdf',                            -- pdf / image
  mime text not null default 'application/pdf',
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table consent_templates drop constraint if exists consent_templates_title_check;
alter table consent_templates add constraint consent_templates_title_check check (length(btrim(title)) between 1 and 60);
alter table consent_templates drop constraint if exists consent_templates_kind_check;
alter table consent_templates add constraint consent_templates_kind_check check (kind in ('pdf', 'image'));
alter table consent_templates drop constraint if exists consent_templates_path_check;
alter table consent_templates add constraint consent_templates_path_check check (file_path like company_id::text || '/consent-templates/%');
create index if not exists consent_templates_company_idx on consent_templates (company_id, sort_order);

-- =========================================================
-- 2) 署名済みの書類
-- =========================================================
create table if not exists consent_documents (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  template_id uuid references consent_templates(id) on delete set null,
  template_title text not null default '同意書',                -- 署名した時点のテンプレ名（テンプレを消しても残る）
  signer_name text not null,                                   -- 署名したお客様の名前（PDFの署名ページと同じ）
  signed_at timestamptz not null default now(),
  signed_by_staff_id uuid references staff(id) on delete set null,
  file_path text not null,                                     -- Storage のパス（<会社ID>/consents/<お客様ID>/<書類ID>.pdf）
  created_at timestamptz not null default now()
);
alter table consent_documents drop constraint if exists consent_documents_name_check;
alter table consent_documents add constraint consent_documents_name_check check (length(btrim(signer_name)) between 1 and 60);
alter table consent_documents drop constraint if exists consent_documents_title_check;
alter table consent_documents add constraint consent_documents_title_check check (length(btrim(template_title)) between 1 and 60);
alter table consent_documents drop constraint if exists consent_documents_path_check;
alter table consent_documents add constraint consent_documents_path_check check (file_path like '%/consents/' || customer_id::text || '/%');
create index if not exists consent_documents_customer_idx on consent_documents (customer_id, signed_at desc);
create index if not exists consent_documents_store_idx on consent_documents (store_id, signed_at desc);

-- ほかの会社のお客様にはつなげない（0021 と同じ関数）
drop trigger if exists t_consent_documents_customer_company on consent_documents;
create trigger t_consent_documents_customer_company before insert or update of customer_id, store_id on consent_documents
  for each row execute function guard_customer_company();

-- パスの会社IDが、その店舗の会社と同じであること（別の会社のフォルダに置かせない）
create or replace function guard_consent_document_path() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare cid uuid;
begin
  select company_id into cid from stores where id = new.store_id;
  if cid is null or new.file_path not like cid::text || '/consents/' || new.customer_id::text || '/%' then
    raise exception 'consent_path_mismatch' using hint = '0025：署名済みPDFの置き場所が店舗の会社と合いません';
  end if;
  return new;
end $$;
revoke all on function guard_consent_document_path() from public, anon, authenticated;
drop trigger if exists t_consent_documents_path on consent_documents;
create trigger t_consent_documents_path before insert or update of file_path, store_id, customer_id on consent_documents
  for each row execute function guard_consent_document_path();

-- =========================================================
-- 3) RLS
-- =========================================================
alter table consent_templates enable row level security;
alter table consent_documents enable row level security;

drop policy if exists consent_templates_sel on consent_templates;
create policy consent_templates_sel on consent_templates for select
  using (company_id in (select my_company_ids()));
drop policy if exists consent_templates_ins on consent_templates;
create policy consent_templates_ins on consent_templates for insert
  with check (coalesce(my_role_in_company(company_id) in ('owner', 'manager'), false)
              and (store_id is null or store_id in (select s.id from stores s where s.company_id = consent_templates.company_id)));
drop policy if exists consent_templates_upd on consent_templates;
create policy consent_templates_upd on consent_templates for update
  using (coalesce(my_role_in_company(company_id) in ('owner', 'manager'), false))
  with check (coalesce(my_role_in_company(company_id) in ('owner', 'manager'), false)
              and (store_id is null or store_id in (select s.id from stores s where s.company_id = consent_templates.company_id)));
drop policy if exists consent_templates_del on consent_templates;
create policy consent_templates_del on consent_templates for delete
  using (coalesce(my_role_in_company(company_id) in ('owner', 'manager'), false));

drop policy if exists consent_documents_sel on consent_documents;
create policy consent_documents_sel on consent_documents for select
  using (store_id in (select id from stores where company_id in (select my_company_ids())));
drop policy if exists consent_documents_ins on consent_documents;
create policy consent_documents_ins on consent_documents for insert
  with check (can_write_store(store_id));
drop policy if exists consent_documents_upd on consent_documents;
create policy consent_documents_upd on consent_documents for update
  using (is_store_admin(store_id)) with check (is_store_admin(store_id));
drop policy if exists consent_documents_del on consent_documents;
create policy consent_documents_del on consent_documents for delete
  using (is_store_admin(store_id));

revoke all on consent_templates, consent_documents from anon;
grant select, insert, update, delete on consent_templates, consent_documents to authenticated;

-- =========================================================
-- 4) Storage（非公開バケット consents と、パスごとの権限）
-- =========================================================
-- パスの1つ目＝会社ID、2つ目＝consent-templates か consents。
-- 読む＝その会社の在籍スタッフ。consent-templates/ に書く＝owner・manager。consents/ に上げる＝viewer 以外、消す・差し替え＝owner・manager
create or replace function consent_file_ok(p_name text, p_op text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare cid text := split_part(coalesce(p_name, ''), '/', 1); seg text := split_part(coalesce(p_name, ''), '/', 2); role text;
begin
  if cid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  if seg not in ('consent-templates', 'consents') then return false; end if;
  if not exists (select 1 from my_company_ids() c where c = cid::uuid) then return false; end if;
  if p_op = 'read' then return true; end if;
  role := my_role_in_company(cid::uuid);
  if seg = 'consent-templates' then return coalesce(role in ('owner', 'manager'), false); end if;
  if p_op = 'insert' then return coalesce(role in ('owner', 'manager', 'staff'), false); end if;
  return coalesce(role in ('owner', 'manager'), false);
end $$;
revoke all on function consent_file_ok(text, text) from public, anon;
grant execute on function consent_file_ok(text, text) to authenticated;

do $$ begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice 'storage スキーマが無いので、バケットと Storage の権限は作りませんでした（Supabase 以外での検証用）';
    return;
  end if;
  insert into storage.buckets (id, name, public) values ('consents', 'consents', false)
    on conflict (id) do update set public = false;
  begin
    -- 1ファイル10MBまで・PDFと画像だけ（古い Storage で列が無ければ飛ばす）
    update storage.buckets set file_size_limit = 10485760, allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg'] where id = 'consents';
  exception when undefined_column then null;
  end;
  execute 'drop policy if exists consent_files_select on storage.objects';
  execute 'drop policy if exists consent_files_insert on storage.objects';
  execute 'drop policy if exists consent_files_update on storage.objects';
  execute 'drop policy if exists consent_files_delete on storage.objects';
  execute $p$create policy consent_files_select on storage.objects for select to authenticated
    using (bucket_id = 'consents' and public.consent_file_ok(name, 'read'))$p$;
  execute $p$create policy consent_files_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'consents' and public.consent_file_ok(name, 'insert'))$p$;
  execute $p$create policy consent_files_update on storage.objects for update to authenticated
    using (bucket_id = 'consents' and public.consent_file_ok(name, 'update'))
    with check (bucket_id = 'consents' and public.consent_file_ok(name, 'update'))$p$;
  execute $p$create policy consent_files_delete on storage.objects for delete to authenticated
    using (bucket_id = 'consents' and public.consent_file_ok(name, 'delete'))$p$;
end $$;

-- 未ログイン（anon）からは表を一切触れないように（新しい表にも付け直す）
revoke all on all tables in schema public from anon;

-- API（PostgREST）に新しい表をすぐ見せる
notify pgrst, 'reload schema';

-- 確認用（Run の結果に出る）
select '0025 OK：同意書・問診票（テンプレ・署名済みの書類・保存先 consents）を用意しました' as result,
       (select count(*) from consent_templates) as templates, (select count(*) from consent_documents) as documents;
