-- 0025：同意書・問診票（フェーズ1：店のタブレットで署名）。
-- ※0014_security_checkout.sql（can_write_store）・0021_security_hardening.sql（guard_customer_company）・0022_line_identity.sql（merge_customers）の後に流すこと。
--   無いと最初で止まります（DBは何も変わりません）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists / on conflict）。前のファイルの内容は触らない（足すだけ）。
-- 0025 が未適用でもアプリは落ちない（設定＞同意書・問診票 と、お客様の「同意書を取る」が「準備中」になるだけ）。
--
-- やること
--  1) consent_templates：テンプレ（PDF か画像）。会社ごと・店舗を絞ることもできる。書き込みは owner・manager だけ
--  2) consent_documents：署名済みの書類（お客様・店舗・テンプレ・署名日時・担当・PDFのパスと指紋 SHA-256）。
--     作るのは viewer 以外の在籍スタッフ。★署名日時・担当・会社・テンプレ名は DB が決める（画面からは渡せない）。
--     ★保存の後は、だれも書き換え・削除できない（追記のみ）。オーナーだけ「取り消し」の印（いつ・だれが・理由）を付けられる。行とPDFは残る。
--     ★署名・取り消し・（SQL からの）削除は audit_logs に残る。お客様・店舗を消しても一緒には消えない（先に止まる）
--  3) Storage：非公開バケット consents（PDF・JPEG・PNG、1ファイル10MBまで）
--       <会社ID>/consent-templates/…      … テンプレ（読む＝その会社のスタッフ／書く＝owner・manager）
--       <会社ID>/consents/<書類ID>.pdf    … 署名済みPDF（読む＝その会社のスタッフ／上げる＝viewer 以外／★差し替え不可・記録のあるPDFは消せない）
--     表示・ダウンロードは期限つきURL（署名URL）。公開URLでは見られない
--  4) 未ログイン（anon）からは触れない。ほかの会社のお客様にはつなげない（0021 の guard_customer_company）
--  5) お客様の統合（0022 の merge_customers）で、署名済みの同意書も残す側へ移す
--     ※0022 をこの 0025 の後でもう一度流すと merge_customers が古い内容に戻るので、そのときは 0025 も流し直すこと
--
-- 2026-11-11 監査対応（S1・S2・M1 は画面側。M2〜M6・L2・L3・L9 がこのファイル）

do $$ begin
  if to_regprocedure('public.can_write_store(uuid)') is null or to_regprocedure('public.my_role_in_company(uuid)') is null then
    raise exception '0014 がまだ流れていません。先に 0014_security_checkout.sql を流してから、この 0025 を流してください';
  end if;
  if to_regprocedure('public.guard_customer_company()') is null then
    raise exception '0021 がまだ流れていません。先に 0021_security_hardening.sql を流してから、この 0025 を流してください';
  end if;
  if to_regprocedure('public.merge_customers(uuid, uuid, uuid)') is null then
    raise exception '0022 がまだ流れていません。先に 0022_line_identity.sql を流してから、この 0025 を流してください';
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
-- 2) 署名済みの書類（追記のみ。書き換え・削除はできない）
-- =========================================================
create table if not exists consent_documents (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id),                    -- 店舗の会社（DB が入れる）
  store_id uuid not null references stores(id),                -- ★店舗を消しても一緒には消えない（先に止まる）
  customer_id uuid not null references customers(id),          -- ★お客様を消しても一緒には消えない（先に止まる。カルテと同じ）
  template_id uuid references consent_templates(id) on delete set null,
  template_title text not null default '同意書',                -- 署名した時点のテンプレ名（DB が入れる。テンプレを消しても残る）
  signer_name text not null,                                   -- 署名したお客様の名前（PDFの署名ページと同じ）
  signed_at timestamptz not null default now(),                -- ★サーバの時刻（DB が入れる）
  signed_by_staff_id uuid references staff(id) on delete set null,  -- ★ログイン中の本人（DB が入れる）
  signed_by_name text,                                         -- 署名した時点の担当の名前（スタッフを消しても残る）
  file_path text not null,                                     -- Storage のパス（<会社ID>/consents/<書類ID>.pdf）
  file_sha256 text,                                            -- 署名済みPDFの SHA-256（16進64文字）。あとで同じファイルかを照合できる
  file_size bigint,                                            -- 署名済みPDFの大きさ（バイト）
  voided_at timestamptz,                                       -- 取り消し（オーナーだけ。行とPDFは残る）
  voided_by_staff_id uuid references staff(id) on delete set null,
  voided_by_name text,
  void_reason text,
  created_at timestamptz not null default now()
);
-- 0025 の最初の版（2026-11-11 午前。本番には未適用）を流した検証用DB向け：足りない列を足す
alter table consent_documents add column if not exists company_id uuid references companies(id);
alter table consent_documents add column if not exists signed_by_name text;
alter table consent_documents add column if not exists file_sha256 text;
alter table consent_documents add column if not exists file_size bigint;
alter table consent_documents add column if not exists voided_at timestamptz;
alter table consent_documents add column if not exists voided_by_staff_id uuid references staff(id) on delete set null;
alter table consent_documents add column if not exists voided_by_name text;
alter table consent_documents add column if not exists void_reason text;
-- 会社IDが空の行（最初の版で作った行）だけ埋める。2回目からは対象が無い
do $$ begin
  if exists (select 1 from consent_documents where company_id is null) then
    alter table consent_documents disable trigger user;
    update consent_documents d set company_id = s.company_id from stores s where s.id = d.store_id and d.company_id is null;
    alter table consent_documents enable trigger user;
  end if;
end $$;
alter table consent_documents alter column company_id set not null;

-- ★M4：お客様・店舗を消しても、署名済みの記録は一緒に消えない（外部キーを「連鎖で消す」から「止める」に）
do $$ declare c record; begin
  for c in select k.conname, a.attname as col, k.confrelid::regclass::text as ref
             from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
            where k.conrelid = 'public.consent_documents'::regclass and k.contype = 'f' and k.confdeltype = 'c'
  loop
    execute format('alter table consent_documents drop constraint %I', c.conname);
    execute format('alter table consent_documents add constraint %I foreign key (%I) references %s (id)', c.conname, c.col, c.ref);
  end loop;
end $$;

alter table consent_documents drop constraint if exists consent_documents_name_check;
alter table consent_documents add constraint consent_documents_name_check check (length(btrim(signer_name)) between 1 and 60);
alter table consent_documents drop constraint if exists consent_documents_title_check;
alter table consent_documents add constraint consent_documents_title_check check (length(btrim(template_title)) between 1 and 60);
-- パスは「会社ID/consents/…」。★お客様IDは入れない（統合でお客様が変わっても場所は変わらない。M5）
alter table consent_documents drop constraint if exists consent_documents_path_check;
alter table consent_documents add constraint consent_documents_path_check check (file_path like company_id::text || '/consents/%');
alter table consent_documents drop constraint if exists consent_documents_sha_check;
alter table consent_documents add constraint consent_documents_sha_check check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$');
alter table consent_documents drop constraint if exists consent_documents_size_check;
alter table consent_documents add constraint consent_documents_size_check check (file_size is null or file_size between 1 and 20971520);
alter table consent_documents drop constraint if exists consent_documents_void_check;
alter table consent_documents add constraint consent_documents_void_check
  check ((voided_at is null and void_reason is null) or (voided_at is not null and length(btrim(void_reason)) between 1 and 200));
create index if not exists consent_documents_customer_idx on consent_documents (customer_id, signed_at desc);
create index if not exists consent_documents_store_idx on consent_documents (store_id, signed_at desc);
-- 1つの署名＝1つのファイル（同じPDFを別の記録に使い回せない）
create unique index if not exists consent_documents_file_path_key on consent_documents (file_path);

-- ほかの会社のお客様にはつなげない（0021 と同じ関数）
drop trigger if exists t_consent_documents_customer_company on consent_documents;
create trigger t_consent_documents_customer_company before insert or update of customer_id, store_id on consent_documents
  for each row execute function guard_customer_company();

-- 最初の版のトリガー・関数（パスにお客様IDを入れる検査）は使わない
drop trigger if exists t_consent_documents_path on consent_documents;
drop function if exists guard_consent_document_path();

-- ---------------------------------------------------------
-- ★M2：保存するとき、「だれが・いつ・どの会社・どのテンプレ」は DB が決める（画面から渡された値は使わない）
--   - 署名日時・作成日時＝サーバの今の時刻
--   - 担当＝ログイン中の本人（その会社に在籍・viewer 以外）
--   - テンプレ＝同じ会社の、その店舗で使える、「使う」になっているもの。テンプレ名もテンプレから写す
--   - PDF の場所＝<会社ID>/consents/<書類ID>.pdf（署名ごとに別の名前）。指紋（SHA-256）と大きさは必須
-- ---------------------------------------------------------
create or replace function stamp_consent_document() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare cid uuid; st staff; t consent_templates;
begin
  select company_id into cid from stores where id = new.store_id;
  if cid is null then raise exception 'consent_path_mismatch' using hint = '0025：店舗が見つかりません'; end if;
  new.company_id := cid;
  select * into st from staff
   where auth_user_id = auth.uid() and company_id = cid and coalesce(active, true) and role in ('owner', 'manager', 'staff')
   order by case role when 'owner' then 0 when 'manager' then 1 else 2 end limit 1;
  if st.id is null then raise exception 'consent_staff_required' using hint = '0025：署名の保存は、在籍のスタッフ（閲覧のみ以外）がログインして行います'; end if;
  new.signed_by_staff_id := st.id;
  new.signed_by_name := st.name;
  new.signed_at := now();
  new.created_at := now();
  new.voided_at := null; new.voided_by_staff_id := null; new.voided_by_name := null; new.void_reason := null;
  select * into t from consent_templates where id = new.template_id;
  if t.id is null or t.company_id <> cid or (t.store_id is not null and t.store_id <> new.store_id) then
    raise exception 'consent_template_mismatch' using hint = '0025：テンプレが、この会社・店舗のものではありません';
  end if;
  if not t.active then raise exception 'consent_template_inactive' using hint = '0025：「使わない」にしたテンプレでは署名を取れません'; end if;
  new.template_title := t.title;
  if new.id is null or new.file_path is distinct from cid::text || '/consents/' || new.id::text || '.pdf' then
    raise exception 'consent_path_mismatch' using hint = '0025：署名済みPDFの置き場所は <会社ID>/consents/<書類ID>.pdf です';
  end if;
  if new.file_sha256 is null or new.file_size is null then
    raise exception 'consent_file_missing' using hint = '0025：署名済みPDFの指紋（SHA-256）と大きさが必要です';
  end if;
  return new;
end $$;
revoke all on function stamp_consent_document() from public, anon, authenticated;
drop trigger if exists t_consent_documents_10_stamp on consent_documents;
create trigger t_consent_documents_10_stamp before insert on consent_documents
  for each row execute function stamp_consent_document();

-- PDF が本当に Storage に上がっているか（大きさも合っているか）。保存する本人の権限で見る（＝自分の会社のファイルだけ見える）
create or replace function guard_consent_document_file() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare found boolean := false; sz bigint;
begin
  if to_regclass('storage.objects') is null then return new; end if;   -- Supabase 以外での検証用
  execute 'select true, nullif(o.metadata->>''size'', '''')::bigint from storage.objects o where o.bucket_id = ''consents'' and o.name = $1 limit 1'
    into found, sz using new.file_path;
  if not coalesce(found, false) then raise exception 'consent_file_missing' using hint = '0025：署名済みPDFが Storage にありません'; end if;
  if sz is not null and sz <> new.file_size then raise exception 'consent_file_size_mismatch' using hint = '0025：署名済みPDFの大きさが合いません'; end if;
  return new;
end $$;
revoke all on function guard_consent_document_file() from public, anon;
grant execute on function guard_consent_document_file() to authenticated;
drop trigger if exists t_consent_documents_20_file on consent_documents;
create trigger t_consent_documents_20_file before insert on consent_documents
  for each row execute function guard_consent_document_file();

-- ---------------------------------------------------------
-- ★M3：署名済みは「追記のみ」。中身（だれの・いつ・どの書類・PDF）は、だれにも書き換えられない。
--   変えられるのは次の3つだけ：
--    (a) 取り消しの印（void_consent_document の中でだけ。1回きり）
--    (b) お客様の付け替え（merge_customers の中でだけ）
--    (c) テンプレ・スタッフを消したときに、その参照が空になること（外部キーの on delete set null）
--   削除：ログイン中の人（アプリ・API）からは、だれもできない。SQL エディタ（管理者）からの削除だけ通し、audit_logs に残す
-- ---------------------------------------------------------
create or replace function guard_consent_document_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if auth.uid() is not null then
      raise exception 'consent_document_immutable' using hint = '0025：署名済みの書類は削除できません（オーナーが「取り消し」の印を付けられます）';
    end if;
    insert into audit_logs (actor, actor_name, store_id, table_name, row_id, action, reason, before)
    values (null, 'SQL:' || session_user, old.store_id, 'consent_documents', old.id::text, 'delete', 'SQL からの削除（保存期間の整理など）',
            jsonb_build_object('customer_id', old.customer_id, 'template_title', old.template_title, 'signed_at', old.signed_at,
                               'file_path', old.file_path, 'file_sha256', old.file_sha256, 'voided_at', old.voided_at));
    return old;
  end if;
  -- UPDATE
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.store_id is distinct from old.store_id
     or new.template_title is distinct from old.template_title or new.signer_name is distinct from old.signer_name
     or new.signed_at is distinct from old.signed_at or new.created_at is distinct from old.created_at
     or new.signed_by_name is distinct from old.signed_by_name
     or new.file_path is distinct from old.file_path or new.file_sha256 is distinct from old.file_sha256 or new.file_size is distinct from old.file_size then
    raise exception 'consent_document_immutable' using hint = '0025：署名済みの書類は書き換えられません';
  end if;
  if new.template_id is distinct from old.template_id
     and not (new.template_id is null and not exists (select 1 from consent_templates where id = old.template_id)) then
    raise exception 'consent_document_immutable' using hint = '0025：署名済みの書類のテンプレは変えられません';
  end if;
  if new.signed_by_staff_id is distinct from old.signed_by_staff_id
     and not (new.signed_by_staff_id is null and not exists (select 1 from staff where id = old.signed_by_staff_id)) then
    raise exception 'consent_document_immutable' using hint = '0025：署名済みの書類の担当は変えられません';
  end if;
  if new.customer_id is distinct from old.customer_id and coalesce(current_setting('app.consent_merge', true), '') <> 'on' then
    raise exception 'consent_document_immutable' using hint = '0025：署名済みの書類のお客様は、統合のときだけ付け替えられます';
  end if;
  if new.voided_by_staff_id is distinct from old.voided_by_staff_id and new.voided_by_staff_id is null
     and new.voided_at is not distinct from old.voided_at and new.void_reason is not distinct from old.void_reason and new.voided_by_name is not distinct from old.voided_by_name
     and not exists (select 1 from staff where id = old.voided_by_staff_id) then
    return new;   -- 取り消したスタッフを消したとき（参照が空になるだけ）
  end if;
  if new.voided_at is distinct from old.voided_at or new.void_reason is distinct from old.void_reason
     or new.voided_by_name is distinct from old.voided_by_name or new.voided_by_staff_id is distinct from old.voided_by_staff_id then
    if old.voided_at is not null or coalesce(current_setting('app.consent_void', true), '') <> 'on' then
      raise exception 'consent_document_immutable' using hint = '0025：取り消しの印は、オーナーが1回だけ付けられます（外せません）';
    end if;
  end if;
  return new;
end $$;
revoke all on function guard_consent_document_change() from public, anon, authenticated;
drop trigger if exists t_consent_documents_30_change on consent_documents;
create trigger t_consent_documents_30_change before update or delete on consent_documents
  for each row execute function guard_consent_document_change();

-- 署名した記録を audit_logs に残す（だれが・いつ・どの書類・PDFの指紋。お客様の名前は入れない）
create or replace function log_consent_document_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into audit_logs (actor, actor_staff_id, actor_name, store_id, table_name, row_id, action, after)
  values (auth.uid(), new.signed_by_staff_id, coalesce(new.signed_by_name, ''), new.store_id, 'consent_documents', new.id::text, 'sign',
          jsonb_build_object('customer_id', new.customer_id, 'template_id', new.template_id, 'template_title', new.template_title,
                             'signed_at', new.signed_at, 'file_path', new.file_path, 'file_sha256', new.file_sha256, 'file_size', new.file_size));
  return null;
end $$;
revoke all on function log_consent_document_insert() from public, anon, authenticated;
drop trigger if exists t_consent_documents_90_log on consent_documents;
create trigger t_consent_documents_90_log after insert on consent_documents
  for each row execute function log_consent_document_insert();

-- 取り消し（オーナーだけ・理由は必須・1回きり）。行とPDFは残し、「取り消し済み」の印を付ける。audit_logs に残す
create or replace function void_consent_document(p_id uuid, p_reason text) returns consent_documents
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d consent_documents; st staff; why text := btrim(coalesce(p_reason, ''));
begin
  select * into d from consent_documents where id = p_id for update;
  if d.id is null or not exists (select 1 from my_company_ids() c where c = d.company_id) then raise exception 'consent_not_found'; end if;
  select * into st from staff where auth_user_id = auth.uid() and company_id = d.company_id and coalesce(active, true) and role = 'owner' limit 1;
  if st.id is null then raise exception 'consent_void_forbidden' using hint = '0025：取り消しはオーナーだけができます'; end if;
  if length(why) < 1 or length(why) > 200 then raise exception 'consent_void_reason'; end if;
  if d.voided_at is not null then raise exception 'consent_already_voided'; end if;
  perform set_config('app.consent_void', 'on', true);
  update consent_documents set voided_at = now(), voided_by_staff_id = st.id, voided_by_name = st.name, void_reason = why where id = d.id returning * into d;
  perform set_config('app.consent_void', '', true);
  insert into audit_logs (actor, actor_staff_id, actor_name, store_id, table_name, row_id, action, reason, before, after)
  values (auth.uid(), st.id, coalesce(st.name, ''), d.store_id, 'consent_documents', d.id::text, 'void', why,
          jsonb_build_object('voided_at', null),
          jsonb_build_object('voided_at', d.voided_at, 'customer_id', d.customer_id, 'template_title', d.template_title, 'signed_at', d.signed_at, 'file_sha256', d.file_sha256));
  return d;
end $$;
revoke all on function void_consent_document(uuid, text) from public, anon;
grant execute on function void_consent_document(uuid, text) to authenticated;

-- ---------------------------------------------------------
-- ★M5：お客様の統合で、署名済みの同意書も残す側へ移す。
--   0022 の merge_customers をそのまま写し、★0025 の行（consent_documents の付け替えと件数）だけ足したもの。0022 のファイルは触らない
-- ---------------------------------------------------------
create or replace function merge_customers(p_keep uuid, p_merge uuid, p_store uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k customers; m customers; v_role text; v_store uuid; v_staff staff; n int;
  n_bookings int := 0; n_sales int := 0; n_kartes int := 0; n_hist int := 0; n_msgs int := 0; n_consents int := 0;
  lk line_links; lm line_links; v_line text := 'none';
begin
  if p_keep is null or p_merge is null or p_keep = p_merge then raise exception 'merge_same'; end if;
  select * into k from customers where id = p_keep;
  select * into m from customers where id = p_merge;
  if k.id is null or m.id is null then raise exception 'not_found'; end if;
  if k.company_id <> m.company_id then raise exception 'merge_company_mismatch'; end if;
  if k.merged_into is not null or m.merged_into is not null then raise exception 'already_merged'; end if;
  v_role := my_role_in_company(k.company_id);
  if not coalesce(can_write_company(k.company_id), false) then raise exception 'forbidden'; end if;
  -- 監査ログの店舗（見られるのはその会社のスタッフ）
  if p_store is not null and exists (select 1 from stores s where s.id = p_store and s.company_id = k.company_id) then v_store := p_store;
  else select id into v_store from stores where company_id = k.company_id order by created_at limit 1; end if;
  select * into v_staff from staff where auth_user_id = auth.uid() and company_id = k.company_id and coalesce(active, true)
   order by case role when 'owner' then 0 when 'manager' then 1 when 'staff' then 2 else 3 end limit 1;

  perform pg_advisory_xact_lock(hashtext('merge_customers:' || k.company_id::text));

  -- 締め済みの伝票も移す（お客様だけ。金額は変えない）
  perform set_config('app.sale_edit', 'on', true);
  update sales set customer_id = k.id where customer_id = m.id; get diagnostics n_sales = row_count;
  perform set_config('app.sale_edit', '', true);
  update bookings set customer_id = k.id where customer_id = m.id; get diagnostics n_bookings = row_count;
  update karte_entries set customer_id = k.id where customer_id = m.id; get diagnostics n_kartes = row_count;
  -- ★0025：署名済みの同意書・問診票も残す側へ（中身は変えない。お客様の付け替えだけを、この関数の中でだけ許す）
  perform set_config('app.consent_merge', 'on', true);
  update consent_documents set customer_id = k.id where customer_id = m.id; get diagnostics n_consents = row_count;
  perform set_config('app.consent_merge', '', true);
  if to_regclass('public.historical_visits') is not null then
    execute 'update historical_visits set customer_id = $1 where customer_id = $2' using k.id, m.id; get diagnostics n_hist = row_count;
  end if;
  if to_regclass('public.line_messages') is not null then
    execute 'update line_messages set customer_id = $1 where customer_id = $2' using k.id, m.id; get diagnostics n_msgs = row_count;
    execute 'update line_send_queue set customer_id = $1 where customer_id = $2' using k.id, m.id;
    execute 'update line_link_tokens set customer_id = $1 where customer_id = $2 and used_at is null' using k.id, m.id;
  end if;
  if to_regclass('public.line_link_requests') is not null then
    execute 'update line_link_requests set status = ''expired'', decided_at = now() where customer_id = $1 and status = ''pending''' using m.id;
  end if;
  -- LINE のつながり
  if to_regclass('public.line_links') is not null then
    select * into lk from line_links where customer_id = k.id limit 1;
    select * into lm from line_links where customer_id = m.id limit 1;
    if lm.id is not null then
      if lk.id is null then
        update line_links set customer_id = k.id, updated_at = now() where id = lm.id; v_line := 'moved';
      else
        update line_links set customer_id = null, updated_at = now() where id = lm.id; v_line := 'kept';
      end if;
    end if;
  end if;
  -- 空の項目を埋める（残す側の値が優先）
  update customers set
    kana = coalesce(nullif(btrim(k.kana), ''), m.kana),
    phone = coalesce(nullif(btrim(k.phone), ''), m.phone),
    email = coalesce(nullif(btrim(k.email), ''), m.email),
    birth_month = coalesce(nullif(btrim(k.birth_month), ''), m.birth_month),
    gender = coalesce(nullif(btrim(k.gender), ''), m.gender),
    source = coalesce(nullif(btrim(k.source), ''), m.source),
    note = case when coalesce(btrim(k.note), '') = '' then m.note when coalesce(btrim(m.note), '') = '' then k.note else k.note || E'\n' || m.note end,
    birthday = coalesce(k.birthday, m.birthday),
    postal_code = coalesce(nullif(btrim(k.postal_code), ''), m.postal_code),
    address = coalesce(nullif(btrim(k.address), ''), m.address),
    import_source = coalesce(k.import_source, m.import_source),
    external_id = coalesce(nullif(btrim(k.external_id), ''), m.external_id)
  where id = k.id;
  update customers set merged_into = k.id where id = m.id;
  insert into audit_logs (actor, actor_staff_id, actor_name, store_id, table_name, row_id, action, before, after)
  values (auth.uid(), v_staff.id, coalesce(v_staff.name, ''), v_store, 'customers', k.id::text, 'merge',
          jsonb_build_object('merged_id', m.id, 'kept_id', k.id),
          jsonb_build_object('kept_id', k.id, 'merged_id', m.id, 'bookings', n_bookings, 'sales', n_sales, 'kartes', n_kartes, 'consents', n_consents, 'historical_visits', n_hist, 'line_messages', n_msgs, 'line', v_line, 'role', v_role));
  return jsonb_build_object('ok', true, 'kept_id', k.id, 'merged_id', m.id, 'bookings', n_bookings, 'sales', n_sales, 'kartes', n_kartes, 'consents', n_consents, 'historical_visits', n_hist, 'line', v_line);
end $$;
revoke all on function merge_customers(uuid, uuid, uuid) from public, anon;
grant execute on function merge_customers(uuid, uuid, uuid) to authenticated;

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

-- 署名済みの書類：読む＝その会社の在籍スタッフ／作る＝viewer 以外／★書き換え・削除の方針は作らない（だれにも許さない）
drop policy if exists consent_documents_sel on consent_documents;
create policy consent_documents_sel on consent_documents for select
  using (store_id in (select id from stores where company_id in (select my_company_ids())));
drop policy if exists consent_documents_ins on consent_documents;
create policy consent_documents_ins on consent_documents for insert
  with check (can_write_store(store_id));
drop policy if exists consent_documents_upd on consent_documents;
drop policy if exists consent_documents_del on consent_documents;

-- 権限：未ログイン（anon）は不可。ログイン済みは、テンプレ＝読み書き（方針で owner・manager に絞る）。
-- 署名済みの書類＝読むことと「決まった列だけ」の追加。署名日時・担当・会社・テンプレ名・取り消しの列は、そもそも送れない。
-- TRUNCATE・REFERENCES・TRIGGER も付けない（L9）
revoke all on consent_templates, consent_documents from anon;
revoke all on consent_templates, consent_documents from authenticated;
grant select, insert, update, delete on consent_templates to authenticated;
grant select on consent_documents to authenticated;
grant insert (id, store_id, customer_id, template_id, signer_name, file_path, file_sha256, file_size) on consent_documents to authenticated;

-- =========================================================
-- 4) Storage（非公開バケット consents と、パスごとの権限）
-- =========================================================
-- パスの1つ目＝会社ID、2つ目＝consent-templates か consents。
-- 読む＝その会社の在籍スタッフ。
-- consent-templates/ に書く（上げる・差し替える・消す）＝owner・manager。
-- consents/（署名済みPDF）：
--   上げる＝viewer 以外。名前は <会社ID>/consents/<書類ID>.pdf だけ
--   ★差し替え（上書き・改名）＝だれにも許さない（アプリも upsert を使わない）
--   消す＝「記録（consent_documents）がまだ無いPDF」だけ（保存に失敗したときの片づけ用。viewer 以外）。記録のあるPDFは、だれも消せない
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
  -- ここから consents/（署名済みPDF）
  if not coalesce(role in ('owner', 'manager', 'staff'), false) then return false; end if;
  if p_op = 'insert' then
    return p_name ~ ('^' || cid || '/consents/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$');
  end if;
  if p_op = 'delete' then
    return not exists (select 1 from consent_documents d where d.file_path = p_name);
  end if;
  return false;   -- update（上書き・改名）は不可
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
select '0025 OK：同意書・問診票（テンプレ・署名済みの書類＝追記のみ・保存先 consents・統合で同意書も移す）を用意しました' as result,
       (select count(*) from consent_templates) as templates, (select count(*) from consent_documents) as documents;
