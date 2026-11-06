-- 予約トラッキング（予約の 登録・変更・キャンセル・削除 を全部残す）／会計の主担当に受付枠・フリー／リピート率推移表の区分の決め方。
-- ※必ず 0012_customer_import.sql の後に流すこと（0012 が無いと最初で止まります。DBは何も変わりません）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists）。
-- 0013 が未適用でもアプリは落ちない（予約トラッキングは「準備中」、主担当の受付枠は保存されない、区分の決め方は既定値で計算）。
--
-- やること
--  1) booking_history に 店舗・操作（登録/変更/キャンセル/削除）・経路（ネット予約/予約台帳/HPB取り込み/自動）・操作した人 を足す
--     トリガーを「登録」にも広げ、誰が・どこから を自動で入れる（画面から送られた名前は使わない）。記録は消さない（期限なし）
--     ・ログイン中のスタッフ → 予約台帳（そのスタッフ名）
--     ・サービスキーで HPB の予約 → HPB取り込み（0011 のサーバ）
--     ・未ログイン（anon）→ ネット予約（public_create_booking / public_cancel_booking）
--     ・関数の中で set_config('app.booking_source', ...) を入れたときはそれを使う
--  2) booking_history は見るだけ（同じ会社のスタッフ）。直接の書き込み・書き換え・削除はできない（トリガーだけが書く）
--  3) sales に main_label（「1名様でのご予約」「フリー」など）・main_lane_id。売上の担当は明細担当（sale_lines.staff_id）で数える
--     明細担当は同じ会社のスタッフだけ（ほかの店舗のヘルプの人も可）。赤伝は元の伝票の主担当を引き継ぐ
--  4) store_report_settings：店舗ごとのリピート率推移表の区分の決め方（新規・再来・準固定・固定）。書くのは owner・manager
--  5) 未ログイン（anon）からは触れない

do $$ begin
  if to_regclass('public.historical_visits') is null or to_regclass('public.import_logs') is null then
    raise exception '0012 がまだ流れていません。先に 0012_customer_import.sql を流してから、この 0013 を流してください';
  end if;
  if to_regprocedure('public.my_role_in_company(uuid)') is null or to_regprocedure('public.is_store_admin(uuid)') is null then
    raise exception '0008 がまだ流れていません。0008 → … → 0012 → 0013 の順に流してください';
  end if;
end $$;

-- =========================================================
-- 1) 予約トラッキング
-- =========================================================
alter table booking_history add column if not exists store_id uuid references stores(id) on delete cascade;
alter table booking_history add column if not exists op text;
alter table booking_history add column if not exists source text;
alter table booking_history add column if not exists actor_staff_id uuid references staff(id) on delete set null;
alter table booking_history add column if not exists actor_name text;
alter table booking_history drop constraint if exists booking_history_op_check;
alter table booking_history add constraint booking_history_op_check check (op is null or op in ('insert', 'update', 'cancel', 'delete'));
alter table booking_history drop constraint if exists booking_history_source_check;
alter table booking_history add constraint booking_history_source_check check (source is null or source in ('web', 'ledger', 'hpb', 'system'));

-- これまでの記録（0001 のトリガーが残した「変更・削除」）に店舗と操作を入れる。経路は分からないので system
update booking_history set store_id = coalesce(nullif(after ->> 'store_id', ''), nullif(before ->> 'store_id', ''))::uuid
 where store_id is null and coalesce(nullif(after ->> 'store_id', ''), nullif(before ->> 'store_id', '')) is not null
   and exists (select 1 from stores s where s.id = coalesce(nullif(after ->> 'store_id', ''), nullif(before ->> 'store_id', ''))::uuid);
update booking_history set op = case when after is null then 'delete'
                                     when (after ->> 'status') = 'cancelled' and coalesce(before ->> 'status', '') <> 'cancelled' then 'cancel'
                                     else 'update' end
 where op is null;
update booking_history set source = 'system' where source is null;
create index if not exists booking_history_booking_idx on booking_history (booking_id, changed_at);
create index if not exists booking_history_store_idx on booking_history (store_id, changed_at desc);

create or replace function log_booking_history() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o jsonb; n jsonb; v_store uuid; v_op text; v_src text; v_role text; v_staff uuid; v_name text; v_uid uuid; v_claims text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'block' then return new; end if;          -- ×・IDLE・休憩などのブロックは残さない
    o := null; n := to_jsonb(new); v_store := new.store_id; v_op := 'insert';
  elsif tg_op = 'UPDATE' then
    if old.status = 'block' and new.status = 'block' then return new; end if;
    o := to_jsonb(old); n := to_jsonb(new); v_store := new.store_id;
    if (o - 'updated_at') = (n - 'updated_at') then return new; end if;   -- 何も変わっていない
    v_op := case when new.status = 'cancelled' and old.status <> 'cancelled' then 'cancel' else 'update' end;
  else
    if old.status = 'block' then return old; end if;
    o := to_jsonb(old); n := null; v_store := old.store_id; v_op := 'delete';
  end if;

  -- 誰が：ログイン中のスタッフ（同じ会社）
  v_claims := nullif(current_setting('request.jwt.claims', true), '');
  v_role := coalesce(case when v_claims is not null then v_claims::jsonb ->> 'role' end, nullif(current_setting('request.jwt.claim.role', true), ''), '');
  begin v_uid := auth.uid(); exception when others then v_uid := null; end;
  if v_uid is not null then
    select s.id, s.name into v_staff, v_name from staff s join stores st on st.company_id = s.company_id
     where st.id = v_store and s.auth_user_id = v_uid
     order by case s.role when 'owner' then 0 when 'manager' then 1 when 'staff' then 2 else 3 end limit 1;
  end if;
  -- どこから
  v_src := nullif(current_setting('app.booking_source', true), '');
  if v_src is null or v_src not in ('web', 'ledger', 'hpb', 'system') then
    v_src := case
      when v_staff is not null then 'ledger'
      when v_role = 'service_role' and coalesce(n ->> 'channel', o ->> 'channel') = 'hpb' then 'hpb'
      when v_role = 'anon' then 'web'
      else 'system' end;
  end if;

  insert into booking_history (booking_id, store_id, changed_at, changed_by, op, source, actor_staff_id, actor_name, before, after)
  values (coalesce(new.id, old.id), v_store, now(), v_uid, v_op, v_src, v_staff, v_name, o, n);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke all on function log_booking_history() from public, anon;

drop trigger if exists t_bookings_hist on bookings;
create trigger t_bookings_hist after insert or update or delete on bookings for each row execute function log_booking_history();

-- =========================================================
-- 2) booking_history の権限：見るのは同じ会社のスタッフ。書くのはトリガーだけ
-- =========================================================
alter table booking_history enable row level security;
drop policy if exists booking_history_ins on booking_history;
drop policy if exists booking_history_sel on booking_history;
create policy booking_history_sel on booking_history for select using (
  (store_id is not null and store_id in (select id from stores where company_id in (select my_company_ids())))
  or (store_id is null and booking_id in (select id from bookings)));
revoke all on booking_history from anon;
revoke insert, update, delete, truncate on booking_history from authenticated;
grant select on booking_history to authenticated;

-- =========================================================
-- 3) 会計：主担当の受付枠・フリー／明細担当は同じ会社のスタッフ
-- =========================================================
alter table sales add column if not exists main_label text;
alter table sales add column if not exists main_lane_id uuid references lanes(id) on delete set null;
alter table sales drop constraint if exists sales_main_label_check;
alter table sales add constraint sales_main_label_check check (main_label is null or length(btrim(main_label)) between 1 and 60);

create or replace function guard_sale_main() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- 赤伝は元の伝票の主担当（受付枠・フリー）を引き継ぐ（0007 の reverse_sale はこの2列を知らないため）
  if tg_op = 'INSERT' and new.status = 'reversal' and new.reverses_sale_id is not null and new.main_label is null and new.main_staff_id is null then
    select main_label, main_lane_id into new.main_label, new.main_lane_id from sales where id = new.reverses_sale_id;
  end if;
  if new.main_lane_id is not null and not exists (select 1 from lanes l where l.id = new.main_lane_id and l.store_id = new.store_id) then
    raise exception 'main_lane_store_mismatch';
  end if;
  return new;
end $$;
drop trigger if exists t_sales_main on sales;
create trigger t_sales_main before insert or update of main_label, main_lane_id, store_id on sales for each row execute function guard_sale_main();

create or replace function guard_sale_line_staff() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.staff_id is not null and not exists (
    select 1 from sales sa join stores st on st.id = sa.store_id join staff s on s.company_id = st.company_id
     where sa.id = new.sale_id and s.id = new.staff_id) then
    raise exception 'line_staff_company';
  end if;
  return new;
end $$;
revoke all on function guard_sale_line_staff() from public, anon;
drop trigger if exists t_sale_lines_staff on sale_lines;
create trigger t_sale_lines_staff before insert or update of staff_id, sale_id on sale_lines for each row execute function guard_sale_line_staff();

-- =========================================================
-- 4) リピート率推移表の区分の決め方（店舗ごと）
-- =========================================================
create table if not exists store_report_settings (
  store_id uuid primary key references stores(id) on delete cascade,
  repeat_rules jsonb not null default '{"repeat_max": 2, "semi_max": 2}',
  updated_at timestamptz not null default now()
);
alter table store_report_settings drop constraint if exists store_report_settings_rules_check;
alter table store_report_settings add constraint store_report_settings_rules_check check (
  jsonb_typeof(repeat_rules) = 'object'
  and (repeat_rules ->> 'repeat_max') ~ '^[0-9]{1,3}$' and (repeat_rules ->> 'semi_max') ~ '^[0-9]{1,3}$'
  and (repeat_rules ->> 'repeat_max')::int between 2 and 50
  and (repeat_rules ->> 'semi_max')::int between (repeat_rules ->> 'repeat_max')::int and 100
  and length(repeat_rules::text) <= 500);
alter table store_report_settings enable row level security;
drop policy if exists store_report_settings_sel on store_report_settings;
drop policy if exists store_report_settings_ins on store_report_settings;
drop policy if exists store_report_settings_upd on store_report_settings;
drop policy if exists store_report_settings_del on store_report_settings;
create policy store_report_settings_sel on store_report_settings for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy store_report_settings_ins on store_report_settings for insert with check (is_store_admin(store_id));
create policy store_report_settings_upd on store_report_settings for update using (is_store_admin(store_id)) with check (is_store_admin(store_id));
create policy store_report_settings_del on store_report_settings for delete using (is_store_admin(store_id));
revoke all on store_report_settings from anon;
grant select, insert, update, delete on store_report_settings to authenticated;

-- 未ログイン（anon）からは表を一切触れないように（新しい表にも付け直す）
revoke all on all tables in schema public from anon;

-- API（PostgREST）に新しい表・列をすぐ見せる
notify pgrst, 'reload schema';

select '0013 OK：予約トラッキング（登録・変更・キャンセル・削除を全部残す）・主担当の受付枠・リピート率の区分の決め方を用意しました' as result,
       (select count(*) from booking_history) as history_rows, (select count(*) from store_report_settings) as report_settings;
