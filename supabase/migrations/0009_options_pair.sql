-- v1.1：①オプション選択（まつげのオフ有り・無し など） ②1名・2名（ペア）予約を「空いている人数×部屋」で数える。
-- ※必ず 0008_staff_settings.sql の後に流すこと（0008 が無いと最初で止まります）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists）。
-- 0009 が未適用でもアプリは落ちない（オプション・部屋数・人数の設定だけ「準備中」になり、空きは今までどおり）。
--
-- やること
--  1) stores：部屋数（room_count・空欄＝数えない）、開始時刻の刻み（start_step_min・既定30分）
--  2) menus：人数（people 1/2）、オプションの所属グループ（option_group_id）、技術メニューに付けられるグループ（option_group_ids）
--     最初の1回だけ：ペア枠（1名様枠以外で同時2名以上の受付枠）を使っていたメニューを people=2 にする
--  3) coupons：付けられるオプショングループ（option_group_ids）
--  4) option_groups 表（グループ名・必須・1つだけ／複数・表示順）
--  5) ネット予約の関数を作り直す：空き＝出勤中で空いている人数と空き部屋の小さい方（受付枠IDLEは不要）、
--     開始時刻は固定の刻みだけ（※空きの形で候補を間引く処理は入れない）、オプション込みの時間・料金をサーバで計算

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'staff' and column_name = 'show_on_ledger') then
    raise exception '0008 がまだ流れていません。先に 0008_staff_settings.sql を流してから、この 0009 を流してください';
  end if;
  if to_regclass('public.coupons') is null then raise exception '先に 0007_phase_c.sql → 0008_staff_settings.sql を流してください'; end if;
end $$;

-- =========================================================
-- 1) 店舗：部屋数・開始時刻の刻み
-- =========================================================
do $$
declare first_time boolean;
begin
  first_time := not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stores' and column_name = 'room_count');
  alter table stores add column if not exists room_count int;                         -- 空欄＝部屋数で制限しない
  alter table stores add column if not exists start_step_min int not null default 30; -- 開始時刻の刻み（分）
  if first_time then
    -- KOKAGE西五反田＝3部屋、テスト店舗（練習用）＝2ベッド（あとで設定画面で変えられる）
    update stores set room_count = 3 where id = 'aaaaaaaa-0000-0000-0000-000000000002' and room_count is null;
    update stores set room_count = 2 where id = 'aaaaaaaa-0000-0000-0000-000000000099' and room_count is null;
  end if;
end $$;
alter table stores drop constraint if exists stores_room_count_check;
alter table stores add constraint stores_room_count_check check (room_count is null or room_count between 1 and 50);
alter table stores drop constraint if exists stores_start_step_check;
alter table stores add constraint stores_start_step_check check (start_step_min in (10, 15, 20, 30, 60));

-- =========================================================
-- 2) オプショングループ
-- =========================================================
create table if not exists option_groups (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,                       -- 例：オフ
  name_en text,
  description text,
  required boolean not null default false,  -- 必須（選ぶまで次へ進めない）
  multi boolean not null default false,     -- false＝1つだけ選ぶ／true＝いくつでも
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists option_groups_store_idx on option_groups (store_id, sort_order);
alter table option_groups enable row level security;
drop policy if exists option_groups_sel on option_groups;
drop policy if exists option_groups_ins on option_groups;
drop policy if exists option_groups_upd on option_groups;
drop policy if exists option_groups_del on option_groups;
create policy option_groups_sel on option_groups for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy option_groups_ins on option_groups for insert with check (is_store_admin(store_id));
create policy option_groups_upd on option_groups for update using (is_store_admin(store_id)) with check (is_store_admin(store_id));
create policy option_groups_del on option_groups for delete using (is_store_admin(store_id));

-- =========================================================
-- 3) メニュー：人数・オプションのグループ／クーポン：グループ
-- =========================================================
do $$
declare first_time boolean; n int;
begin
  first_time := not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'menus' and column_name = 'people');
  alter table menus add column if not exists people int not null default 1;       -- 1＝1名様／2＝ペア（料金は1組）
  alter table menus add column if not exists option_group_id uuid references option_groups(id) on delete set null;   -- オプションの所属
  alter table menus add column if not exists option_group_ids uuid[] not null default '{}';                          -- 技術メニューに付けられるグループ
  alter table coupons add column if not exists option_group_ids uuid[] not null default '{}';
  if first_time then
    -- ペア枠を使っていたメニュー → people=2（料金はそのまま。1組の料金になっているか設定画面で確認してください）
    update menus m set people = 2
      from lanes l
     where m.lane_id = l.id and l.capacity >= 2
       and l.id <> (select f.id from lanes f where f.store_id = l.store_id and coalesce(f.active, true) order by f.sort_order, f.id limit 1);
    get diagnostics n = row_count;
    if n > 0 then raise notice 'ペア（2名様）にしたメニュー：%件。料金が「2名様1組」の金額か、設定＞メニューで確認してください', n; end if;
  end if;
end $$;
alter table menus drop constraint if exists menus_people_check;
alter table menus add constraint menus_people_check check (people in (1, 2));

-- オプションのグループは同じ店舗のものだけ
create or replace function guard_menu_option_group() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.option_group_id is not null and not exists (select 1 from option_groups g where g.id = new.option_group_id and g.store_id = new.store_id) then
    raise exception 'option_group_store_mismatch';
  end if;
  return new;
end $$;
drop trigger if exists t_menu_option_group on menus;
create trigger t_menu_option_group before insert or update of option_group_id, store_id on menus for each row execute function guard_menu_option_group();
revoke all on function guard_menu_option_group() from public, anon, authenticated;

-- =========================================================
-- 4) ネット予約の関数（作り直し。引数が増えるので古いものは消す）
-- =========================================================
drop function if exists public_availability(text, uuid, date, date, uuid, uuid);
drop function if exists public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text);
drop function if exists _web_slots(uuid, uuid, date, uuid, uuid);

-- 選んだオプションの確認と合計。p_strict＝必須・1つだけも確認（予約の確定時）
create or replace function _web_options(p_store uuid, p_menu uuid, p_coupon uuid, p_options uuid[], p_strict boolean)
returns table(ok boolean, add_min int, add_price int, label text, err text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare allowed uuid[]; n_in int; n_ok int; g record; n int;
begin
  select coalesce(m.option_group_ids, '{}') || coalesce((select c.option_group_ids from coupons c where c.id = p_coupon and c.store_id = p_store), '{}')
    into allowed from menus m where m.id = p_menu and m.store_id = p_store;
  select coalesce(array_agg(x.id), '{}') into allowed from option_groups x where x.id = any(coalesce(allowed, '{}')) and x.store_id = p_store and x.active;
  n_in := coalesce((select count(distinct v) from unnest(coalesce(p_options, '{}'::uuid[])) v), 0);
  select count(*), coalesce(sum(o.duration_min), 0), coalesce(sum(o.price), 0), string_agg(o.name, '＋' order by o.sort_order, o.name)
    into n_ok, add_min, add_price, label
    from menus o where o.id = any(coalesce(p_options, '{}'::uuid[])) and o.store_id = p_store and o.category = 'option'
     and coalesce(o.active, true) and o.web_visible and o.option_group_id = any(allowed);
  if n_ok <> n_in then ok := false; err := 'option_invalid'; return next; return; end if;
  if p_strict then
    for g in select x.id, x.required, x.multi from option_groups x where x.id = any(allowed) loop
      select count(*) into n from menus o where o.id = any(coalesce(p_options, '{}'::uuid[])) and o.option_group_id = g.id;
      if g.required and n = 0 and exists (select 1 from menus o where o.option_group_id = g.id and coalesce(o.active, true) and o.web_visible and o.category = 'option') then
        ok := false; err := 'option_required'; return next; return;
      end if;
      if not g.multi and n > 1 then ok := false; err := 'option_single'; return next; return; end if;
    end loop;
  end if;
  ok := true; err := null; return next;
end $$;

-- 空き時間の計算（1日分）。返すのは開始時刻・割り当てる担当（空いている順）・残り人数。
--  ①開始時刻は固定の刻み（stores.start_step_min）だけ。※空きの形を見て候補を間引く処理は入れない（特許対策）
--  ②担当：出勤中（施術がシフト内・休憩と重ならない・最終受付の上書きがあればそれより前）で、予約・ブロック（IDLE以外）が重ならない人
--  ③残り人数＝空いている担当 −担当なしの予約、部屋数があれば「部屋数−使用中」と小さい方。メニューの人数（ペア＝2）以上なら出す
--  ④受付枠の×：1名様枠の×＝全部止める、ペア枠の×＝ペアだけ止める
--  ⑤その日にシフトが1件も無い店は、受付枠IDLEの中だけ・在籍の全員で数える（0009 より前と同じ）
--  ⑥メニュー・クーポンの受付曜日・時間帯、今から booking_lead_min 分後以降・booking_horizon_days 日先まで
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

-- 掲載中のメニュー・クーポン・指名できるスタッフ・オプション（ネット予約に出す選択肢があるグループだけ）
create or replace function public_menus(p_slug text, p_code text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare st stores; tz text; gids uuid[];
begin
  select * into st from stores where slug = lower(btrim(p_slug)) and web_booking_enabled;
  if st.id is null then return null; end if;
  tz := coalesce(st.timezone, 'Asia/Tokyo');
  select coalesce(array_agg(g.id), '{}') into gids from option_groups g
   where g.store_id = st.id and g.active and exists (select 1 from menus o where o.option_group_id = g.id and o.category = 'option' and coalesce(o.active, true) and o.web_visible);
  return jsonb_build_object(
    'menus', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'name_en', m.name_en, 'description', m.description, 'description_en', m.description_en,
                'image_url', m.image_url, 'price', m.price, 'duration_min', m.duration_min, 'target', m.target, 'nominatable', m.nominatable,
                'people', m.people, 'color', m.color, 'price_per', 'group',
                'option_group_ids', to_jsonb(array(select x from unnest(coalesce(m.option_group_ids, '{}'::uuid[])) x where x = any(gids)))) order by m.sort_order, m.name)
              from menus m where m.store_id = st.id and coalesce(m.active, true) and m.web_visible and m.category = 'technical' and _published(m.publish_from, m.publish_to, tz)), '[]'::jsonb),
    'coupons', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'name_en', c.name_en, 'description', c.description, 'description_en', c.description_en,
                'kind', c.kind, 'value', c.value, 'menu_ids', c.menu_ids, 'target', c.target, 'within_days', c.within_days, 'weekdays', c.weekdays,
                'time_from', to_char(c.time_from, 'HH24:MI'), 'time_to', to_char(c.time_to, 'HH24:MI'), 'has_code', c.code is not null and c.code <> '',
                'left', case when c.first_n is null then null else greatest(0, c.first_n - (select count(*) from bookings y where y.coupon_id = c.id and y.status in ('booked','arrived','done') and y.customer_id is not null)) end,
                'option_group_ids', to_jsonb(array(select x from unnest(coalesce(c.option_group_ids, '{}'::uuid[])) x where x = any(gids))))
                order by c.sort_order, c.name)
              from coupons c where c.store_id = st.id and c.active and c.web_visible and _published(c.publish_from, c.publish_to, tz)
                and (coalesce(c.code, '') = '' or (p_code is not null and lower(btrim(p_code)) = lower(btrim(c.code))))
                and (c.first_n is null or c.first_n > (select count(*) from bookings y where y.coupon_id = c.id and y.status in ('booked','arrived','done') and y.customer_id is not null))), '[]'::jsonb),
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

-- 空き時間（最大31日分）：{"days": {"2026-12-03": ["10:00","10:30",...], ...}}
create or replace function public_availability(p_slug text, p_menu uuid, p_from date, p_to date, p_coupon uuid default null, p_staff uuid default null, p_options uuid[] default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare st stores; d date; v_out jsonb := '{}'::jsonb; arr jsonb; tz text;
begin
  select * into st from stores where slug = lower(btrim(p_slug)) and web_booking_enabled;
  if st.id is null or p_from is null or p_to is null then return null; end if;
  if coalesce(cardinality(p_options), 0) > 10 then return null; end if;
  tz := coalesce(st.timezone, 'Asia/Tokyo');
  if p_to > p_from + 31 then p_to := p_from + 31; end if;
  d := p_from;
  while d < p_to loop
    select coalesce(jsonb_agg(to_char(slot_start at time zone tz, 'HH24:MI') order by slot_start), '[]'::jsonb) into arr from _web_slots(st.id, p_menu, d, p_staff, p_coupon, p_options);
    v_out := v_out || jsonb_build_object(to_char(d, 'YYYY-MM-DD'), arr);
    d := d + 1;
  end loop;
  return jsonb_build_object('days', v_out);
end $$;

-- 予約の確定（店舗単位のロック＋空きの再確認・料金はサーバで計算）。
--  料金＝（クーポン適用後の技術メニュー：ペアは1組の料金）＋オプション×人数＋指名料
--  ペアは同じ開始時刻に2行（pair_group で結ぶ）・担当2人（指名があればその人＋もう1人）
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

-- キャンセル用リンクから予約を見る（メニュー名にオプションをつける）
create or replace function public_booking_by_token(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('booking_no', b.booking_no, 'status', b.status, 'start_at', b.start_at, 'end_at', b.end_at,
    'menu_name', coalesce(m.name, '') || coalesce((select '＋' || string_agg(o.name, '＋' order by o.sort_order, o.name) from menus o where o.id = any(b.menu_ids) and o.category = 'option'), ''),
    'menu_name_en', m.name_en, 'price', b.price_quote, 'store_name', st.name, 'store_phone', st.phone, 'slug', st.slug,
    'customer_name', c.name, 'deadline', _cancel_deadline(st.id, b.start_at),
    'cancellable', b.status = 'booked' and now() <= _cancel_deadline(st.id, b.start_at))
  from bookings b join stores st on st.id = b.store_id left join customers c on c.id = b.customer_id left join menus m on m.id = b.menu_ids[1]
  where p_token is not null and length(p_token) >= 32 and b.cancel_token = p_token
$$;

-- 権限：内部用は直接使わせない／public_* だけ anon に許可
revoke all on function _web_options(uuid, uuid, uuid, uuid[], boolean) from public, anon, authenticated;
revoke all on function _web_slots(uuid, uuid, date, uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public_menus(text, text) from public;
revoke all on function public_availability(text, uuid, date, date, uuid, uuid, uuid[]) from public;
revoke all on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[]) from public;
revoke all on function public_booking_by_token(text) from public;
grant execute on function public_menus(text, text) to anon, authenticated;
grant execute on function public_availability(text, uuid, date, date, uuid, uuid, uuid[]) to anon, authenticated;
grant execute on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[]) to anon, authenticated;
grant execute on function public_booking_by_token(text) to anon, authenticated;

-- 未ログイン（anon）からは表を一切触れないように（新しい表にも付け直す）
revoke all on option_groups from anon;
revoke all on all tables in schema public from anon;

-- API（PostgREST）に新しい列・表・関数をすぐ見せる
notify pgrst, 'reload schema';
