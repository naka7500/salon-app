-- フェーズE-1：HPB（ホットペッパービューティー）の予約通知メールを自動で台帳に取り込む（取り込みだけ。サロンボードへの書き込みはしない）。
-- ※必ず 0010_karte_handwriting.sql の後に流すこと（0010 が無いと最初で止まります。DBは何も変わりません）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists）。
-- 0011 が未適用でもアプリは落ちない（設定＞HPB連携 が「準備中」になるだけ）。
--
-- やること
--  1) hpb_settings：店舗ごとの オン/オフ・合言葉（ハッシュだけ保存）・登録するメールアドレス・いつものメニュー・読み取りの調整
--  2) hpb_mappings：対応表（HPBのクーポン名に「〇〇」が入っていたら → 自社メニュー・人数／HPBのスタッフ名 → 自社の担当）
--  3) inbound_mails：受信ログ（届いたメールの原文・読み取り結果・やったこと・エラー）。message_id は重複させない
--  4) bookings.alert：予約の印（double_booking＝ダブルブッキングの可能性）。HPB の予約を探すための索引
--  5) notifications.kind に HPB 用の種類を足す（台帳の「新着」バッジ）
--  6) inbound_find_customer()：電話（数字だけ）→ カナ＋名前 でお客様を探す（サーバのサービスキーだけが使える）
--  7) 書き込みは owner・manager（受信ログはサーバ＝サービスキーだけが書く）。未ログイン（anon）からは触れない

do $$ begin
  if to_regclass('public.karte_pages') is null then
    raise exception '0010 がまだ流れていません。先に 0010_karte_handwriting.sql を流してから、この 0011 を流してください';
  end if;
  if to_regprocedure('public.is_store_admin(uuid)') is null then
    raise exception '0008 がまだ流れていません。0008 → 0009 → 0010 → 0011 の順に流してください';
  end if;
end $$;

-- =========================================================
-- 1) 店舗ごとの設定
-- =========================================================
create table if not exists hpb_settings (
  store_id uuid primary key references stores(id) on delete cascade,
  enabled boolean not null default false,
  secret_hash text,                                  -- 合言葉の SHA-256（16進）。合言葉そのものは保存しない
  secret_set_at timestamptz,
  plus_address text,                                 -- サロンボードの通知先に足すアドレス（例 kokage.corp+hpb-test-store@gmail.com）
  default_menu_id uuid references menus(id) on delete set null,
  parser_config jsonb not null default '{}',         -- 読み取りの調整（予約番号の形・件名の言葉）
  updated_at timestamptz not null default now()
);
alter table hpb_settings drop constraint if exists hpb_settings_hash_check;
alter table hpb_settings add constraint hpb_settings_hash_check check (secret_hash is null or secret_hash ~ '^[0-9a-f]{64}$');

-- =========================================================
-- 2) 対応表
-- =========================================================
create table if not exists hpb_mappings (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  kind text not null check (kind in ('menu', 'staff')),
  pattern text not null,
  menu_id uuid references menus(id) on delete cascade,
  people int,
  staff_id uuid references staff(id) on delete cascade,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table hpb_mappings drop constraint if exists hpb_mappings_target_check;
alter table hpb_mappings add constraint hpb_mappings_target_check check ((kind = 'menu' and menu_id is not null) or (kind = 'staff' and staff_id is not null));
alter table hpb_mappings drop constraint if exists hpb_mappings_pattern_check;
alter table hpb_mappings add constraint hpb_mappings_pattern_check check (length(btrim(pattern)) between 1 and 100);
alter table hpb_mappings drop constraint if exists hpb_mappings_people_check;
alter table hpb_mappings add constraint hpb_mappings_people_check check (people is null or people between 1 and 4);
create index if not exists hpb_mappings_store_idx on hpb_mappings (store_id, kind, sort_order);

-- =========================================================
-- 3) 受信ログ
-- =========================================================
create table if not exists inbound_mails (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  source text not null default 'hpb',
  message_id text not null,
  received_at timestamptz,
  subject text,
  body text,
  from_address text,
  parsed jsonb,                                      -- 読み取り結果
  manual jsonb,                                      -- 受信ログの「手で直す」で入れた値
  kind text,                                         -- new / change / cancel / unknown
  reservation_no text,
  status text not null default 'received' check (status in ('received', 'done', 'warn', 'review', 'error', 'ignored', 'duplicate')),
  action text,                                       -- やったこと（日本語）
  error text,
  booking_id uuid references bookings(id) on delete set null,
  booking_ids uuid[] not null default '{}',
  is_test boolean not null default false,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create unique index if not exists inbound_mails_message_uq on inbound_mails (message_id);
create index if not exists inbound_mails_store_idx on inbound_mails (store_id, created_at desc);
create index if not exists inbound_mails_ref_idx on inbound_mails (store_id, reservation_no);
alter table inbound_mails drop constraint if exists inbound_mails_body_check;
alter table inbound_mails add constraint inbound_mails_body_check check (length(coalesce(body, '')) <= 100000 and length(message_id) between 1 and 300);

-- =========================================================
-- 4) 予約の印・HPB予約の索引
-- =========================================================
alter table bookings add column if not exists alert text;
alter table bookings drop constraint if exists bookings_alert_check;
alter table bookings add constraint bookings_alert_check check (alert is null or alert in ('double_booking'));
create index if not exists bookings_hpb_ref_idx on bookings (store_id, external_ref) where channel = 'hpb';

-- =========================================================
-- 5) 通知の種類
-- =========================================================
alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('new_booking', 'cancel_booking', 'booking_confirmation', 'cancel_confirmation', 'hpb_booking', 'hpb_change', 'hpb_cancel', 'hpb_attention'));

-- =========================================================
-- 6) お客様を探す（サーバ専用）。電話が一致 → 1人ならその人。電話が無いときはカナ（＋名前）が一致する人がちょうど1人ならその人
-- =========================================================
create or replace function inbound_find_customer(p_company uuid, p_phone text, p_kana text, p_name text) returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid; n int; k text := regexp_replace(coalesce(p_kana, ''), '[\s　]', '', 'g'); nm text := regexp_replace(coalesce(p_name, ''), '[\s　]', '', 'g');
  ph text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
begin
  if ph ~ '^81[0-9]{9,10}$' then ph := '0' || substr(ph, 3); end if;
  if length(ph) >= 10 then
    select min(c.id::text)::uuid, count(*) into v, n from customers c
     where c.company_id = p_company and c.merged_into is null
       and (case when regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') ~ '^81[0-9]{9,10}$' then '0' || substr(regexp_replace(c.phone, '[^0-9]', '', 'g'), 3) else regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') end) = ph;
    if n >= 1 then return v; end if;
  end if;
  if length(k) >= 2 then
    select min(c.id::text)::uuid, count(*) into v, n from customers c
     where c.company_id = p_company and c.merged_into is null
       and regexp_replace(coalesce(c.kana, ''), '[\s　]', '', 'g') = k
       and (nm = '' or nm = k or regexp_replace(c.name, '[\s　]', '', 'g') = nm or regexp_replace(c.name, '[\s　]', '', 'g') = k);
    if n = 1 then return v; end if;
  end if;
  return null;
end $$;
revoke all on function inbound_find_customer(uuid, text, text, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function inbound_find_customer(uuid, text, text, text) to service_role';
  end if;
end $$;

-- =========================================================
-- 7) RLS
-- =========================================================
alter table hpb_settings enable row level security;
alter table hpb_mappings enable row level security;
alter table inbound_mails enable row level security;

-- 設定（合言葉のハッシュを含む）：見る・変えるのは owner・manager だけ
drop policy if exists hpb_settings_sel on hpb_settings;
drop policy if exists hpb_settings_ins on hpb_settings;
drop policy if exists hpb_settings_upd on hpb_settings;
drop policy if exists hpb_settings_del on hpb_settings;
create policy hpb_settings_sel on hpb_settings for select using (is_store_admin(store_id));
create policy hpb_settings_ins on hpb_settings for insert with check (is_store_admin(store_id));
create policy hpb_settings_upd on hpb_settings for update using (is_store_admin(store_id)) with check (is_store_admin(store_id));
create policy hpb_settings_del on hpb_settings for delete using (is_store_admin(store_id));

-- 対応表：読むのは会社のスタッフ、書くのは owner・manager（メニュー・担当は同じ店舗・会社のものだけ）
drop policy if exists hpb_mappings_sel on hpb_mappings;
drop policy if exists hpb_mappings_ins on hpb_mappings;
drop policy if exists hpb_mappings_upd on hpb_mappings;
drop policy if exists hpb_mappings_del on hpb_mappings;
create policy hpb_mappings_sel on hpb_mappings for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy hpb_mappings_ins on hpb_mappings for insert with check (is_store_admin(store_id)
  and (menu_id is null or menu_id in (select m.id from menus m where m.store_id = hpb_mappings.store_id))
  and (staff_id is null or staff_id in (select s.id from staff s join stores st on st.company_id = s.company_id where st.id = hpb_mappings.store_id)));
create policy hpb_mappings_upd on hpb_mappings for update using (is_store_admin(store_id)) with check (is_store_admin(store_id)
  and (menu_id is null or menu_id in (select m.id from menus m where m.store_id = hpb_mappings.store_id))
  and (staff_id is null or staff_id in (select s.id from staff s join stores st on st.company_id = s.company_id where st.id = hpb_mappings.store_id)));
create policy hpb_mappings_del on hpb_mappings for delete using (is_store_admin(store_id));

-- 受信ログ：見るのは owner・manager だけ（お客様の名前・電話が入っているため）。書くのはサーバ（サービスキー）だけ
drop policy if exists inbound_mails_sel on inbound_mails;
create policy inbound_mails_sel on inbound_mails for select using (is_store_admin(store_id));

revoke all on hpb_settings, hpb_mappings, inbound_mails from anon;
revoke all on inbound_mails from authenticated;
grant select on inbound_mails to authenticated;
grant select, insert, update, delete on hpb_settings, hpb_mappings to authenticated;

-- 未ログイン（anon）からは表を一切触れないように（新しい表にも付け直す）
revoke all on all tables in schema public from anon;

-- API（PostgREST）に新しい表・列をすぐ見せる
notify pgrst, 'reload schema';

select '0011 OK：HPBの予約メール取り込み（受信ログ・設定・対応表・予約の印）を用意しました' as result,
       (select count(*) from hpb_settings) as settings, (select count(*) from inbound_mails) as mails;
