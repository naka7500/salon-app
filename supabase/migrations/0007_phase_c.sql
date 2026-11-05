-- v0.8（フェーズC）：メニュー・クーポン管理／公式ネット予約ページ（お客様用・ログイン不要）／通知キュー／
--                    締め後の赤伝（owner・manager だけ）と修正履歴（audit_logs）／カルテの事前問診。
-- ※先に 0006_phase_b.sql を流しておくこと（空き時間の計算でシフトの休憩列を使う）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists）。
-- 0007 が未適用でもアプリは落ちない（メニューの詳しい項目・クーポン・ネット予約・修正履歴だけ「準備中」になる）。

-- =========================================================
-- 1) 店舗：公開URL（slug）・電話・ロゴ/写真・キャンセル期限・問診の質問
-- =========================================================
alter table stores add column if not exists slug text;
alter table stores add column if not exists name_en text;
alter table stores add column if not exists phone text;
alter table stores add column if not exists address text;
alter table stores add column if not exists logo_url text;
alter table stores add column if not exists photo_url text;
alter table stores add column if not exists web_message text;            -- 予約ページのお知らせ
alter table stores add column if not exists notify_email text;           -- 新しいネット予約の通知先（店舗）
alter table stores add column if not exists cancel_deadline_days int not null default 1;      -- 何日前まで
alter table stores add column if not exists cancel_deadline_time time not null default '18:00'; -- 何時まで（前日18時 など）
alter table stores add column if not exists booking_horizon_days int not null default 60;     -- 何日先まで予約できるか（2か月）
alter table stores add column if not exists booking_lead_min int not null default 60;         -- 今から何分後以降を受けるか
alter table stores add column if not exists intake_questions jsonb;      -- null＝業態別の標準テンプレ
alter table stores add column if not exists web_booking_enabled boolean;
-- 最初の1回だけ：テスト店舗だけネット予約を開ける（本番店舗は設定画面で開ける）
update stores set web_booking_enabled = (id = 'aaaaaaaa-0000-0000-0000-000000000099') where web_booking_enabled is null;
alter table stores alter column web_booking_enabled set default false;
alter table stores alter column web_booking_enabled set not null;
alter table stores drop constraint if exists stores_slug_check;
alter table stores add constraint stores_slug_check check (slug is null or slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$');
alter table stores drop constraint if exists stores_cancel_deadline_check;
alter table stores add constraint stores_cancel_deadline_check check (cancel_deadline_days between 0 and 14 and booking_horizon_days between 1 and 180 and booking_lead_min between 0 and 2880);
create unique index if not exists stores_slug_idx on stores (slug);
update stores set slug = 'kokage-gotanda'  where id = 'aaaaaaaa-0000-0000-0000-000000000002' and slug is null;
update stores set slug = 'laciel-hakozaki' where id = 'aaaaaaaa-0000-0000-0000-000000000001' and slug is null;
update stores set slug = 'test-store'      where id = 'aaaaaaaa-0000-0000-0000-000000000099' and slug is null;

-- =========================================================
-- 2) メニュー：説明・画像・対象（新規/再来）・掲載期間・受付曜日/時間帯・使う受付枠・指名可否・ネット掲載
-- =========================================================
alter table menus add column if not exists description text;
alter table menus add column if not exists description_en text;
alter table menus add column if not exists image_url text;
alter table menus add column if not exists target text not null default 'all';
alter table menus drop constraint if exists menus_target_check;
alter table menus add constraint menus_target_check check (target in ('all','new','repeat'));
alter table menus add column if not exists publish_from date;
alter table menus add column if not exists publish_to date;
alter table menus add column if not exists weekdays int[];               -- null/空＝毎日。0=日〜6=土
alter table menus add column if not exists time_from time;               -- この時刻から受付（開始時刻）
alter table menus add column if not exists time_to time;                 -- この時刻まで受付（開始時刻）
alter table menus add column if not exists lane_id uuid references lanes(id) on delete set null;   -- null＝1名様枠
alter table menus add column if not exists nominatable boolean not null default true;
alter table menus add column if not exists web_visible boolean;
update menus set web_visible = (category = 'technical' and price > 0) where web_visible is null;  -- 最初の1回だけ
alter table menus alter column web_visible set default true;
alter table menus alter column web_visible set not null;

-- =========================================================
-- 3) クーポン
-- =========================================================
create table if not exists coupons (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  name text not null,
  name_en text,
  description text,
  description_en text,
  kind text not null default 'amount' check (kind in ('amount','percent','fixed')),   -- 金額値引／率値引／特別価格
  value int not null default 0 check (value >= 0),         -- 円 or ％ or 特別価格（税込）
  menu_ids uuid[] not null default '{}',                   -- 空＝技術メニュー全部
  target text not null default 'all' check (target in ('all','new','repeat')),
  within_days int check (within_days is null or within_days between 1 and 365),     -- 前回来店から○日以内
  weekdays int[],                                          -- null/空＝毎日（平日限定＝{1,2,3,4,5}）
  time_from time,
  time_to time,
  first_n int check (first_n is null or first_n > 0),      -- 先着○名
  per_customer_limit int check (per_customer_limit is null or per_customer_limit > 0),  -- 1人○回まで
  code text,                                               -- クーポンコード（入れた人だけに見える）
  publish_from date,
  publish_to date,
  web_visible boolean not null default true,
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table coupons drop constraint if exists coupons_percent_check;
alter table coupons add constraint coupons_percent_check check (kind <> 'percent' or value <= 100);
create index if not exists coupons_store_idx on coupons (store_id, sort_order);
alter table coupons enable row level security;
drop policy if exists coupons_rw on coupons;
create policy coupons_rw on coupons for all using (store_id in (select id from stores where company_id in (select my_company_ids())));

-- =========================================================
-- 4) 予約・伝票：クーポン・事前問診・キャンセル用トークン・予約番号
-- =========================================================
alter table bookings add column if not exists coupon_id uuid references coupons(id) on delete set null;
alter table bookings add column if not exists intake jsonb;              -- 事前問診 [{label, answer}]
alter table bookings add column if not exists cancel_token text;         -- お客様のキャンセル用（推測不能なランダム）
alter table bookings add column if not exists booking_no text;           -- お客様に見せる予約番号
alter table bookings add column if not exists price_quote int;           -- 予約時にサーバで計算した料金（税込）
alter table bookings add column if not exists lang text;
create unique index if not exists bookings_cancel_token_idx on bookings (cancel_token) where cancel_token is not null;
create index if not exists bookings_coupon_idx on bookings (coupon_id) where coupon_id is not null;
alter table sales add column if not exists coupon_id uuid references coupons(id) on delete set null;

-- =========================================================
-- 5) 通知キュー（メール送信サービスをつなぐまでは「積むだけ」。店舗画面のバッジにも使う）
-- =========================================================
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  kind text not null check (kind in ('new_booking','cancel_booking','booking_confirmation','cancel_confirmation')),
  channel text not null default 'email',
  to_address text,
  subject text,
  body text,
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  read_at timestamptz                                    -- 店舗の画面で「確認済み」にした日時
);
create index if not exists notifications_store_idx on notifications (store_id, created_at desc);
create index if not exists notifications_queue_idx on notifications (status, created_at) where status = 'queued';
alter table notifications enable row level security;
drop policy if exists notifications_rw on notifications;
create policy notifications_rw on notifications for all using (store_id in (select id from stores where company_id in (select my_company_ids())));

-- =========================================================
-- 6) 修正履歴（audit_logs）：店舗・誰が・理由。読むのは同じ会社のスタッフ、書くのは関数だけ
-- =========================================================
alter table audit_logs add column if not exists store_id uuid references stores(id) on delete set null;
alter table audit_logs add column if not exists actor_staff_id uuid;
alter table audit_logs add column if not exists actor_name text;
alter table audit_logs add column if not exists reason text;
create index if not exists audit_logs_store_idx on audit_logs (store_id, at desc);
drop policy if exists audit_logs_sel on audit_logs;
create policy audit_logs_sel on audit_logs for select using (store_id in (select id from stores where company_id in (select my_company_ids())));

-- 締め済みの伝票は reverse_sale() 経由でしか変えられない（画面やAPIから直接書き換え・削除させない）
create or replace function guard_closed_sales() returns trigger language plpgsql as $$
begin
  if old.closed_on is not null and coalesce(current_setting('app.sale_edit', true), '') <> 'on' then
    raise exception 'closed_sale_locked';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists t_sales_guard_closed on sales;
create trigger t_sales_guard_closed before update or delete on sales for each row execute function guard_closed_sales();

-- 赤伝（取消）。締め前はスタッフ以上、締め後は owner・manager だけ。必ず audit_logs に残す。
create or replace function reverse_sale(p_sale uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare o sales; me staff; r_id uuid; r_no text;
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason_required'; end if;
  select * into o from sales where id = p_sale for update;
  if o.id is null then raise exception 'not_found'; end if;
  select s.* into me from staff s join stores st on st.company_id = s.company_id
   where st.id = o.store_id and s.auth_user_id = auth.uid() and coalesce(s.active, true) order by s.role = 'owner' desc, s.role = 'manager' desc limit 1;
  if me.id is null or me.role = 'viewer' then raise exception 'forbidden'; end if;
  if o.status <> 'confirmed' then raise exception 'already_reversed'; end if;
  if o.closed_on is not null and me.role not in ('owner','manager') then raise exception 'closed_owner_only'; end if;
  perform set_config('app.sale_edit', 'on', true);
  update sales set status = 'voided' where id = o.id;
  r_no := o.sale_no || '-R';
  insert into sales (store_id, booking_id, customer_id, main_staff_id, sale_no, status, reverses_sale_id, subtotal, discount, tax, total, discount_reason, coupon_id, note, created_by)
  values (o.store_id, o.booking_id, o.customer_id, o.main_staff_id, r_no, 'reversal', o.id, -o.subtotal, -o.discount, -o.tax, -o.total, o.discount_reason, o.coupon_id, '赤伝：' || btrim(p_reason), me.id)
  returning id into r_id;
  insert into sale_lines (sale_id, kind, menu_id, product_id, name, unit_price, qty, tax_rate, staff_id, amount)
  select r_id, kind, menu_id, product_id, name, unit_price, -qty, tax_rate, staff_id, -amount from sale_lines where sale_id = o.id;
  insert into payments (sale_id, method, amount) select r_id, method, -amount from payments where sale_id = o.id;
  insert into audit_logs (actor, actor_staff_id, actor_name, store_id, table_name, row_id, action, reason, before, after)
  values (auth.uid(), me.id, me.name, o.store_id, 'sales', o.id::text,
          case when o.closed_on is not null then 'reverse_after_close' else 'reverse' end, btrim(p_reason),
          jsonb_build_object('sale_no', o.sale_no, 'total', o.total, 'sold_at', o.sold_at, 'closed_on', o.closed_on, 'status', o.status),
          jsonb_build_object('reversal_id', r_id, 'reversal_sale_no', r_no, 'total', -o.total, 'role', me.role));
  return r_id;
end $$;
revoke all on function reverse_sale(uuid, text) from public, anon;
grant execute on function reverse_sale(uuid, text) to authenticated;

-- =========================================================
-- 7) 公式ネット予約（anon が使えるのは public_* 関数だけ。表は直接読ませない）
-- =========================================================
-- 電話番号を数字だけにそろえる（+81 → 0）
create or replace function _norm_phone(p text) returns text language sql immutable as $$
  select case when d ~ '^81[0-9]{9,10}$' then '0' || substr(d, 3) else d end
  from (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as d) x
$$;

-- そのメニューが今「掲載中」か（掲載期間は表示の期間。予約日ではなく今日で判定）
create or replace function _published(p_from date, p_to date, p_tz text) returns boolean language sql stable as $$
  select (p_from is null or p_from <= (now() at time zone p_tz)::date) and (p_to is null or p_to >= (now() at time zone p_tz)::date)
$$;

-- クーポン適用後の料金（1名分・税込）
create or replace function _coupon_price(p_kind text, p_value int, p_base int) returns int language sql immutable as $$
  select case p_kind when 'amount' then greatest(0, p_base - p_value)
                     when 'percent' then p_base - floor(p_base * p_value / 100.0)::int
                     when 'fixed' then p_value else p_base end
$$;

-- メニューが使う受付枠と、1件で何名分か（ペア枠＝2名）
create or replace function _menu_lane(p_store uuid, p_lane uuid) returns table(lane_id uuid, capacity int, people int)
language sql stable as $$
  select l.id, l.capacity, case when l.capacity >= 2 and l.id <> f.id then 2 else 1 end
  from lanes l, (select id from lanes where store_id = p_store and coalesce(active, true) order by sort_order, id limit 1) f
  where l.store_id = p_store and coalesce(l.active, true)
  order by (l.id = p_lane) desc, l.sort_order, l.id
  limit 1
$$;

-- 空き時間の計算（1日分）。シフト×受付枠IDLE×既存予約。返すのは開始時刻と、割り当てる担当（空いている順）。
--  条件：①受付枠のIDLEの中で始まる ②受付枠に×が重ならない ③受付枠の同時人数（capacity）以内
--        ④担当：その時間に出勤（休憩と重ならない・所要時間がシフト内に収まる）で予約・ブロックが無い人が必要人数以上
--          （その日シフトが1件も無い店は、予約が重ならない在籍スタッフで判定）
--        ⑤メニュー・クーポンの受付曜日・時間帯 ⑥今から booking_lead_min 分後以降・booking_horizon_days 日先まで
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
    -- 15分（slot_minutes）刻みにそろえる
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
               where coalesce(s.active, true) and (p_staff is null or s.id = p_staff)
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

-- 店舗の公開情報（ネット予約を開けている店舗だけ）
create or replace function public_store_info(p_slug text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('slug', slug, 'name', name, 'name_en', name_en, 'business_type', business_type, 'phone', phone, 'address', address,
    'logo_url', logo_url, 'photo_url', photo_url, 'web_message', web_message, 'cancel_policy', cancel_policy,
    'cancel_deadline_days', cancel_deadline_days, 'cancel_deadline_time', to_char(cancel_deadline_time, 'HH24:MI'),
    'booking_horizon_days', booking_horizon_days, 'slot_minutes', slot_minutes, 'intake_questions', intake_questions,
    'today', to_char((now() at time zone coalesce(timezone, 'Asia/Tokyo'))::date, 'YYYY-MM-DD'))
  from stores where slug = lower(btrim(p_slug)) and web_booking_enabled
$$;

-- 掲載中のメニュー・クーポン・指名できるスタッフ（名前だけ）。クーポンコードを入れるとそのクーポンも出る
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
    'staff', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
              from staff s join staff_stores ss on ss.staff_id = s.id and ss.store_id = st.id where coalesce(s.active, true) and s.role <> 'viewer'), '[]'::jsonb));
end $$;

-- 空き時間（最大31日分）：{"days": {"2026-12-03": ["10:00","10:15",...], ...}}
create or replace function public_availability(p_slug text, p_menu uuid, p_from date, p_to date, p_coupon uuid default null, p_staff uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare st stores; d date; v_out jsonb := '{}'::jsonb; arr jsonb; tz text;
begin
  select * into st from stores where slug = lower(btrim(p_slug)) and web_booking_enabled;
  if st.id is null or p_from is null or p_to is null then return null; end if;
  tz := coalesce(st.timezone, 'Asia/Tokyo');
  if p_to > p_from + 31 then p_to := p_from + 31; end if;
  d := p_from;
  while d < p_to loop
    select coalesce(jsonb_agg(to_char(slot_start at time zone tz, 'HH24:MI') order by slot_start), '[]'::jsonb) into arr from _web_slots(st.id, p_menu, d, p_staff, p_coupon);
    v_out := v_out || jsonb_build_object(to_char(d, 'YYYY-MM-DD'), arr);
    d := d + 1;
  end loop;
  return jsonb_build_object('days', v_out);
end $$;

-- キャンセル期限（予約日の cancel_deadline_days 日前の cancel_deadline_time）
create or replace function _cancel_deadline(p_store uuid, p_start timestamptz) returns timestamptz language sql stable as $$
  select (((p_start at time zone coalesce(timezone, 'Asia/Tokyo'))::date - cancel_deadline_days) + cancel_deadline_time) at time zone coalesce(timezone, 'Asia/Tokyo')
  from stores where id = p_store
$$;

-- 予約の確定。入力検証・空きの再確認（店舗単位のロック）・料金はサーバで計算・電話番号で顧客を照合（無ければ作る）
create or replace function public_create_booking(
  p_slug text, p_menu uuid, p_start timestamptz, p_name text, p_kana text, p_phone text, p_email text,
  p_intake jsonb default '[]'::jsonb, p_coupon uuid default null, p_code text default null, p_staff uuid default null, p_lang text default 'ja'
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st stores; m menus; cp coupons; ln record; tz text; d date; slot record;
  v_phone text; v_email text; nm text; kn text; cust customers; is_new boolean; last_visit timestamptz;
  price int; blk int; tok text; bno text; grp uuid; b_id uuid; first_id uuid; i int; staff_name text; sid uuid;
  note_text text; body text;
begin
  -- 入力の検証
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

  -- 同じ店舗の予約確定は1件ずつ（二重予約防止）
  perform pg_advisory_xact_lock(hashtext('web_booking:' || st.id::text));

  -- 簡易レート制限：同じ電話番号で1時間に3件まで・先の予約は5件まで／店舗全体で10分に30件まで
  if (select count(*) from bookings y join customers c on c.id = y.customer_id
       where y.store_id = st.id and y.channel = 'own' and y.cancel_token is not null and _norm_phone(c.phone) = v_phone and y.created_at > now() - interval '1 hour') >= 3
     or (select count(*) from bookings y join customers c on c.id = y.customer_id
       where y.store_id = st.id and y.channel = 'own' and y.cancel_token is not null and _norm_phone(c.phone) = v_phone and y.status = 'booked' and y.start_at > now()) >= 5
     or (select count(*) from bookings y where y.store_id = st.id and y.cancel_token is not null and y.created_at > now() - interval '10 minutes') >= 30 then
    raise exception 'too_many';
  end if;

  -- 空きの再確認（画面を開いている間に埋まった場合はここで止める）
  d := (p_start at time zone tz)::date;
  select * into slot from _web_slots(st.id, m.id, d, p_staff, p_coupon) s where s.slot_start = p_start;
  if slot.slot_start is null then raise exception 'slot_taken'; end if;

  -- お客様：電話番号で照合（無ければ作る）
  select * into cust from customers where company_id = st.company_id and merged_into is null and _norm_phone(customers.phone) = v_phone order by created_at limit 1;
  if cust.id is null then
    insert into customers (company_id, name, kana, phone, email, source, language)
    values (st.company_id, nm, nullif(kn, ''), p_phone, v_email, 'own', coalesce(p_lang, 'ja')) returning * into cust;
  elsif coalesce(cust.email, '') = '' then
    update customers set email = v_email where id = cust.id;
  end if;
  -- 同じお客様の同じ時刻の予約（二重送信）
  if exists (select 1 from bookings y where y.store_id = st.id and y.customer_id = cust.id and y.start_at = p_start and y.status in ('booked','arrived')) then
    raise exception 'duplicate';
  end if;

  -- 新規/再来・前回来店
  select max(v) into last_visit from (
    select sold_at as v from sales where store_id = st.id and customer_id = cust.id and status = 'confirmed'
    union all select start_at from bookings where store_id = st.id and customer_id = cust.id and status = 'done') z;
  is_new := last_visit is null;
  if m.target = 'new' and not is_new then raise exception 'menu_new_only'; end if;
  if m.target = 'repeat' and is_new then raise exception 'menu_repeat_only'; end if;

  -- 料金（サーバで計算）
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

  -- 予約を作る（ペア枠は2名分＝2行。担当は空いている人を自動で割り当て）
  select * into ln from _menu_lane(st.id, m.lane_id);
  blk := m.duration_min + coalesce(m.interval_min, 0);
  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  bno := 'W' || to_char(now() at time zone tz, 'YYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 5));
  grp := case when ln.people > 1 then gen_random_uuid() else null end;
  note_text := 'ネット予約 ' || bno || case when cp.id is not null then '／クーポン：' || cp.name else '' end;
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
  select name into staff_name from staff where id = slot.staff_ids[1];

  -- 通知キュー（メールは後でつなぐ。今は積むだけ＋店舗画面のバッジ）
  body := '予約番号：' || bno || E'\n日時：' || to_char(p_start at time zone tz, 'YYYY/MM/DD HH24:MI') || E'\nメニュー：' || m.name ||
          case when cp.id is not null then E'\nクーポン：' || cp.name else '' end || E'\n料金：' || price * ln.people || '円（税込）' ||
          E'\nお名前：' || nm || case when kn <> '' then '（' || kn || '）' else '' end || E'\n電話：' || p_phone || E'\nメール：' || v_email ||
          case when staff_name is not null then E'\n担当：' || staff_name || case when p_staff is not null then '（指名）' else '' end else '' end;
  insert into notifications (store_id, booking_id, kind, to_address, subject, body)
  values (st.id, first_id, 'new_booking', st.notify_email, '【新しいネット予約】' || to_char(p_start at time zone tz, 'MM/DD HH24:MI') || ' ' || nm || '様', body),
         (st.id, first_id, 'booking_confirmation', v_email, '【' || st.name || '】ご予約ありがとうございます（' || bno || '）', body);

  return jsonb_build_object('booking_no', bno, 'cancel_token', tok, 'start_at', p_start, 'end_at', p_start + make_interval(mins => blk),
    'menu_name', m.name, 'menu_name_en', m.name_en, 'price', price, 'people', ln.people, 'store_name', st.name, 'staff_name', staff_name,
    'coupon_name', cp.name, 'deadline', _cancel_deadline(st.id, p_start));
end $$;

-- キャンセル用リンクから予約を見る
create or replace function public_booking_by_token(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('booking_no', b.booking_no, 'status', b.status, 'start_at', b.start_at, 'end_at', b.end_at,
    'menu_name', m.name, 'menu_name_en', m.name_en, 'price', b.price_quote, 'store_name', st.name, 'store_phone', st.phone, 'slug', st.slug,
    'customer_name', c.name, 'deadline', _cancel_deadline(st.id, b.start_at),
    'cancellable', b.status = 'booked' and now() <= _cancel_deadline(st.id, b.start_at))
  from bookings b join stores st on st.id = b.store_id left join customers c on c.id = b.customer_id left join menus m on m.id = b.menu_ids[1]
  where p_token is not null and length(p_token) >= 32 and b.cancel_token = p_token
$$;

-- お客様のキャンセル（期限内だけ。ペアは同行者の行もまとめて）
create or replace function public_cancel_booking(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b bookings; st stores; tz text; c_name text;
begin
  if p_token is null or length(p_token) < 32 then raise exception 'not_found'; end if;
  select * into b from bookings where cancel_token = p_token for update;
  if b.id is null then raise exception 'not_found'; end if;
  select * into st from stores where id = b.store_id;
  tz := coalesce(st.timezone, 'Asia/Tokyo');
  if b.status = 'cancelled' then raise exception 'already_cancelled'; end if;
  if b.status <> 'booked' then raise exception 'not_cancellable'; end if;
  if now() > _cancel_deadline(st.id, b.start_at) then raise exception 'deadline_passed'; end if;
  update bookings set status = 'cancelled', note = coalesce(note, '') || '／お客様がネットでキャンセル ' || to_char(now() at time zone tz, 'MM/DD HH24:MI')
   where id = b.id or (b.pair_group is not null and pair_group = b.pair_group);
  select name into c_name from customers where id = b.customer_id;
  insert into notifications (store_id, booking_id, kind, to_address, subject, body)
  values (st.id, b.id, 'cancel_booking', st.notify_email, '【ネット予約のキャンセル】' || to_char(b.start_at at time zone tz, 'MM/DD HH24:MI') || ' ' || coalesce(c_name, '') || '様',
          '予約番号：' || coalesce(b.booking_no, '') || E'\n日時：' || to_char(b.start_at at time zone tz, 'YYYY/MM/DD HH24:MI') || E'\nお名前：' || coalesce(c_name, ''));
  return jsonb_build_object('ok', true, 'booking_no', b.booking_no);
end $$;

-- 権限：内部用の関数は誰にも直接使わせない／公開用の public_* だけ anon（未ログイン）に許可
revoke all on function _norm_phone(text) from public, anon, authenticated;
revoke all on function _published(date, date, text) from public, anon, authenticated;
revoke all on function _coupon_price(text, int, int) from public, anon, authenticated;
revoke all on function _menu_lane(uuid, uuid) from public, anon, authenticated;
revoke all on function _web_slots(uuid, uuid, date, uuid, uuid) from public, anon, authenticated;
revoke all on function _cancel_deadline(uuid, timestamptz) from public, anon, authenticated;
revoke all on function guard_closed_sales() from public, anon, authenticated;
revoke all on function public_store_info(text) from public;
revoke all on function public_menus(text, text) from public;
revoke all on function public_availability(text, uuid, date, date, uuid, uuid) from public;
revoke all on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text) from public;
revoke all on function public_booking_by_token(text) from public;
revoke all on function public_cancel_booking(text) from public;
grant execute on function public_store_info(text) to anon, authenticated;
grant execute on function public_menus(text, text) to anon, authenticated;
grant execute on function public_availability(text, uuid, date, date, uuid, uuid) to anon, authenticated;
grant execute on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text) to anon, authenticated;
grant execute on function public_booking_by_token(text) to anon, authenticated;
grant execute on function public_cancel_booking(text) to anon, authenticated;

-- 未ログイン（anon）からは表を一切触れないように（0003 と同じ方針。新しい表にも付け直す）
revoke all on coupons, notifications from anon;
revoke all on all tables in schema public from anon;

-- API（PostgREST）に新しい列・表・関数をすぐ見せる
notify pgrst, 'reload schema';
