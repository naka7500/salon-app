-- 同意書（0025）とカルテ画像（0024）の DB テスト。ローカルの PostgreSQL 専用（tools/dbtest/run.sh から呼ぶ）。
-- 2社（A社：店舗 A1・A2／B社：店舗 B1）と、役割別のユーザーを作り、「ログイン中の人」をまねて実行する。
-- 1つでも期待と違えば ERROR で止まる。最後まで行けば「ALL TESTS PASSED」。
\set QUIET 1
set client_min_messages = notice;

create schema t;
grant usage on schema t to authenticated, anon;
-- 期待どおりエラーになること（エラー文に pattern を含む）
create function t.throws(p_sql text, p_pattern text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlerrm ~* p_pattern then raise notice 'ok - %', p_label; return; end if;
    raise exception 'TEST FAILED（%）：別のエラー：%', p_label, sqlerrm;
  end;
  raise exception 'TEST FAILED（%）：エラーにならなかった', p_label;
end $$;
-- 変わった行数が n であること（RLS で見えない・許されない行は 0 件になる）
create function t.affects(p_sql text, p_n int, p_label text) returns void language plpgsql as $$
declare n int;
begin
  execute p_sql; get diagnostics n = row_count;
  if n <> p_n then raise exception 'TEST FAILED（%）：% 行（期待 % 行）', p_label, n, p_n; end if;
  raise notice 'ok - %', p_label;
end $$;
create function t.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'TEST FAILED（%）', p_label; end if;
  raise notice 'ok - %', p_label;
end $$;
grant execute on all functions in schema t to authenticated, anon;

-- ---------- 準備（管理者として。お客様・スタッフなどの土台だけ。同意書は本物の流れで入れる） ----------
set session_replication_role = replica;
insert into companies (id, name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'A社'), ('bbbbbbbb-0000-0000-0000-000000000001', 'B社');
insert into stores (id, company_id, name, business_type) values
 ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1', 'eyelash'),
 ('aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2', 'eyelash'),
 ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'B1', 'headspa');
insert into auth.users (id, email, email_confirmed_at) values
 ('00000000-0000-0000-0000-00000000a001', 'ao@x.test', now()), ('00000000-0000-0000-0000-00000000a002', 'am@x.test', now()),
 ('00000000-0000-0000-0000-00000000a003', 'as@x.test', now()), ('00000000-0000-0000-0000-00000000a004', 'av@x.test', now()),
 ('00000000-0000-0000-0000-00000000a005', 'ax@x.test', now()), ('00000000-0000-0000-0000-00000000b001', 'bo@x.test', now()),
 ('00000000-0000-0000-0000-00000000b003', 'bs@x.test', now());
insert into staff (id, company_id, name, role, auth_user_id, active) values
 ('a0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Aowner', 'owner', '00000000-0000-0000-0000-00000000a001', true),
 ('a0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Amanager', 'manager', '00000000-0000-0000-0000-00000000a002', true),
 ('a0000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Astaff', 'staff', '00000000-0000-0000-0000-00000000a003', true),
 ('a0000000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'Aviewer', 'viewer', '00000000-0000-0000-0000-00000000a004', true),
 ('a0000000-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'Aretired', 'staff', '00000000-0000-0000-0000-00000000a005', false),
 ('b0000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', 'Bowner', 'owner', '00000000-0000-0000-0000-00000000b001', true),
 ('b0000000-0000-0000-0000-000000000003', 'bbbbbbbb-0000-0000-0000-000000000001', 'Bstaff', 'staff', '00000000-0000-0000-0000-00000000b003', true);
insert into customers (id, company_id, name) values
 ('c0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', 'A客（残す側）'),
 ('c0000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'A客（同意書だけ先に取った側）'),
 ('c0000000-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000001', 'B客');
insert into karte_entries (id, customer_id, store_id, visited_on) values
 ('e0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-0000000000a1', '2026-11-11');
insert into karte_pages (id, karte_entry_id) values ('f0000000-0000-0000-0000-00000000000a', 'e0000000-0000-0000-0000-00000000000a');
insert into consent_templates (id, company_id, store_id, title, file_path, active) values
 ('70000000-0000-0000-0000-00000000000a', 'aaaaaaaa-0000-0000-0000-000000000001', null, 'A同意書', 'aaaaaaaa-0000-0000-0000-000000000001/consent-templates/t.pdf', true),
 ('70000000-0000-0000-0000-0000000000a0', 'aaaaaaaa-0000-0000-0000-000000000001', null, 'A使わない', 'aaaaaaaa-0000-0000-0000-000000000001/consent-templates/off.pdf', false),
 ('70000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'A2専用', 'aaaaaaaa-0000-0000-0000-000000000001/consent-templates/a2.pdf', true),
 ('70000000-0000-0000-0000-00000000000b', 'bbbbbbbb-0000-0000-0000-000000000001', null, 'B同意書', 'bbbbbbbb-0000-0000-0000-000000000001/consent-templates/t.pdf', true);
set session_replication_role = origin;

\set A   'aaaaaaaa-0000-0000-0000-000000000001'
\set AO  'set local role authenticated; select set_config(''request.jwt.claim.sub'', ''00000000-0000-0000-0000-00000000a001'', true)'
\set AM  'set local role authenticated; select set_config(''request.jwt.claim.sub'', ''00000000-0000-0000-0000-00000000a002'', true)'
\set AS  'set local role authenticated; select set_config(''request.jwt.claim.sub'', ''00000000-0000-0000-0000-00000000a003'', true)'
\set AV  'set local role authenticated; select set_config(''request.jwt.claim.sub'', ''00000000-0000-0000-0000-00000000a004'', true)'
\set AX  'set local role authenticated; select set_config(''request.jwt.claim.sub'', ''00000000-0000-0000-0000-00000000a005'', true)'
\set BO  'set local role authenticated; select set_config(''request.jwt.claim.sub'', ''00000000-0000-0000-0000-00000000b001'', true)'
\set BS  'set local role authenticated; select set_config(''request.jwt.claim.sub'', ''00000000-0000-0000-0000-00000000b003'', true)'
\pset tuples_only on
\pset format unaligned
\o /dev/null

-- ========== 1) Storage：署名済みPDFを上げる（上書きなし） ==========
begin; :AS;
select t.affects($$insert into storage.objects (bucket_id, name, metadata) values ('consents', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000001.pdf', '{"size": 1000}')$$, 1, 'スタッフ：署名済みPDFを上げられる（insert だけ。upsert なし）');
select t.affects($$insert into storage.objects (bucket_id, name, metadata) values ('consents', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', '{"size": 2000}')$$, 1, 'スタッフ：2件目のPDF');
select t.affects($$insert into storage.objects (bucket_id, name, metadata) values ('consents', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000009.pdf', '{"size": 9}')$$, 1, 'スタッフ：記録を作らないPDF（片づけのテスト用）');
select t.throws($$insert into storage.objects (bucket_id, name) values ('consents', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000001.pdf')$$, 'duplicate key', '同じ名前では上げられない（上書き不可）');
select t.throws($$insert into storage.objects (bucket_id, name) values ('consents', 'aaaaaaaa-0000-0000-0000-000000000001/consents/c0000000-0000-0000-0000-00000000000a/x.pdf')$$, 'row-level security', '決まった名前（<会社ID>/consents/<書類ID>.pdf）以外は上げられない');
select t.throws($$insert into storage.objects (bucket_id, name) values ('consents', 'bbbbbbbb-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-0000000000b9.pdf')$$, 'row-level security', 'ほかの会社のフォルダには上げられない');
select t.throws($$insert into storage.objects (bucket_id, name) values ('consents', 'aaaaaaaa-0000-0000-0000-000000000001/consent-templates/x.pdf')$$, 'row-level security', 'スタッフはテンプレを上げられない');
commit;
begin; :AV;
select t.throws($$insert into storage.objects (bucket_id, name) values ('consents', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000003.pdf')$$, 'row-level security', '閲覧のみ：PDFを上げられない');
commit;
begin; :AX;
select t.throws($$insert into storage.objects (bucket_id, name) values ('consents', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000003.pdf')$$, 'row-level security', '退職者：PDFを上げられない');
commit;

-- ========== 2) 署名の記録：だれが・いつ・会社・テンプレ名は DB が決める（M2） ==========
begin; :AS;
select t.affects($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size)
  values ('d0000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-0000000000a2', '70000000-0000-0000-0000-00000000000a', '山田 花子',
          'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000001.pdf', repeat('ab', 32), 1000)$$, 1, 'スタッフ：署名を保存できる');
select t.ok((select signed_by_staff_id = 'a0000000-0000-0000-0000-000000000003' and signed_by_name = 'Astaff' and company_id = 'aaaaaaaa-0000-0000-0000-000000000001'
              and template_title = 'A同意書' and abs(extract(epoch from now() - signed_at)) < 5 and abs(extract(epoch from now() - created_at)) < 5 and voided_at is null
             from consent_documents where id = 'd0000000-0000-0000-0000-000000000001'), '担当＝ログイン中の本人・署名日時＝サーバの今・会社・テンプレ名は DB が入れた');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size, signed_at)
  values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-00000000000a', 'x',
          'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', repeat('ab', 32), 2000, '2020-01-01')$$, 'permission denied', '署名日時（signed_at）は送れない');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size, signed_by_staff_id)
  values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-00000000000a', 'x',
          'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', repeat('ab', 32), 2000, 'b0000000-0000-0000-0000-000000000001')$$, 'permission denied', '担当（signed_by_staff_id）は送れない');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size, created_at, template_title, company_id)
  values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a', '70000000-0000-0000-0000-00000000000a', 'x',
          'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', repeat('ab', 32), 2000, '2020-01-01', '偽の名前', 'bbbbbbbb-0000-0000-0000-000000000001')$$, 'permission denied', '作成日時・テンプレ名・会社は送れない');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  '70000000-0000-0000-0000-00000000000b', 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', repeat('ab', 32), 2000)$$, 'consent_template_mismatch', 'ほかの会社のテンプレは使えない');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  '70000000-0000-0000-0000-0000000000a2', 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', repeat('ab', 32), 2000)$$, 'consent_template_mismatch', 'ほかの店舗専用のテンプレは使えない');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  null, 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', repeat('ab', 32), 2000)$$, 'consent_template_mismatch', 'テンプレなしでは保存できない');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  '70000000-0000-0000-0000-0000000000a0', 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', repeat('ab', 32), 2000)$$, 'consent_template_inactive', '「使わない」のテンプレでは保存できない（L3）');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  '70000000-0000-0000-0000-00000000000a', 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000001.pdf', repeat('ab', 32), 1000)$$, 'consent_path_mismatch', 'ほかの書類のPDFは使い回せない');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  '70000000-0000-0000-0000-00000000000a', 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000004.pdf', repeat('ab', 32), 2000)$$, 'consent_file_missing', 'PDFが Storage に無ければ保存できない');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  '70000000-0000-0000-0000-00000000000a', 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', repeat('ab', 32), 2001)$$, 'consent_file_size_mismatch', 'PDFの大きさが合わなければ保存できない');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  '70000000-0000-0000-0000-00000000000a', 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', 'zz', 2000)$$, 'consent_documents_sha_check', '指紋（SHA-256）の形が違えば保存できない');
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000b',
  '70000000-0000-0000-0000-00000000000a', 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', repeat('ab', 32), 2000)$$, 'customer_company_mismatch', 'ほかの会社のお客様にはつなげない');
select t.affects($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  '70000000-0000-0000-0000-00000000000a', '山田 花子', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000002.pdf', repeat('cd', 32), 2000)$$, 1, 'スタッフ：2件目の署名');
commit;
begin; :AV;
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  '70000000-0000-0000-0000-00000000000a', 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000009.pdf', repeat('ab', 32), 9)$$, 'consent_staff_required|row-level security', '閲覧のみ：署名を保存できない');
select t.ok((select count(*) = 2 from consent_documents), '閲覧のみ：自社の署名済みの書類は読める');
select t.ok((select count(*) = 3 from storage.objects where bucket_id = 'consents'), '閲覧のみ：自社のPDFは読める');
commit;
begin; :BS;
select t.throws($$insert into consent_documents (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) values ('d0000000-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-00000000000a',
  '70000000-0000-0000-0000-00000000000a', 'x', 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000009.pdf', repeat('ab', 32), 9)$$, 'consent_staff_required|row-level security', 'ほかの会社のスタッフ：A社の店舗に署名を保存できない');
select t.ok((select count(*) = 0 from consent_documents), 'ほかの会社：署名済みの書類は1件も見えない');
select t.ok((select count(*) = 0 from consent_templates where company_id = 'aaaaaaaa-0000-0000-0000-000000000001'), 'ほかの会社：テンプレは見えない');
select t.ok((select count(*) = 0 from storage.objects where bucket_id = 'consents'), 'ほかの会社：PDFは1つも見えない');
commit;
begin; :AX;
select t.ok((select count(*) = 0 from consent_documents), '退職者：何も見えない');
commit;
begin; set local role anon;
select t.throws($$select count(*) from consent_documents$$, 'permission denied', '未ログイン：表に触れない');
commit;

-- ========== 3) 署名済みは書き換え・削除できない（M3） ==========
begin; :AO;
select t.throws($$update consent_documents set signer_name = '別人' where id = 'd0000000-0000-0000-0000-000000000001'$$, 'permission denied', 'オーナー：署名済みの書類を書き換えられない');
select t.throws($$update consent_documents set signed_at = '2020-01-01' where id = 'd0000000-0000-0000-0000-000000000001'$$, 'permission denied', 'オーナー：署名日時を書き換えられない');
select t.throws($$update consent_documents set voided_at = now(), void_reason = 'x' where id = 'd0000000-0000-0000-0000-000000000001'$$, 'permission denied', 'オーナー：取り消しの印を直接は書けない（関数経由だけ）');
select t.throws($$delete from consent_documents where id = 'd0000000-0000-0000-0000-000000000001'$$, 'permission denied', 'オーナー：署名済みの書類を削除できない');
select t.throws($$truncate consent_documents$$, 'permission denied', 'オーナー：TRUNCATE できない（L9）');
select t.affects($$update storage.objects set name = name || '.x' where bucket_id = 'consents' and name like '%/consents/%'$$, 0, 'オーナー：署名済みPDFを改名・差し替えできない');
select t.affects($$update storage.objects set metadata = '{}' where bucket_id = 'consents' and name like '%/consents/d0000000-0000-0000-0000-000000000001.pdf'$$, 0, 'オーナー：署名済みPDFを上書きできない');
select t.affects($$delete from storage.objects where bucket_id = 'consents' and name like '%/consents/d0000000-0000-0000-0000-000000000001.pdf'$$, 0, 'オーナー：記録のあるPDFを消せない');
commit;
begin; :AM;
select t.throws($$update consent_documents set signer_name = '別人'$$, 'permission denied', '店長：書き換えられない');
select t.throws($$delete from consent_documents$$, 'permission denied', '店長：削除できない');
commit;
begin; :AS;
select t.affects($$delete from storage.objects where bucket_id = 'consents' and name like '%/consents/d0000000-0000-0000-0000-000000000002.pdf'$$, 0, 'スタッフ：記録のあるPDFを消せない');
select t.affects($$delete from storage.objects where bucket_id = 'consents' and name like '%/consents/d0000000-0000-0000-0000-000000000009.pdf'$$, 1, 'スタッフ：記録の無いPDF（保存に失敗した残り）は片づけられる（L2）');
commit;
-- 権限をすり抜けた場合（管理者・サービスキー・将来の関数）でも、トリガーが止める
select t.throws($$update consent_documents set signer_name = '別人' where id = 'd0000000-0000-0000-0000-000000000001'$$, 'consent_document_immutable', '管理者でも：お名前を書き換えられない（トリガー）');
select t.throws($$update consent_documents set signed_at = '2020-01-01' where id = 'd0000000-0000-0000-0000-000000000001'$$, 'consent_document_immutable', '管理者でも：署名日時を書き換えられない');
select t.throws($$update consent_documents set file_sha256 = repeat('00', 32) where id = 'd0000000-0000-0000-0000-000000000001'$$, 'consent_document_immutable', '管理者でも：PDFの指紋を書き換えられない');
select t.throws($$update consent_documents set file_path = 'aaaaaaaa-0000-0000-0000-000000000001/consents/other.pdf' where id = 'd0000000-0000-0000-0000-000000000001'$$, 'consent_document_immutable', '管理者でも：PDFの場所を書き換えられない');
select t.throws($$update consent_documents set customer_id = 'c0000000-0000-0000-0000-00000000000a' where id = 'd0000000-0000-0000-0000-000000000001'$$, 'consent_document_immutable', '管理者でも：お客様の付け替えは統合のときだけ');
select t.throws($$update consent_documents set signed_by_staff_id = 'a0000000-0000-0000-0000-000000000001' where id = 'd0000000-0000-0000-0000-000000000001'$$, 'consent_document_immutable', '管理者でも：担当を書き換えられない');
select t.throws($$update consent_documents set template_id = '70000000-0000-0000-0000-0000000000a2' where id = 'd0000000-0000-0000-0000-000000000001'$$, 'consent_document_immutable', '管理者でも：テンプレを書き換えられない');
select t.throws($$update consent_documents set voided_at = now(), void_reason = 'x' where id = 'd0000000-0000-0000-0000-000000000001'$$, 'consent_document_immutable', '管理者でも：取り消しの印は関数経由だけ');

-- ========== 4) 取り消し（オーナーだけ・理由つき・1回きり・記録が残る） ==========
begin; :AS; select t.throws($$select void_consent_document('d0000000-0000-0000-0000-000000000002', '間違えた')$$, 'consent_void_forbidden', 'スタッフ：取り消せない'); commit;
begin; :AM; select t.throws($$select void_consent_document('d0000000-0000-0000-0000-000000000002', '間違えた')$$, 'consent_void_forbidden', '店長：取り消せない'); commit;
begin; :BO; select t.throws($$select void_consent_document('d0000000-0000-0000-0000-000000000002', '間違えた')$$, 'consent_not_found', 'ほかの会社のオーナー：取り消せない'); commit;
begin; :AO;
select t.throws($$select void_consent_document('d0000000-0000-0000-0000-000000000002', '  ')$$, 'consent_void_reason', 'オーナー：理由なしでは取り消せない');
select t.affects($$select void_consent_document('d0000000-0000-0000-0000-000000000002', '別のお客様で取ってしまった')$$, 1, 'オーナー：取り消しの印を付けられる');
select t.ok((select voided_at is not null and voided_by_staff_id = 'a0000000-0000-0000-0000-000000000001' and voided_by_name = 'Aowner' and void_reason = '別のお客様で取ってしまった'
              and signer_name = '山田 花子' and file_sha256 = repeat('cd', 32) from consent_documents where id = 'd0000000-0000-0000-0000-000000000002'), '取り消し：いつ・だれが・理由が残り、中身はそのまま');
select t.throws($$select void_consent_document('d0000000-0000-0000-0000-000000000002', 'もう一度')$$, 'consent_already_voided', '取り消しは1回きり');
commit;
select t.throws($$update consent_documents set voided_at = null, void_reason = null, voided_by_staff_id = null, voided_by_name = null where id = 'd0000000-0000-0000-0000-000000000002'$$, 'consent_document_immutable', '管理者でも：取り消しの印は外せない');
select t.ok((select count(*) = 2 from audit_logs where table_name = 'consent_documents' and action = 'sign' and actor_name = 'Astaff' and after->>'file_sha256' is not null), '修正履歴：署名 2件（だれが・PDFの指紋）');
select t.ok((select count(*) = 1 from audit_logs where table_name = 'consent_documents' and action = 'void' and actor_name = 'Aowner' and reason = '別のお客様で取ってしまった'), '修正履歴：取り消し 1件（だれが・理由）');

-- ========== 5) お客様を消しても同意書は一緒に消えない（M4） ==========
select t.throws($$delete from customers where id = 'c0000000-0000-0000-0000-0000000000a2'$$, 'foreign key|consent_documents', 'お客様の削除は、署名済みの同意書があると止まる（一緒に消えない）');
select t.throws($$delete from stores where id = 'aaaaaaaa-0000-0000-0000-0000000000a1'$$, 'foreign key', '店舗の削除も、署名済みの同意書があると止まる');
begin; :AS;
select t.throws($$delete from customers where id = 'c0000000-0000-0000-0000-0000000000a2'$$, 'foreign key|consent_documents', 'スタッフ：お客様ごと消す抜け道は無い');
commit;
select t.ok((select count(*) = 2 from consent_documents), '同意書は2件のまま');

-- ========== 6) お客様の統合で、同意書も残す側へ（M5） ==========
begin; :AS;
select t.ok((select (merge_customers('c0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-0000000000a1')->>'consents')::int = 1), '統合：同意書 1件を移したと返る');
select t.ok((select count(*) = 2 from consent_documents where customer_id = 'c0000000-0000-0000-0000-00000000000a'), '統合の後：残した側のお客様に同意書が2件');
select t.ok((select count(*) = 0 from consent_documents where customer_id = 'c0000000-0000-0000-0000-0000000000a2'), '統合の後：統合済みの側には残っていない');
select t.ok((select file_path = 'aaaaaaaa-0000-0000-0000-000000000001/consents/d0000000-0000-0000-0000-000000000001.pdf' and signer_name = '山田 花子' and file_sha256 = repeat('ab', 32)
             from consent_documents where id = 'd0000000-0000-0000-0000-000000000001'), '統合の後：PDFの場所・お名前・指紋はそのまま');
select t.ok((select count(*) = 1 from storage.objects where bucket_id = 'consents' and name = (select file_path from consent_documents where id = 'd0000000-0000-0000-0000-000000000001')), '統合の後：PDFを今までどおり読める');
commit;
select t.ok((select (after->>'consents')::int = 1 from audit_logs where table_name = 'customers' and action = 'merge' order by id desc limit 1), '修正履歴：統合で同意書 1件');

-- ========== 7) テンプレ・スタッフを消しても、署名済みの記録は残る ==========
begin; :AO;
select t.affects($$delete from consent_templates where id = '70000000-0000-0000-0000-00000000000a'$$, 1, 'オーナー：テンプレは消せる');
commit;
select t.ok((select count(*) = 2 and bool_and(template_id is null) and bool_and(template_title = 'A同意書') from consent_documents), 'テンプレを消しても、署名済みの書類と名前は残る');

-- ========== 8) SQL（管理者）からの削除だけ通り、記録が残る ==========
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a001', true);
select t.throws($$delete from consent_documents where id = 'd0000000-0000-0000-0000-000000000002'$$, 'consent_document_immutable', 'ログイン中の人としては、権限があっても削除できない（トリガー）');
commit;
select t.affects($$delete from consent_documents where id = 'd0000000-0000-0000-0000-000000000002'$$, 1, 'SQL エディタ（管理者）からは削除できる');
select t.ok((select count(*) = 1 from audit_logs where table_name = 'consent_documents' and action = 'delete' and row_id = 'd0000000-0000-0000-0000-000000000002' and before->>'file_sha256' is not null), '修正履歴：SQL からの削除も残る');

-- ========== 9) カルテの画像（0024）：置いた画像の中身の検査（L1） ==========
begin; :AS;
select t.affects($$update karte_pages set images = '[{"id":"i1","path":"aaaaaaaa-0000-0000-0000-000000000001/karte/e0000000-0000-0000-0000-00000000000a/p-img-i1-1.jpg","x":10,"y":20,"w":300,"h":200}]' where id = 'f0000000-0000-0000-0000-00000000000a'$$, 1, 'カルテ画像：正しい形は保存できる');
select t.throws($$update karte_pages set images = '[{"id":"i1","path":"https://example.com/x.jpg","x":1,"y":1,"w":1,"h":1}]' where id = 'f0000000-0000-0000-0000-00000000000a'$$, 'karte_images_invalid', 'カルテ画像：外部の URL は入れられない');
select t.throws($$update karte_pages set images = '[{"id":"i1","path":"data:image/png;base64,AAAA","x":1,"y":1,"w":1,"h":1}]' where id = 'f0000000-0000-0000-0000-00000000000a'$$, 'karte_images_invalid', 'カルテ画像：data URL は入れられない');
select t.throws($$update karte_pages set images = '[{"id":"i1","path":"bbbbbbbb-0000-0000-0000-000000000001/karte/x.jpg","x":1,"y":1,"w":1,"h":1}]' where id = 'f0000000-0000-0000-0000-00000000000a'$$, 'karte_images_invalid', 'カルテ画像：ほかの会社のパスは入れられない');
select t.throws($$update karte_pages set images = '["x", 1]' where id = 'f0000000-0000-0000-0000-00000000000a'$$, 'karte_images_invalid', 'カルテ画像：文字や数だけの要素は入れられない');
select t.throws($$update karte_pages set images = '[{"id":"i1","path":"aaaaaaaa-0000-0000-0000-000000000001/karte/a.jpg","x":"1","y":1,"w":1,"h":1}]' where id = 'f0000000-0000-0000-0000-00000000000a'$$, 'karte_images_invalid', 'カルテ画像：位置は数で入れる');
select t.affects($$update karte_pages set images = '[]' where id = 'f0000000-0000-0000-0000-00000000000a'$$, 1, 'カルテ画像：空に戻せる');
commit;

\o
select 'ALL TESTS PASSED（同意書 0025・カルテ画像 0024）' as result;
