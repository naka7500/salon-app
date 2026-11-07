-- 0018：メニューの「クーポン専用」（増美さん 2026-11-07 決定）
-- クーポン専用のメニュー＝クーポンの料金・時間の土台としてだけあるメニュー。
--  ・ネット予約ページの「メニュー」タブに出さない（public_menus の menus に入れない）
--  ・ネットでは単品で予約できない。そのメニューを対象（menu_ids）に入れたクーポンでだけ予約できる
--    （public_create_booking で 'menu_coupon_only' として止める。空き時間 _web_slots も同じ条件で空を返す）
--  ・店の画面（予約台帳・会計）では今までどおり使える（このマイグレーションは店の画面に関係しない）
--  ・クーポンの選択肢を出すために、public_menus に coupon_menus（掲載中のクーポンが対象にしているクーポン専用メニューだけ）を足す
-- ※必ず 0017 の後に流すこと（0017 が無いと最初で止まります。DBは何も変わりません）。
-- ※何度流しても同じ（add column if not exists / create or replace）。
-- 関数は最新版をそのまま写して、★0018 の行だけ足しています：
--   _web_slots／public_menus …… 0009_options_pair.sql
--   public_create_booking …… 0012_customer_import.sql
-- 最後に、ラシエル箱崎（aaaaaaaa-0000-0000-0000-000000000001）の HPB 同期 SQL（supabase/data/hakozaki_hpb_sync_2026-11-07.sql）が作る
-- クーポン対象メニュー4つ（フラットマットラッシュ100本・120本・2つのセット）を「クーポン専用」にします（あれば。無ければ何もしません）。

begin;

do $$ begin
  if to_regprocedure('public.public_line_info(text)') is null
     or pg_get_functiondef('public.public_line_info(text)'::regprocedure) like '%c.enabled%' then
    raise exception '0017 が流れていません。先に 0015 → 0016 → 0017 を流してください';
  end if;
end $$;

-- 1) 列
alter table menus add column if not exists coupon_only boolean not null default false;
comment on column menus.coupon_only is '0018：クーポン専用（ネット予約のメニュー欄に出さない・対象にしたクーポンでだけネット予約できる。店の画面では普通に使える）';

-- 2) 空き時間（0009 の _web_slots。★0018 の1か所だけ追加）
create or replace function _web_slots(p_store uuid, p_menu uuid, p_date date, p_staff uuid default null, p_coupon uuid default null, p_options uuid[] default null)
returns table(slot_start timestamptz, staff_ids uuid[], heads_left int)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  st stores; m menus; cp coupons; o record;
  tz text; step int; dur int; blk int; lead timestamptz; today date; wd int; ppl int;
  has_shift boolean; day0 timestamptz; t timestamptz; tl timestamp; te timestamp; t_lo int; t_hi int; tl_m int; te_m int;
  first_lane uuid; pair_lane uuid; idle_lane uuid; free uuid[]; unassigned int; rooms_used int; avail int; last_off int;
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
  -- ★0018：クーポン専用のメニューは、そのメニューを対象にしたクーポンのときだけ
  if m.coupon_only and (cp.id is null or not (m.id = any(coalesce(cp.menu_ids, '{}'::uuid[])))) then return; end if;
  if p_staff is not null and not m.nominatable then return; end if;
  if p_staff is not null and not exists (select 1 from staff s where s.id = p_staff and coalesce(s.active, true) and s.show_on_ledger and s.web_nominatable and s.role <> 'viewer') then return; end if;
  select * into o from _web_options(p_store, m.id, cp.id, p_options, false);
  if not o.ok then return; end if;

  ppl := greatest(1, coalesce(m.people, 1));
  dur := m.duration_min + coalesce(o.add_min, 0); blk := dur + coalesce(m.interval_min, 0);
  step := greatest(5, coalesce(st.start_step_min, 30));
  lead := now() + make_interval(mins => st.booking_lead_min);
  last_off := st.last_order_offset_min;
  select l.id into first_lane from lanes l where l.store_id = p_store and coalesce(l.active, true) order by l.sort_order, l.id limit 1;
  select l.id into pair_lane from lanes l where l.store_id = p_store and coalesce(l.active, true) and l.capacity >= 2 and l.id is distinct from first_lane order by l.sort_order, l.id limit 1;
  idle_lane := coalesce((select x.lane_id from _menu_lane(p_store, m.lane_id) x), first_lane);
  has_shift := exists (select 1 from shifts where store_id = p_store and date = p_date and staff_id is not null);
  day0 := p_date::timestamp at time zone tz;
  -- 探す範囲：開店〜閉店と、その日のシフトの最早〜最遅
  t_lo := least((extract(epoch from st.open_time) / 60)::int,
                coalesce((select min(extract(epoch from start_time) / 60)::int from shifts where store_id = p_store and date = p_date and staff_id is not null and kind = 'work' and start_time is not null), 1440));
  t_hi := greatest((extract(epoch from st.close_time) / 60)::int,
                   coalesce((select max(extract(epoch from end_time) / 60)::int from shifts where store_id = p_store and date = p_date and staff_id is not null and kind = 'work' and end_time is not null), 0));
  t_lo := (ceil(t_lo / step::numeric) * step)::int;
  if t_hi - dur < t_lo then return; end if;

  for t in select g from generate_series(day0 + make_interval(mins => t_lo), day0 + make_interval(mins => t_hi - dur), make_interval(mins => step)) g loop
    continue when t < lead;
    tl := t at time zone tz; te := (t + make_interval(mins => dur)) at time zone tz;
    continue when tl::date <> p_date;
    tl_m := extract(hour from tl)::int * 60 + extract(minute from tl)::int;
    te_m := case when te::date = p_date then extract(hour from te)::int * 60 + extract(minute from te)::int else 1440 end;
    continue when (m.time_from is not null and tl::time < m.time_from) or (m.time_to is not null and tl::time > m.time_to);
    continue when cp.id is not null and ((cp.time_from is not null and tl::time < cp.time_from) or (cp.time_to is not null and tl::time > cp.time_to));
    -- ×（受付停止）
    continue when exists (select 1 from bookings x where x.store_id = p_store and x.status = 'block' and x.block_kind = 'close'
                            and (x.lane_id = first_lane or (ppl >= 2 and pair_lane is not null and x.lane_id = pair_lane))
                            and x.start_at < t + make_interval(mins => dur) and x.end_at > t);
    -- シフトが無い日だけ：受付枠IDLEの中
    if not has_shift then
      continue when not exists (select 1 from bookings x where x.store_id = p_store and x.lane_id = idle_lane and x.status = 'block' and x.block_kind = 'idle'
                                  and x.start_at <= t and x.end_at > t);
    end if;
    select coalesce(array_agg(z.sid order by z.n, z.sid), '{}') into free from (
      select s.id as sid,
             (select count(*) from bookings y where y.store_id = p_store and y.staff_id = s.id and y.status in ('booked','arrived','done')
                and y.start_at >= day0 and y.start_at < day0 + interval '1 day') as n
        from staff s join staff_stores ss on ss.staff_id = s.id and ss.store_id = p_store
       where coalesce(s.active, true) and s.show_on_ledger and s.role <> 'viewer'
         and (not has_shift or exists (
               select 1 from shifts sh where sh.store_id = p_store and sh.staff_id = s.id and sh.date = p_date and sh.kind = 'work'
                  and sh.start_time is not null and sh.end_time is not null
                  and tl_m >= extract(epoch from sh.start_time) / 60 and te_m <= extract(epoch from sh.end_time) / 60
                  and (last_off is null or tl_m <= extract(epoch from sh.end_time) / 60 - last_off)
                  and not (sh.break_start is not null and sh.break_end is not null
                           and tl_m < extract(epoch from sh.break_end) / 60 and te_m > extract(epoch from sh.break_start) / 60)))
         and not exists (select 1 from bookings y where y.store_id = p_store and y.staff_id = s.id
                          and (y.status in ('booked','arrived','done') or (y.status = 'block' and coalesce(y.block_kind, '') <> 'idle'))
                          and y.start_at < t + make_interval(mins => blk) and y.end_at > t)) z;
    select count(*) into unassigned from bookings y
     where y.store_id = p_store and y.staff_id is null and y.status in ('booked','arrived','done')
       and y.start_at < t + make_interval(mins => blk) and y.end_at > t;
    avail := coalesce(cardinality(free), 0) - unassigned;
    if st.room_count is not null then
      select count(*) into rooms_used from bookings y
       where y.store_id = p_store and y.status in ('booked','arrived','done') and y.start_at < t + make_interval(mins => blk) and y.end_at > t;
      avail := least(avail, st.room_count - rooms_used);
    end if;
    continue when avail < ppl;
    if p_staff is not null then
      continue when not (p_staff = any(free));
      staff_ids := array[p_staff] || coalesce((select array_agg(u.x order by u.ord) from unnest(free) with ordinality u(x, ord) where u.x <> p_staff), '{}'::uuid[]);
      staff_ids := staff_ids[1:ppl];
    else
      staff_ids := free[1:ppl];
    end if;
    slot_start := t; heads_left := avail;
    return next;
  end loop;
end $$;
revoke all on function _web_slots(uuid, uuid, date, uuid, uuid, uuid[]) from public, anon, authenticated;

-- 3) 掲載中のメニュー・クーポン・指名できるスタッフ・オプション（0009 の public_menus）
--   ★0018：menus にクーポン専用を入れない。coupon_menus＝掲載中のクーポンが対象にしているクーポン専用メニュー（クーポンの選択肢用）
create or replace function public_menus(p_slug text, p_code text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare st stores; tz text; gids uuid[]; v_coupons jsonb;
begin
  select * into st from stores where slug = lower(btrim(p_slug)) and web_booking_enabled;
  if st.id is null then return null; end if;
  tz := coalesce(st.timezone, 'Asia/Tokyo');
  select coalesce(array_agg(g.id), '{}') into gids from option_groups g
   where g.store_id = st.id and g.active and exists (select 1 from menus o where o.option_group_id = g.id and o.category = 'option' and coalesce(o.active, true) and o.web_visible);
  v_coupons := coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'name_en', c.name_en, 'description', c.description, 'description_en', c.description_en,
                'kind', c.kind, 'value', c.value, 'menu_ids', c.menu_ids, 'target', c.target, 'within_days', c.within_days, 'weekdays', c.weekdays,
                'time_from', to_char(c.time_from, 'HH24:MI'), 'time_to', to_char(c.time_to, 'HH24:MI'), 'has_code', c.code is not null and c.code <> '',
                'left', case when c.first_n is null then null else greatest(0, c.first_n - (select count(*) from bookings y where y.coupon_id = c.id and y.status in ('booked','arrived','done') and y.customer_id is not null)) end,
                'option_group_ids', to_jsonb(array(select x from unnest(coalesce(c.option_group_ids, '{}'::uuid[])) x where x = any(gids))))
                order by c.sort_order, c.name)
              from coupons c where c.store_id = st.id and c.active and c.web_visible and _published(c.publish_from, c.publish_to, tz)
                and (coalesce(c.code, '') = '' or (p_code is not null and lower(btrim(p_code)) = lower(btrim(c.code))))
                and (c.first_n is null or c.first_n > (select count(*) from bookings y where y.coupon_id = c.id and y.status in ('booked','arrived','done') and y.customer_id is not null))), '[]'::jsonb);
  return jsonb_build_object(
    'menus', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'name_en', m.name_en, 'description', m.description, 'description_en', m.description_en,
                'image_url', m.image_url, 'price', m.price, 'duration_min', m.duration_min, 'target', m.target, 'nominatable', m.nominatable,
                'people', m.people, 'color', m.color, 'price_per', 'group',
                'option_group_ids', to_jsonb(array(select x from unnest(coalesce(m.option_group_ids, '{}'::uuid[])) x where x = any(gids)))) order by m.sort_order, m.name)
              from menus m where m.store_id = st.id and coalesce(m.active, true) and m.web_visible and m.category = 'technical' and _published(m.publish_from, m.publish_to, tz)
                and not m.coupon_only), '[]'::jsonb),
    'coupon_menus', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'name_en', m.name_en, 'description', m.description, 'description_en', m.description_en,
                'image_url', m.image_url, 'price', m.price, 'duration_min', m.duration_min, 'target', m.target, 'nominatable', m.nominatable,
                'people', m.people, 'color', m.color, 'price_per', 'group', 'coupon_only', true,
                'option_group_ids', to_jsonb(array(select x from unnest(coalesce(m.option_group_ids, '{}'::uuid[])) x where x = any(gids)))) order by m.sort_order, m.name)
              from menus m where m.store_id = st.id and coalesce(m.active, true) and m.web_visible and m.category = 'technical' and _published(m.publish_from, m.publish_to, tz)
                and m.coupon_only
                and m.id::text in (select jsonb_array_elements_text(cj->'menu_ids') from jsonb_array_elements(v_coupons) cj where jsonb_typeof(cj->'menu_ids') = 'array')), '[]'::jsonb),
    'coupons', v_coupons,
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', coalesce(nullif(btrim(s.display_name), ''), s.name), 'name_en', s.name_en,
                'fee', coalesce(s.nomination_fee, 0)) order by s.sort_order, s.name)
              from staff s join staff_stores ss on ss.staff_id = s.id and ss.store_id = st.id
              where coalesce(s.active, true) and s.role <> 'viewer' and s.show_on_ledger and s.web_nominatable), '[]'::jsonb),
    'option_groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'name_en', g.name_en, 'description', g.description,
                'required', g.required, 'multi', g.multi,
                'items', (select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'name_en', o.name_en, 'description', o.description, 'price', o.price, 'minutes', o.duration_min) order by o.sort_order, o.name)
                            from menus o where o.option_group_id = g.id and o.category = 'option' and coalesce(o.active, true) and o.web_visible))
                order by g.sort_order, g.name)
              from option_groups g where g.id = any(gids)), '[]'::jsonb));
end $$;
revoke all on function public_menus(text, text) from public;
grant execute on function public_menus(text, text) to anon, authenticated;

-- 4) 予約の確定（0012 の public_create_booking。★0018 の1か所だけ追加）
create or replace function public_create_booking(
  p_slug text, p_menu uuid, p_start timestamptz, p_name text, p_kana text, p_phone text, p_email text,
  p_intake jsonb default '[]'::jsonb, p_coupon uuid default null, p_code text default null, p_staff uuid default null, p_lang text default 'ja',
  p_options uuid[] default null
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st stores; m menus; cp coupons; ln record; tz text; d date; slot record; o record;
  v_phone text; v_email text; nm text; kn text; cust customers; is_new boolean; last_visit timestamptz;
  price int; total int; blk int; tok text; bno text; grp uuid; b_id uuid; first_id uuid; i int; staff_name text; sid uuid; ppl int;
  note_text text; body text; fee int := 0; opt_ids uuid[];
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
  if coalesce(cardinality(p_options), 0) > 10 then raise exception 'option_invalid'; end if;
  select * into m from menus where id = p_menu and store_id = st.id;
  if m.id is null then raise exception 'menu_not_found'; end if;
  -- ★0018：クーポン専用のメニューは、そのメニューを対象（menu_ids）にしたクーポンでだけ予約できる（クーポン自体の条件は下で確認）
  if m.coupon_only and (p_coupon is null or not exists (select 1 from coupons c where c.id = p_coupon and c.store_id = st.id and m.id = any(coalesce(c.menu_ids, '{}'::uuid[])))) then
    raise exception 'menu_coupon_only';
  end if;

  -- オプション（必須・1つだけ・このメニュー／クーポンのグループか）
  select * into o from _web_options(st.id, m.id, p_coupon, p_options, true);
  if not o.ok then raise exception '%', o.err; end if;
  select coalesce(array_agg(x.id order by x.sort_order, x.name), '{}') into opt_ids from menus x where x.id = any(coalesce(p_options, '{}'::uuid[])) and x.store_id = st.id;

  perform pg_advisory_xact_lock(hashtext('web_booking:' || st.id::text));

  if (select count(*) from bookings y join customers c on c.id = y.customer_id
       where y.store_id = st.id and y.channel = 'own' and y.cancel_token is not null and _norm_phone(c.phone) = v_phone and y.created_at > now() - interval '1 hour') >= 3
     or (select count(*) from bookings y join customers c on c.id = y.customer_id
       where y.store_id = st.id and y.channel = 'own' and y.cancel_token is not null and _norm_phone(c.phone) = v_phone and y.status = 'booked' and y.start_at > now()) >= 5
     or (select count(*) from bookings y where y.store_id = st.id and y.cancel_token is not null and y.created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'too_many';
  end if;

  -- ロックの中で空きを再確認（オプション込みの時間で）
  d := (p_start at time zone tz)::date;
  select * into slot from _web_slots(st.id, m.id, d, p_staff, p_coupon, opt_ids) s where s.slot_start = p_start;
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
    union all select start_at from bookings where store_id = st.id and customer_id = cust.id and status = 'done'
    -- ★0012：旧POS（サロンアンサー・カミングスーン）から取り込んだ来店も「前回来店」に数える（その日の12:00として扱う）
    union all select (greatest(h.visited_on, h.last_visit_on, h.first_visit_on)::timestamp + time '12:00') at time zone tz
      from historical_visits h where h.store_id = st.id and h.customer_id = cust.id) z;
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
    if cp.first_n is not null and (select count(*) from bookings y where y.coupon_id = cp.id and y.status in ('booked','arrived','done') and y.customer_id is not null) >= cp.first_n then raise exception 'coupon_sold_out'; end if;
    if cp.per_customer_limit is not null and (select count(*) from bookings y where y.coupon_id = cp.id and y.customer_id = cust.id and y.status in ('booked','arrived','done')) >= cp.per_customer_limit then raise exception 'coupon_limit'; end if;
    price := _coupon_price(cp.kind, cp.value, m.price);
  end if;
  if p_staff is not null then
    select coalesce(nomination_fee, 0) into fee from staff where id = p_staff;
  end if;
  ppl := greatest(1, coalesce(m.people, 1));
  total := price + coalesce(o.add_price, 0) * ppl + coalesce(fee, 0);

  select * into ln from _menu_lane(st.id, m.lane_id);
  blk := m.duration_min + coalesce(o.add_min, 0) + coalesce(m.interval_min, 0);
  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  bno := 'W' || to_char(now() at time zone tz, 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
  grp := case when ppl > 1 then gen_random_uuid() else null end;
  note_text := 'ネット予約 ' || bno || case when cp.id is not null then '／クーポン：' || cp.name else '' end
               || case when o.label is not null then '／オプション：' || o.label else '' end
               || case when coalesce(fee, 0) > 0 then '／指名料 ' || fee || '円' else '' end;
  for i in 1..ppl loop
    sid := slot.staff_ids[i];
    insert into bookings (store_id, customer_id, customer_name, staff_id, lane_id, start_at, end_at, status, channel, menu_ids, nominated, pair_group, note,
                          coupon_id, intake, cancel_token, booking_no, price_quote, lang)
    values (st.id, case when i = 1 then cust.id else null end, case when i = 1 then null else nm || '（同行者）' end, sid, ln.lane_id,
            p_start, p_start + make_interval(mins => blk), 'booked', 'own', array[m.id] || opt_ids, p_staff is not null and i = 1, grp, note_text,
            cp.id, case when i = 1 then p_intake else null end, case when i = 1 then tok else null end, bno, case when i = 1 then total else null end, coalesce(p_lang, 'ja'))
    returning id into b_id;
    if i = 1 then first_id := b_id; end if;
  end loop;
  select coalesce(nullif(btrim(display_name), ''), name) into staff_name from staff where id = slot.staff_ids[1];

  body := '予約番号：' || bno || E'\n日時：' || to_char(p_start at time zone tz, 'YYYY/MM/DD HH24:MI') || E'\nメニュー：' || m.name ||
          case when o.label is not null then '＋' || o.label else '' end || case when ppl > 1 then '（' || ppl || '名様）' else '' end ||
          case when cp.id is not null then E'\nクーポン：' || cp.name else '' end || E'\n料金：' || total || '円（税込）' ||
          case when coalesce(fee, 0) > 0 then '（指名料 ' || fee || '円を含む）' else '' end ||
          E'\nお名前：' || nm || case when kn <> '' then '（' || kn || '）' else '' end || E'\n電話：' || p_phone || E'\nメール：' || v_email ||
          case when staff_name is not null then E'\n担当：' || staff_name || case when p_staff is not null then '（指名）' else '' end else '' end;
  insert into notifications (store_id, booking_id, kind, to_address, subject, body)
  values (st.id, first_id, 'new_booking', st.notify_email, '【新しいネット予約】' || to_char(p_start at time zone tz, 'MM/DD HH24:MI') || ' ' || nm || '様', body),
         (st.id, first_id, 'booking_confirmation', v_email, '【' || st.name || '】ご予約ありがとうございます（' || bno || '）', body);

  return jsonb_build_object('booking_no', bno, 'cancel_token', tok, 'start_at', p_start, 'end_at', p_start + make_interval(mins => blk),
    'menu_name', m.name, 'menu_name_en', m.name_en, 'price', round(total::numeric / ppl)::int, 'price_total', total, 'options_label', o.label,
    'people', ppl, 'store_name', st.name, 'staff_name', staff_name, 'coupon_name', cp.name, 'deadline', _cancel_deadline(st.id, p_start));
end $$;
revoke all on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[]) from public;
grant execute on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[]) to anon, authenticated;

-- 5) ラシエル箱崎：HPB 同期 SQL が作るクーポン対象メニュー4つを「クーポン専用」に（固定の ID。無ければ何もしない）
--   a5a10001-0b5a-4c05-8000-000000000003 フラットマットラッシュ100本（¥6,600／50分）
--   a5a10001-0b5a-4c05-8000-000000000004 フラットマットラッシュ120本（¥7,700／80分）
--   a5a10001-0b5a-4c05-8000-000000000005 まつエク100本＋垢抜けアイブロウWax（¥12,100／90分）
--   a5a10001-0b5a-4c05-8000-000000000006 アイブロウWax＋まつげパーマ（¥13,200／90分）
update menus set coupon_only = true
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000001'
   and id in ('a5a10001-0b5a-4c05-8000-000000000003', 'a5a10001-0b5a-4c05-8000-000000000004',
              'a5a10001-0b5a-4c05-8000-000000000005', 'a5a10001-0b5a-4c05-8000-000000000006')
   and not coupon_only;

commit;

-- 6) 結果：1行目＝OK、2行目以降＝クーポン専用になっているメニュー（全店舗）
select * from (
  select 0 as ord, '0018 OK：メニューの「クーポン専用」を追加しました（ネット予約のメニュー欄に出さない・対象のクーポンでだけ予約できる）／クーポン専用 '
         || (select count(*) from menus where coupon_only) || '件（うち箱崎 '
         || (select count(*) from menus where coupon_only and store_id = 'aaaaaaaa-0000-0000-0000-000000000001') || '件）' as result
  union all
  select 1, format('クーポン専用：%s／%s ¥%s／%s分%s', s.name, m.name, m.price, m.duration_min, case when coalesce(m.active, true) then '' else '（使わない）' end)
    from menus m join stores s on s.id = m.store_id where m.coupon_only
) z order by ord, result;
