-- 0020：LINE連携の確認待ち（オーナー決定 2026-11-08。監査 2026-11-07 R1 の残り）
-- 決まったこと：
--  1) LINEの中の予約（LIFF）で自動でつなぐのは、その予約でお客様を新しく作ったとき（bookings.customer_created＝0019）だけ。
--     既存のお客様（電話番号が一致）に当たったときは、LINEがつながっていてもいなくても、つながず「確認待ち」（line_link_requests）を作る。
--     スタッフが予約詳細・顧客詳細で「この方のLINEとつなぐ／つながない」を押す（サーバ /api/line/link-request が役割を確かめる）。30日で期限切れ。
--  2) つないだ経路に staff_approved（スタッフが確認してつないだ）を足す。前回入力（/api/line/me）は token・booking_new・staff_approved だけ。
--  3) public_create_booking：既存のお客様の名前・フリガナ・メール・電話をネット予約の入力で変えない・埋めない。
--     予約した人が入れた内容は予約の web_name・web_kana・web_phone・web_email に残す（予約詳細で「登録内容と違います」を出す）。
--     関数は 0019 の最新版をそのまま写して、★0020 の行だけ変えた（メールを埋める3行を消し、web_* を入れる）。
--  4) 監査 2026-11-08（全体再点検）S1・C1・C2・C3・C7 も同じ更新で：
--     S1 public_booking_by_token は登録名を返さない（予約時の入力 web_name だけ）
--     C1 新規限定・再来限定・○日以内・利用回数は断らずに予約を受け、bookings.web_check（予約メモにも「要確認：…」）でスタッフに知らせる
--     C2 店全体の上限は「新しいお客様を作る予約」だけで数える（1時間20件・1日60件）。いつものお客様は止まらない。電話番号ごとの上限（1時間3件・先の予約5件）はそのまま
--     C3 既存のお客様のメールを予約者のメールで埋めない（上の 3）
--     C7 LINE予約で作られたお客様（booking_new）に、あとから別の予約が寄ったら line_links.needs_confirm＝true（自動のお知らせを止める）＋持ち主の確認待ちを作る（トリガ）
-- ※必ず 0019 の後に流すこと（0019 が無いと最初で止まります。DBは何も変わりません）。
-- ※何度流しても同じ（if not exists / create or replace / drop policy if exists）。

begin;

do $$ declare f regprocedure := to_regprocedure('public.public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[])');
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name = 'customer_created')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'line_links' and column_name = 'linked_via')
     or f is null or coalesce(pg_get_functiondef(f), '') not like '%v_new_cust%' then
    raise exception '0019 が流れていません。先に 0019_line_link_guard.sql を流してから、もう一度 0020 を流してください（DBは何も変わっていません）';
  end if;
end $$;

-- 1) つないだ経路に staff_approved を足す
alter table line_links drop constraint if exists line_links_linked_via_check;
alter table line_links add constraint line_links_linked_via_check check (linked_via is null or linked_via in ('token', 'booking_new', 'booking', 'staff_approved'));
comment on column line_links.linked_via is '0019/0020：つないだ経路。token＝会計のQR／booking_new＝LINE予約で新規のお客様／staff_approved＝確認待ちをスタッフが承認／booking＝0019の間にLINE予約で既存のお客様（0020以降は作らない）。前回入力は token・booking_new・staff_approved だけ';

-- 2) 予約した人が入れた内容（既存のお客様の登録内容は変えないので、違いをスタッフが見られるように）
alter table bookings add column if not exists web_name text;
alter table bookings add column if not exists web_kana text;
alter table bookings add column if not exists web_phone text;
alter table bookings add column if not exists web_email text;
comment on column bookings.web_name is '0020：ネット予約で予約した人が入れた名前（お客様の登録内容は変えない）';

-- 3) LINE連携の確認待ち
create table if not exists line_link_requests (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  booking_id uuid references bookings(id) on delete set null,
  line_user_id text not null check (line_user_id ~ '^U[0-9a-f]{32}$'),
  display_name text check (display_name is null or length(display_name) <= 80),
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_by uuid references staff(id) on delete set null,
  decided_at timestamptz
);
comment on table line_link_requests is '0020：LINE予約が既存のお客様に当たったときの「LINE連携の確認待ち」。スタッフが承認するとつなぐ（30日で期限切れ）';
create unique index if not exists line_link_requests_pending_key on line_link_requests (store_id, customer_id, line_user_id) where status = 'pending';
create index if not exists line_link_requests_store_idx on line_link_requests (store_id, status, created_at desc);
create index if not exists line_link_requests_customer_idx on line_link_requests (customer_id) where status = 'pending';
alter table line_link_requests enable row level security;
drop policy if exists line_link_requests_sel on line_link_requests;
drop policy if exists line_link_requests_upd on line_link_requests;
-- 見る：同じ会社のスタッフ。変える：同じ会社の書ける人（owner・manager・staff）が、確認待ちのものを「つながない／期限切れ」にだけ
-- （「つなぐ」は LINE のつながりを作る必要があるので、サーバ /api/line/link-request＝サービスキーだけ）
create policy line_link_requests_sel on line_link_requests for select to authenticated
  using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy line_link_requests_upd on line_link_requests for update to authenticated
  using (status = 'pending' and exists (select 1 from stores s where s.id = store_id and can_write_company(s.company_id)))
  with check (status in ('rejected', 'expired') and exists (select 1 from stores s where s.id = store_id and can_write_company(s.company_id)));
revoke all on line_link_requests from public, anon, authenticated;
grant select on line_link_requests to authenticated;
grant update (status, decided_by, decided_at) on line_link_requests to authenticated;
grant all on line_link_requests to service_role;

-- 期限切れ（30日）。サーバの cron も同じことをする
update line_link_requests set status = 'expired', decided_at = now() where status = 'pending' and created_at < now() - interval '30 days';

-- 3b) 予約の「要確認」（C1：来店歴で決まる条件に合わないかもしれない予約は、断らずにここへ書く）
alter table bookings add column if not exists web_check text;
comment on column bookings.web_check is '0020：ネット予約で、新規限定・再来限定・○日以内・利用回数の条件に合わないかもしれないもの（断るとお客様かどうかが外から分かるので、予約は受けてスタッフが確認）';

-- 3c) 「先取り」対策（C7）：LINE予約で新しく作られたお客様のつながり（booking_new）は、
--     そのお客様に後から別の予約（ネット予約・HPB・台帳）が電話番号などで寄ったら「持ち主の確認待ち」にして、自動のお知らせを止める。
--     スタッフが確認待ち（同じ LINE）を「この方のLINEで合っている」で承認すると staff_approved になり再開、「外す」でつながりを外す。
alter table line_links add column if not exists needs_confirm boolean not null default false;
comment on column line_links.needs_confirm is '0020：true の間は前日確認・再来案内・手動連絡・前回入力を止める（LINE予約で作られたお客様に、あとから別の予約が寄ったとき）';
create or replace function _line_link_flag_on_booking() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare l line_links;
begin
  if new.customer_id is null or coalesce(new.customer_created, false) or new.status = 'block' then return new; end if;
  select * into l from line_links where store_id = new.store_id and customer_id = new.customer_id and linked_via = 'booking_new' limit 1;
  if l.id is null then return new; end if;
  if not l.needs_confirm then update line_links set needs_confirm = true, updated_at = now() where id = l.id; end if;
  if l.line_user_id ~ '^U[0-9a-f]{32}$' then
    insert into line_link_requests (store_id, customer_id, booking_id, line_user_id, display_name)
    values (new.store_id, new.customer_id, new.id, l.line_user_id, left(l.display_name, 80))
    on conflict (store_id, customer_id, line_user_id) where status = 'pending' do nothing;
  end if;
  return new;
end $$;
revoke all on function _line_link_flag_on_booking() from public, anon, authenticated;
drop trigger if exists bookings_line_link_flag on bookings;
create trigger bookings_line_link_flag after insert on bookings for each row execute function _line_link_flag_on_booking();

-- 3d) キャンセル用の画面（S1）：お客様の登録名は返さない。返すのは、その予約で入力された名前（web_name）だけ（0020 より前の予約は名前なし）
create or replace function public_booking_by_token(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('booking_no', b.booking_no, 'status', b.status, 'start_at', b.start_at, 'end_at', b.end_at,
    'menu_name', coalesce(m.name, '') || coalesce((select '＋' || string_agg(o.name, '＋' order by o.sort_order, o.name) from menus o where o.id = any(b.menu_ids) and o.category = 'option'), ''),
    'menu_name_en', m.name_en, 'price', b.price_quote, 'store_name', st.name, 'store_phone', st.phone, 'slug', st.slug,
    'customer_name', b.web_name, 'deadline', _cancel_deadline(st.id, b.start_at),   -- ★0020：customers.name（登録名）ではなく予約時の入力
    'cancellable', b.status = 'booked' and now() <= _cancel_deadline(st.id, b.start_at))
  from bookings b join stores st on st.id = b.store_id left join menus m on m.id = b.menu_ids[1]
  where p_token is not null and length(p_token) >= 32 and b.cancel_token = p_token
$$;
revoke all on function public_booking_by_token(text) from public;
grant execute on function public_booking_by_token(text) to anon, authenticated;

-- 4) 予約の確定（0019 の public_create_booking。★0020 の行だけ変更）
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
  v_check text[] := '{}';         -- ★0020（C1）：来店歴で決まる条件に合わないかもしれないもの（断らずにスタッフへ）
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
     -- ★0020（C2）：店全体の上限は「新しいお客様を作る予約」だけで数える（1時間20件・1日60件）。いつものお客様（電話番号が登録済み）は止めない
     or (not exists (select 1 from customers c where c.company_id = st.company_id and c.merged_into is null and _norm_phone(c.phone) = v_phone)
         and ((select count(*) from bookings y where y.store_id = st.id and y.customer_created and y.created_at > now() - interval '1 hour') >= 20
           or (select count(*) from bookings y where y.store_id = st.id and y.customer_created and y.created_at > now() - interval '1 day') >= 60)) then
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
  -- ★0020：既存のお客様の名前・フリガナ・メール・電話は、ネット予約の入力で変えない・埋めない（入力は予約の web_* に残す）
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
  -- ★0020（C1）：来店歴で決まる条件は断らない（断ると「この電話番号はお客様か・最近来たか」が分かってしまう）。予約は受けて、スタッフに「要確認」を出す
  if m.target = 'new' and not is_new then v_check := array_append(v_check, '新規限定メニューの対象外の可能性'::text); end if;
  if m.target = 'repeat' and is_new then v_check := array_append(v_check, '再来限定メニューの対象外の可能性'::text); end if;

  price := m.price;
  if p_coupon is not null then
    select * into cp from coupons where id = p_coupon and store_id = st.id and active and web_visible;
    if cp.id is null or not _published(cp.publish_from, cp.publish_to, tz) then raise exception 'coupon_invalid'; end if;
    if coalesce(cp.code, '') <> '' and lower(btrim(coalesce(p_code, ''))) <> lower(btrim(cp.code)) then raise exception 'coupon_code'; end if;
    if cardinality(cp.menu_ids) > 0 and not (m.id = any(cp.menu_ids)) then raise exception 'coupon_menu'; end if;
    if cp.target = 'new' and not is_new then v_check := array_append(v_check, '新規クーポンの対象外の可能性'::text); end if;          -- ★0020（C1）
    if cp.target = 'repeat' and is_new then v_check := array_append(v_check, '再来クーポンの対象外の可能性'::text); end if;          -- ★0020（C1）
    if cp.within_days is not null and (last_visit is null or d - (last_visit at time zone tz)::date > cp.within_days) then v_check := array_append(v_check, '前回から' || cp.within_days || '日以内クーポンの対象外の可能性'); end if;   -- ★0020（C1）
    if cp.first_n is not null and (select count(*) from bookings y where y.coupon_id = cp.id and y.status in ('booked','arrived','done') and y.customer_id is not null) >= cp.first_n then raise exception 'coupon_sold_out'; end if;
    if cp.per_customer_limit is not null and (select count(*) from bookings y where y.coupon_id = cp.id and y.customer_id = cust.id and y.status in ('booked','arrived','done')) >= cp.per_customer_limit then v_check := array_append(v_check, 'クーポンの利用回数を超えている可能性'::text); end if;   -- ★0020（C1）
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
               || case when coalesce(fee, 0) > 0 then '／指名料 ' || fee || '円' else '' end
               || case when cardinality(v_check) > 0 then '／要確認：' || array_to_string(v_check, '・') else '' end;   -- ★0020（C1）
  for i in 1..ppl loop
    sid := slot.staff_ids[i];
    insert into bookings (store_id, customer_id, customer_name, staff_id, lane_id, start_at, end_at, status, channel, menu_ids, nominated, pair_group, note,
                          coupon_id, intake, cancel_token, booking_no, price_quote, lang, customer_created,
                          web_name, web_kana, web_phone, web_email, web_check)   -- ★0020
    values (st.id, case when i = 1 then cust.id else null end, case when i = 1 then null else nm || '（同行者）' end, sid, ln.lane_id,
            p_start, p_start + make_interval(mins => blk), 'booked', 'own', array[m.id] || opt_ids, p_staff is not null and i = 1, grp, note_text,
            cp.id, case when i = 1 then p_intake else null end, case when i = 1 then tok else null end, bno, case when i = 1 then total else null end, coalesce(p_lang, 'ja'),
            i = 1 and v_new_cust,   -- ★0019
            case when i = 1 then nm else null end, case when i = 1 then nullif(kn, '') else null end,   -- ★0020：予約した人が入れた内容
            case when i = 1 then p_phone else null end, case when i = 1 then v_email else null end,
            case when i = 1 and cardinality(v_check) > 0 then array_to_string(v_check, '・') else null end)
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
  values (st.id, first_id, 'new_booking', st.notify_email, '【新しいネット予約】' || to_char(p_start at time zone tz, 'MM/DD HH24:MI') || ' ' || nm || '様',
          body || case when cardinality(v_check) > 0 then E'\n要確認：' || array_to_string(v_check, '・') else '' end),   -- ★0020（C1）お店あてだけ
         (st.id, first_id, 'booking_confirmation', v_email, '【' || st.name || '】ご予約ありがとうございます（' || bno || '）', body);

  return jsonb_build_object('booking_no', bno, 'cancel_token', tok, 'start_at', p_start, 'end_at', p_start + make_interval(mins => blk),
    'menu_name', m.name, 'menu_name_en', m.name_en, 'price', round(total::numeric / ppl)::int, 'price_total', total, 'options_label', o.label,
    'people', ppl, 'store_name', st.name, 'staff_name', staff_name, 'coupon_name', cp.name, 'deadline', _cancel_deadline(st.id, p_start));
end $$;
revoke all on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[]) from public;
grant execute on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[]) to anon, authenticated;

commit;

-- 5) 結果
select '0020 OK：LINE連携の確認待ち（line_link_requests）・経路 staff_approved・予約の入力欄（bookings.web_*）・持ち主の確認（line_links.needs_confirm）を追加し、public_create_booking・public_booking_by_token を更新しました（既存のお客様の登録内容を変えない・出さない）／確認待ち '
       || (select count(*) from line_link_requests where status = 'pending') || '件' as result;
