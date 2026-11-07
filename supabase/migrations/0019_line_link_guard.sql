-- 0019：LINE連携の乗っ取り対策（監査 2026-11-07 R1）
-- 困りごと：LINEの中の予約ページ（LIFF）で「他人の電話番号」で予約すると、public_create_booking が電話番号で既存のお客様に予約をつなぐため、
--   そのあとの自動LINE連携（booking モード）で、他人のお客様情報に自分のLINEがつながり、前の LINE が外れてしまう。
-- 直し方（DB側）：
--  1) bookings.customer_created ……「この予約でお客様を新しく作った」印。public_create_booking が新規のお客様を insert したときだけ true
--     → サーバ（src/lib/line/server.ts handleLink）は、この印が true のとき、または そのお客様にまだ LINE がつながっていないときだけ booking モードでつなぐ。
--       既存のお客様に別の LINE がつながっているときは付け替えない（会計のQRでだけつなぎ直せる）
--  2) line_links.linked_via …… どの経路でつないだか（token＝会計のQR／booking_new＝LINE予約で新規のお客様／booking＝LINE予約で既存のお客様）
--     → /api/line/me（前回の入力を入れておく）は token・booking_new のときだけ名前・電話・メールを返す
--  3) public_create_booking は 0018 の最新版をそのまま写して、★0019 の4行だけ足した（動きはほかに変えていない）
-- ※必ず 0018 の後に流すこと（0018 が無いと最初で止まります。DBは何も変わりません）。
-- ※何度流しても同じ（add column if not exists / create or replace）。
-- ※既存の予約は customer_created=false（＝「新規とは言えない」側に倒す）。既存の line_links は linked_via=null（＝前回入力の自動入力はしない。
--   次に LINE から予約するか会計のQRでつなぎ直すと復活する）

begin;

do $$ declare f regprocedure := to_regprocedure('public.public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[])');
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'menus' and column_name = 'coupon_only')
     or f is null or coalesce(pg_get_functiondef(f), '') not like '%menu_coupon_only%' then
    raise exception '0018 が流れていません。先に 0015 → 0016 → 0017 → 0018 を流してください';
  end if;
end $$;

-- 1) 列
alter table bookings add column if not exists customer_created boolean not null default false;
comment on column bookings.customer_created is '0019：ネット予約（public_create_booking）でこの予約がお客様を新しく作ったとき true。LINE自動連携（booking モード）の許可判定に使う';
alter table line_links add column if not exists linked_via text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'line_links_linked_via_check') then
    alter table line_links add constraint line_links_linked_via_check check (linked_via is null or linked_via in ('token', 'booking_new', 'booking'));
  end if;
end $$;
comment on column line_links.linked_via is '0019：つないだ経路。token＝会計のQR／booking_new＝LINE予約で新規のお客様／booking＝LINE予約で既存のお客様（前回入力の自動入力は token・booking_new だけ）';

-- 2) 予約の確定（0018 の public_create_booking。★0019 の4行だけ追加）
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
  v_new_cust boolean := false;   -- ★0019：この予約でお客様を新しく作ったか
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
    v_new_cust := true;   -- ★0019
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
                          coupon_id, intake, cancel_token, booking_no, price_quote, lang, customer_created)
    values (st.id, case when i = 1 then cust.id else null end, case when i = 1 then null else nm || '（同行者）' end, sid, ln.lane_id,
            p_start, p_start + make_interval(mins => blk), 'booked', 'own', array[m.id] || opt_ids, p_staff is not null and i = 1, grp, note_text,
            cp.id, case when i = 1 then p_intake else null end, case when i = 1 then tok else null end, bno, case when i = 1 then total else null end, coalesce(p_lang, 'ja'),
            i = 1 and v_new_cust)   -- ★0019
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

commit;

-- 3) 結果
select '0019 OK：bookings.customer_created と line_links.linked_via を追加し、public_create_booking を更新しました（LINE自動連携の乗っ取り対策）／customer_created=true の予約 '
       || (select count(*) from bookings where customer_created) || '件／経路つきの LINE連携 '
       || (select count(*) from line_links where linked_via is not null) || '件' as result;
