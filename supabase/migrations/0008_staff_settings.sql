-- v0.9：設定＞スタッフ（オーナー・店長がスタッフを登録・編集）と、書き込み権限をDB側で守る。
-- ※先に 0006_phase_b.sql → 0007_phase_c.sql を流しておくこと（ネット予約の関数を作り直すため）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists）。
-- 0008 が未適用でもアプリは落ちない（スタッフ設定の新しい項目だけ「準備中」になる）。
--
-- やること
--  1) staff に列を足す：表示名・英語名・色・表示順・予約台帳に表示・ネット予約で指名可・所属店舗
--  2) my_role_in_company()：ログイン中の人のその会社での役割（SECURITY DEFINER）
--  3) staff / staff_stores / menus / coupons の書き込みは owner・manager だけ（読むのは今までどおり会社のスタッフ全員）
--  4) staff の守り：owner を作る・変えるのは owner だけ／自分の役割・在籍は自分で変えられない／ログインの紐づけは画面から変えられない
--  5) ネット予約の関数：退職・台帳非表示の人は割り当てない／指名は「指名可」の人だけ／表示名と指名料

do $$ begin
  if to_regclass('public.coupons') is null then raise exception '先に 0007_phase_c.sql を流してください'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'shifts' and column_name = 'break_start') then
    raise exception '先に 0006_phase_b.sql を流してください';
  end if;
end $$;

-- =========================================================
-- 1) staff の列（既にある列：name / role / nomination_fee / active / email / auth_user_id）
-- =========================================================
do $$
declare first_time boolean;
begin
  first_time := not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'staff' and column_name = 'show_on_ledger');
  alter table staff add column if not exists display_name text;                    -- 予約ページに出す名前（空＝名前）
  alter table staff add column if not exists name_en text;                         -- 英語名（インバウンド用）
  alter table staff add column if not exists color text;                           -- 予約台帳の色
  alter table staff add column if not exists sort_order int not null default 0;    -- 表示順
  alter table staff add column if not exists show_on_ledger boolean not null default true;   -- 予約台帳・シフト・会計に出す
  alter table staff add column if not exists web_nominatable boolean not null default true;  -- ネット予約で指名できる
  alter table staff add column if not exists home_store_id uuid references stores(id) on delete set null;  -- 所属店舗（ヘルプ先は staff_stores）
  if first_time then
    -- 最初の1回だけ：表示順・所属店舗を今のデータから入れる。店舗に紐づいていないオーナー行は台帳に出さない
    update staff s set sort_order = x.n from (
      select id, row_number() over (partition by company_id order by case role when 'owner' then 9 else 0 end, created_at, name) as n from staff) x
     where x.id = s.id;
    update staff s set home_store_id = (select ss.store_id from staff_stores ss join stores st on st.id = ss.store_id
                                         where ss.staff_id = s.id and st.company_id = s.company_id order by st.name limit 1)
     where s.home_store_id is null;
    update staff s set show_on_ledger = false
     where s.role = 'owner' and not exists (select 1 from staff_stores ss where ss.staff_id = s.id);
  end if;
end $$;
update staff set nomination_fee = 0 where nomination_fee is null;
alter table staff alter column nomination_fee set default 0;
alter table staff drop constraint if exists staff_nomination_fee_check;
alter table staff add constraint staff_nomination_fee_check check (nomination_fee is null or nomination_fee between 0 and 100000);
alter table staff drop constraint if exists staff_color_check;
alter table staff add constraint staff_color_check check (color is null or color ~ '^#[0-9a-fA-F]{6}$');
alter table staff drop constraint if exists staff_names_check;
alter table staff add constraint staff_names_check check (length(btrim(name)) between 1 and 40 and coalesce(length(display_name), 0) <= 40 and coalesce(length(name_en), 0) <= 60);
create index if not exists staff_company_sort_idx on staff (company_id, sort_order);

-- =========================================================
-- 2) 役割の判定（RLS から呼ぶ。SECURITY DEFINER なので staff の RLS に引っかからない）
-- =========================================================
create or replace function my_role_in_company(p_company uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from staff
   where auth_user_id = auth.uid() and company_id = p_company and coalesce(active, true)
   order by case role when 'owner' then 0 when 'manager' then 1 when 'staff' then 2 else 3 end
   limit 1
$$;
create or replace function is_company_admin(p_company uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(my_role_in_company(p_company) in ('owner', 'manager'), false)
$$;
create or replace function is_store_admin(p_store uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select is_company_admin(company_id) from stores where id = p_store), false)
$$;
revoke all on function my_role_in_company(uuid) from public, anon;
revoke all on function is_company_admin(uuid) from public, anon;
revoke all on function is_store_admin(uuid) from public, anon;
grant execute on function my_role_in_company(uuid) to authenticated;
grant execute on function is_company_admin(uuid) to authenticated;
grant execute on function is_store_admin(uuid) to authenticated;

-- =========================================================
-- 3) RLS：読むのは会社のスタッフ全員、書くのは owner・manager だけ
--    （今までの *_rw は「全員が読み書き」だったので外す。SQLエディタ・SECURITY DEFINER 関数は今までどおり通る）
-- =========================================================
-- staff
drop policy if exists staff_rw on staff;
drop policy if exists staff_sel on staff;
drop policy if exists staff_ins on staff;
drop policy if exists staff_upd on staff;
drop policy if exists staff_del on staff;
create policy staff_sel on staff for select using (company_id in (select my_company_ids()));
create policy staff_ins on staff for insert with check (is_company_admin(company_id));
create policy staff_upd on staff for update using (is_company_admin(company_id)) with check (is_company_admin(company_id));
create policy staff_del on staff for delete using (is_company_admin(company_id));

-- staff_stores（所属・ヘルプ店舗）：同じ会社のスタッフと店舗だけ
drop policy if exists staff_stores_rw on staff_stores;
drop policy if exists staff_stores_sel on staff_stores;
drop policy if exists staff_stores_ins on staff_stores;
drop policy if exists staff_stores_upd on staff_stores;
drop policy if exists staff_stores_del on staff_stores;
create policy staff_stores_sel on staff_stores for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy staff_stores_ins on staff_stores for insert with check (
  is_store_admin(store_id) and staff_id in (select s.id from staff s join stores st on st.company_id = s.company_id where st.id = store_id));
create policy staff_stores_upd on staff_stores for update using (is_store_admin(store_id)) with check (
  is_store_admin(store_id) and staff_id in (select s.id from staff s join stores st on st.company_id = s.company_id where st.id = store_id));
create policy staff_stores_del on staff_stores for delete using (is_store_admin(store_id));

-- menus（フェーズCでは画面だけで止めていた）
drop policy if exists menus_rw on menus;
drop policy if exists menus_sel on menus;
drop policy if exists menus_ins on menus;
drop policy if exists menus_upd on menus;
drop policy if exists menus_del on menus;
create policy menus_sel on menus for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy menus_ins on menus for insert with check (is_store_admin(store_id));
create policy menus_upd on menus for update using (is_store_admin(store_id)) with check (is_store_admin(store_id));
create policy menus_del on menus for delete using (is_store_admin(store_id));

-- coupons（同上）
drop policy if exists coupons_rw on coupons;
drop policy if exists coupons_sel on coupons;
drop policy if exists coupons_ins on coupons;
drop policy if exists coupons_upd on coupons;
drop policy if exists coupons_del on coupons;
create policy coupons_sel on coupons for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy coupons_ins on coupons for insert with check (is_store_admin(store_id));
create policy coupons_upd on coupons for update using (is_store_admin(store_id)) with check (is_store_admin(store_id));
create policy coupons_del on coupons for delete using (is_store_admin(store_id));

-- =========================================================
-- 4) staff の守り（画面・API＝authenticated からの書き込みだけを見る。SQLエディタや claim_staff() は通す）
-- =========================================================
create or replace function guard_staff_write() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare r text;
begin
  -- 所属店舗は同じ会社の店舗だけ（誰が書いても）
  if tg_op <> 'DELETE' and new.home_store_id is not null
     and not exists (select 1 from stores where id = new.home_store_id and company_id = new.company_id) then
    raise exception 'staff_store_mismatch';
  end if;
  if current_user <> 'authenticated' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  r := my_role_in_company(case when tg_op = 'DELETE' then old.company_id else new.company_id end);
  if tg_op = 'INSERT' then
    if new.auth_user_id is not null then raise exception 'staff_login_link_locked'; end if;
    if new.role = 'owner' and r is distinct from 'owner' then raise exception 'staff_owner_only'; end if;
    if coalesce(new.email, '') <> '' and r is distinct from 'owner' then raise exception 'staff_owner_only'; end if;
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if new.company_id <> old.company_id then raise exception 'staff_company_locked'; end if;
    if new.auth_user_id is distinct from old.auth_user_id then raise exception 'staff_login_link_locked'; end if;
    if (new.role = 'owner' or old.role = 'owner') and r is distinct from 'owner' then raise exception 'staff_owner_only'; end if;
    if new.email is distinct from old.email and (r is distinct from 'owner' or old.auth_user_id is not null) then raise exception 'staff_email_locked'; end if;
    -- 自分の役割・在籍は自分では変えられない（オーナーが自分を締め出さないように）
    if old.auth_user_id = auth.uid() and (new.role <> old.role or coalesce(new.active, true) <> coalesce(old.active, true)) then
      raise exception 'staff_cannot_change_self';
    end if;
    return new;
  end if;
  -- DELETE：ログインに紐づいた人・owner は消せない（履歴がある人は外部キーで止まる＝退職にする）
  if old.auth_user_id is not null then raise exception 'staff_cannot_delete_login'; end if;
  if old.role = 'owner' and r is distinct from 'owner' then raise exception 'staff_owner_only'; end if;
  return old;
end $$;
drop trigger if exists t_staff_guard on staff;
create trigger t_staff_guard before insert or update or delete on staff for each row execute function guard_staff_write();
revoke all on function guard_staff_write() from public, anon, authenticated;

-- =========================================================
-- 5) ネット予約：退職・台帳非表示の人は割り当てない／指名は「指名可」の人だけ／表示名・英語名・指名料
--    （0007 の関数を作り直す。変えたのは ★ の行だけ）
-- =========================================================
create or replace function _web_slots(p_store uuid, p_menu uuid, p_date date, p_staff uuid default null, p_coupon uuid default null)
returns table(slot_start timestamptz, staff_ids uuid[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  st stores; m menus; cp coupons; ln record;
  tz text; step int; dur int; blk int; lead timestamptz; today date;
  has_shift boolean; b record; t timestamptz; tl timestamp; te timestamp; tmin int; prev timestamptz := null;
  free uuid[]; unassigned int; used int; wd int;
begin
  select * into st from stores where id = p_store;
  if st.id is null then return; end if;
  tz := coalesce(st.timezone, 'Asia/Tokyo');
  today := (now() at time zone tz)::date;
  if p_date < today or p_date > today + st.booking_horizon_days then return; end if;
  select * into m from menus where id = p_menu and store_id = p_store and coalesce(active, true) and web_visible and category = 'technical';
  if m.id is null or not _published(m.publish_from, m.publish_to, tz) then return; end if;
  wd := extract(dow from p_date)::int;
  if coalesce(cardinality(m.weekdays), 0) > 0 and not (wd = any(m.weekdays)) then return; end if;
  if p_coupon is not null then
    select * into cp from coupons where id = p_coupon and store_id = p_store and active;
    if cp.id is null then return; end if;
    if coalesce(cardinality(cp.weekdays), 0) > 0 and not (wd = any(cp.weekdays)) then return; end if;
  end if;
  if p_staff is not null and not m.nominatable then return; end if;
  -- ★ 指名は「在籍・台帳に表示・ネット指名可」の人だけ
  if p_staff is not null and not exists (select 1 from staff s where s.id = p_staff and coalesce(s.active, true) and s.show_on_ledger and s.web_nominatable and s.role <> 'viewer') then return; end if;
  select * into ln from _menu_lane(p_store, m.lane_id);
  if ln.lane_id is null then return; end if;
  step := greatest(5, coalesce(st.slot_minutes, 15));
  dur := m.duration_min; blk := m.duration_min + coalesce(m.interval_min, 0);
  lead := now() + make_interval(mins => st.booking_lead_min);
  has_shift := exists (select 1 from shifts where store_id = p_store and date = p_date and staff_id is not null);

  for b in select x.start_at, x.end_at from bookings x
            where x.store_id = p_store and x.lane_id = ln.lane_id and x.status = 'block' and x.block_kind = 'idle'
              and x.start_at < ((p_date + 1)::timestamp at time zone tz) and x.end_at > (p_date::timestamp at time zone tz)
            order by x.start_at loop
    t := (p_date::timestamp at time zone tz) + make_interval(mins => (ceil(extract(epoch from (b.start_at - (p_date::timestamp at time zone tz))) / 60.0 / step) * step)::int);
    while t < b.end_at loop
      if (prev is null or t > prev) and t >= lead then
        tl := t at time zone tz; te := (t + make_interval(mins => dur)) at time zone tz;
        tmin := extract(hour from tl)::int * 60 + extract(minute from tl)::int;
        if tl::date = p_date
           and (m.time_from is null or tl::time >= m.time_from) and (m.time_to is null or tl::time <= m.time_to)
           and (cp.id is null or ((cp.time_from is null or tl::time >= cp.time_from) and (cp.time_to is null or tl::time <= cp.time_to)))
           and not exists (select 1 from bookings x where x.store_id = p_store and x.lane_id = ln.lane_id and x.status = 'block' and x.block_kind = 'close'
                            and x.start_at < t + make_interval(mins => dur) and x.end_at > t) then
          select count(*) into used from bookings x
           where x.store_id = p_store and x.lane_id = ln.lane_id and x.status in ('booked','arrived','done')
             and x.start_at < t + make_interval(mins => blk) and x.end_at > t;
          if used + ln.people <= ln.capacity then
            select coalesce(array_agg(z.sid order by z.n, z.sid), '{}') into free from (
              select s.id as sid,
                     (select count(*) from bookings y where y.store_id = p_store and y.staff_id = s.id and y.status in ('booked','arrived','done')
                        and y.start_at >= (p_date::timestamp at time zone tz) and y.start_at < ((p_date + 1)::timestamp at time zone tz)) as n
                from staff s join staff_stores ss on ss.staff_id = s.id and ss.store_id = p_store
               where coalesce(s.active, true) and s.show_on_ledger and s.role <> 'viewer' and (p_staff is null or s.id = p_staff)   -- ★
                 and (not has_shift or exists (
                       select 1 from shifts sh where sh.store_id = p_store and sh.staff_id = s.id and sh.date = p_date and sh.kind = 'work'
                          and sh.start_time is not null and sh.end_time is not null
                          and tl::time >= sh.start_time and te::time <= sh.end_time and te::date = p_date
                          and not (sh.break_start is not null and sh.break_end is not null and tl::time < sh.break_end and te::time > sh.break_start)))
                 and not exists (select 1 from bookings y where y.store_id = p_store and y.staff_id = s.id
                                  and (y.status in ('booked','arrived','done') or (y.status = 'block' and coalesce(y.block_kind, '') <> 'idle'))
                                  and y.start_at < t + make_interval(mins => blk) and y.end_at > t)) z;
            select count(*) into unassigned from bookings y
             where y.store_id = p_store and y.staff_id is null and y.status in ('booked','arrived','done')
               and y.start_at < t + make_interval(mins => blk) and y.end_at > t;
            if coalesce(cardinality(free), 0) - unassigned >= ln.people then
              slot_start := t; staff_ids := free[1:ln.people]; prev := t;
              return next;
            end if;
          end if;
        end if;
      end if;
      t := t + make_interval(mins => step);
    end loop;
  end loop;
end $$;

-- 掲載中のメニュー・クーポン・指名できるスタッフ（★ 指名可の人だけ・表示順・表示名・英語名・指名料）
create or replace function public_menus(p_slug text, p_code text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare st stores; tz text;
begin
  select * into st from stores where slug = lower(btrim(p_slug)) and web_booking_enabled;
  if st.id is null then return null; end if;
  tz := coalesce(st.timezone, 'Asia/Tokyo');
  return jsonb_build_object(
    'menus', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'name_en', m.name_en, 'description', m.description, 'description_en', m.description_en,
                'image_url', m.image_url, 'price', m.price, 'duration_min', m.duration_min, 'target', m.target, 'nominatable', m.nominatable,
                'people', (select people from _menu_lane(st.id, m.lane_id)), 'color', m.color) order by m.sort_order, m.name)
              from menus m where m.store_id = st.id and coalesce(m.active, true) and m.web_visible and m.category = 'technical' and _published(m.publish_from, m.publish_to, tz)), '[]'::jsonb),
    'coupons', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'name_en', c.name_en, 'description', c.description, 'description_en', c.description_en,
                'kind', c.kind, 'value', c.value, 'menu_ids', c.menu_ids, 'target', c.target, 'within_days', c.within_days, 'weekdays', c.weekdays,
                'time_from', to_char(c.time_from, 'HH24:MI'), 'time_to', to_char(c.time_to, 'HH24:MI'), 'has_code', c.code is not null and c.code <> '',
                'left', case when c.first_n is null then null else greatest(0, c.first_n - (select count(*) from bookings y where y.coupon_id = c.id and y.status in ('booked','arrived','done'))) end)
                order by c.sort_order, c.name)
              from coupons c where c.store_id = st.id and c.active and c.web_visible and _published(c.publish_from, c.publish_to, tz)
                and (coalesce(c.code, '') = '' or (p_code is not null and lower(btrim(p_code)) = lower(btrim(c.code))))
                and (c.first_n is null or c.first_n > (select count(*) from bookings y where y.coupon_id = c.id and y.status in ('booked','arrived','done')))), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', coalesce(nullif(btrim(s.display_name), ''), s.name), 'name_en', s.name_en,
                'fee', coalesce(s.nomination_fee, 0)) order by s.sort_order, s.name)
              from staff s join staff_stores ss on ss.staff_id = s.id and ss.store_id = st.id
              where coalesce(s.active, true) and s.role <> 'viewer' and s.show_on_ledger and s.web_nominatable), '[]'::jsonb));
end $$;

-- 予約の確定（★ 担当名は表示名・指名したときは指名料を料金に足す）
create or replace function public_create_booking(
  p_slug text, p_menu uuid, p_start timestamptz, p_name text, p_kana text, p_phone text, p_email text,
  p_intake jsonb default '[]'::jsonb, p_coupon uuid default null, p_code text default null, p_staff uuid default null, p_lang text default 'ja'
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st stores; m menus; cp coupons; ln record; tz text; d date; slot record;
  v_phone text; v_email text; nm text; kn text; cust customers; is_new boolean; last_visit timestamptz;
  price int; blk int; tok text; bno text; grp uuid; b_id uuid; first_id uuid; i int; staff_name text; sid uuid;
  note_text text; body text; fee int := 0;
begin
  select * into st from stores where slug = lower(btrim(p_slug)) and web_booking_enabled;
  if st.id is null then raise exception 'store_not_found'; end if;
  tz := coalesce(st.timezone, 'Asia/Tokyo');
  nm := btrim(coalesce(p_name, '')); kn := btrim(coalesce(p_kana, '')); v_email := lower(btrim(coalesce(p_email, '')));
  v_phone := _norm_phone(p_phone);
  if nm = '' or length(nm) > 60 then raise exception 'invalid_name'; end if;
  if length(kn) > 60 or (coalesce(p_lang, 'ja') = 'ja' and kn = '') then raise exception 'invalid_kana'; end if;
  if length(v_phone) < 8 or length(v_phone) > 15 then raise exception 'invalid_phone'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 120 then raise exception 'invalid_email'; end if;
  if p_intake is null then p_intake := '[]'::jsonb; end if;
  if jsonb_typeof(p_intake) <> 'array' or jsonb_array_length(p_intake) > 30 or length(p_intake::text) > 8000 then raise exception 'invalid_intake'; end if;
  if p_start is null then raise exception 'invalid_start'; end if;
  select * into m from menus where id = p_menu and store_id = st.id;
  if m.id is null then raise exception 'menu_not_found'; end if;

  perform pg_advisory_xact_lock(hashtext('web_booking:' || st.id::text));

  if (select count(*) from bookings y join customers c on c.id = y.customer_id
       where y.store_id = st.id and y.channel = 'own' and y.cancel_token is not null and _norm_phone(c.phone) = v_phone and y.created_at > now() - interval '1 hour') >= 3
     or (select count(*) from bookings y join customers c on c.id = y.customer_id
       where y.store_id = st.id and y.channel = 'own' and y.cancel_token is not null and _norm_phone(c.phone) = v_phone and y.status = 'booked' and y.start_at > now()) >= 5
     or (select count(*) from bookings y where y.store_id = st.id and y.cancel_token is not null and y.created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'too_many';
  end if;

  d := (p_start at time zone tz)::date;
  select * into slot from _web_slots(st.id, m.id, d, p_staff, p_coupon) s where s.slot_start = p_start;
  if slot.slot_start is null then raise exception 'slot_taken'; end if;

  select * into cust from customers where company_id = st.company_id and merged_into is null and _norm_phone(customers.phone) = v_phone order by created_at limit 1;
  if cust.id is null then
    insert into customers (company_id, name, kana, phone, email, source, language)
    values (st.company_id, nm, nullif(kn, ''), p_phone, v_email, 'own', coalesce(p_lang, 'ja')) returning * into cust;
  elsif coalesce(cust.email, '') = '' then
    update customers set email = v_email where id = cust.id;
  end if;
  if exists (select 1 from bookings y where y.store_id = st.id and y.customer_id = cust.id and y.start_at = p_start and y.status in ('booked','arrived')) then
    raise exception 'duplicate';
  end if;

  select max(v) into last_visit from (
    select sold_at as v from sales where store_id = st.id and customer_id = cust.id and status = 'confirmed'
    union all select start_at from bookings where store_id = st.id and customer_id = cust.id and status = 'done') z;
  is_new := last_visit is null;
  if m.target = 'new' and not is_new then raise exception 'menu_new_only'; end if;
  if m.target = 'repeat' and is_new then raise exception 'menu_repeat_only'; end if;

  price := m.price;
  if p_coupon is not null then
    select * into cp from coupons where id = p_coupon and store_id = st.id and active and web_visible;
    if cp.id is null or not _published(cp.publish_from, cp.publish_to, tz) then raise exception 'coupon_invalid'; end if;
    if coalesce(cp.code, '') <> '' and lower(btrim(coalesce(p_code, ''))) <> lower(btrim(cp.code)) then raise exception 'coupon_code'; end if;
    if cardinality(cp.menu_ids) > 0 and not (m.id = any(cp.menu_ids)) then raise exception 'coupon_menu'; end if;
    if cp.target = 'new' and not is_new then raise exception 'coupon_new_only'; end if;
    if cp.target = 'repeat' and is_new then raise exception 'coupon_repeat_only'; end if;
    if cp.within_days is not null and (last_visit is null or d - (last_visit at time zone tz)::date > cp.within_days) then raise exception 'coupon_within_days'; end if;
    if cp.first_n is not null and (select count(*) from bookings y where y.coupon_id = cp.id and y.status in ('booked','arrived','done')) >= cp.first_n then raise exception 'coupon_sold_out'; end if;
    if cp.per_customer_limit is not null and (select count(*) from bookings y where y.coupon_id = cp.id and y.customer_id = cust.id and y.status in ('booked','arrived','done')) >= cp.per_customer_limit then raise exception 'coupon_limit'; end if;
    price := _coupon_price(cp.kind, cp.value, m.price);
  end if;
  -- ★ 指名料（指名したときだけ）
  if p_staff is not null then
    select coalesce(nomination_fee, 0) into fee from staff where id = p_staff;
    price := price + coalesce(fee, 0);
  end if;

  select * into ln from _menu_lane(st.id, m.lane_id);
  blk := m.duration_min + coalesce(m.interval_min, 0);
  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  bno := 'W' || to_char(now() at time zone tz, 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
  grp := case when ln.people > 1 then gen_random_uuid() else null end;
  note_text := 'ネット予約 ' || bno || case when cp.id is not null then '／クーポン：' || cp.name else '' end
               || case when coalesce(fee, 0) > 0 then '／指名料 ' || fee || '円' else '' end;
  for i in 1..ln.people loop
    sid := slot.staff_ids[i];
    insert into bookings (store_id, customer_id, customer_name, staff_id, lane_id, start_at, end_at, status, channel, menu_ids, nominated, pair_group, note,
                          coupon_id, intake, cancel_token, booking_no, price_quote, lang)
    values (st.id, case when i = 1 then cust.id else null end, case when i = 1 then null else nm || '（同行者）' end, sid, ln.lane_id,
            p_start, p_start + make_interval(mins => blk), 'booked', 'own', array[m.id], p_staff is not null, grp, note_text,
            cp.id, case when i = 1 then p_intake else null end, case when i = 1 then tok else null end, bno, price, coalesce(p_lang, 'ja'))
    returning id into b_id;
    if i = 1 then first_id := b_id; end if;
  end loop;
  select coalesce(nullif(btrim(display_name), ''), name) into staff_name from staff where id = slot.staff_ids[1];   -- ★

  body := '予約番号：' || bno || E'\n日時：' || to_char(p_start at time zone tz, 'YYYY/MM/DD HH24:MI') || E'\nメニュー：' || m.name ||
          case when cp.id is not null then E'\nクーポン：' || cp.name else '' end || E'\n料金：' || price * ln.people || '円（税込）' ||
          case when coalesce(fee, 0) > 0 then '（指名料 ' || fee || '円を含む）' else '' end ||
          E'\nお名前：' || nm || case when kn <> '' then '（' || kn || '）' else '' end || E'\n電話：' || p_phone || E'\nメール：' || v_email ||
          case when staff_name is not null then E'\n担当：' || staff_name || case when p_staff is not null then '（指名）' else '' end else '' end;
  insert into notifications (store_id, booking_id, kind, to_address, subject, body)
  values (st.id, first_id, 'new_booking', st.notify_email, '【新しいネット予約】' || to_char(p_start at time zone tz, 'MM/DD HH24:MI') || ' ' || nm || '様', body),
         (st.id, first_id, 'booking_confirmation', v_email, '【' || st.name || '】ご予約ありがとうございます（' || bno || '）', body);

  return jsonb_build_object('booking_no', bno, 'cancel_token', tok, 'start_at', p_start, 'end_at', p_start + make_interval(mins => blk),
    'menu_name', m.name, 'menu_name_en', m.name_en, 'price', price, 'people', ln.people, 'store_name', st.name, 'staff_name', staff_name,
    'coupon_name', cp.name, 'deadline', _cancel_deadline(st.id, p_start));
end $$;

-- 権限（0007 と同じ：内部用は直接使わせない／public_* だけ anon に許可）
revoke all on function _web_slots(uuid, uuid, date, uuid, uuid) from public, anon, authenticated;
revoke all on function public_menus(text, text) from public;
revoke all on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text) from public;
grant execute on function public_menus(text, text) to anon, authenticated;
grant execute on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text) to anon, authenticated;

-- 未ログイン（anon）からは表を一切触れないように（0003 と同じ方針）
revoke all on all tables in schema public from anon;

-- API（PostgREST）に新しい列・関数をすぐ見せる
notify pgrst, 'reload schema';
