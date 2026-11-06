-- 顧客CSV取り込み（サロンアンサー・カミングスーンなど前のPOSから）と、旧POSの来店履歴。
-- ※必ず 0011_hpb_inbound.sql の後に流すこと（0011 が無いと最初で止まります。DBは何も変わりません）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists）。
-- 0012 が未適用でもアプリは落ちない（設定＞顧客CSV取り込み が「準備中」になるだけ）。
--
-- やること
--  1) import_logs：取り込みの記録（誰が・いつ・どのファイル・何件・取り消したか）
--  2) customers に 生年月日・郵便番号・住所・取り込み元（import_source）・前のPOSの顧客番号（external_id）・作った取り込み（import_id）
--     顧客番号は「会社×取り込み元」で重複させない（同じCSVをもう一度取り込んでも二重にならない）
--  3) historical_visits：旧POSの来店（売上台帳・経理の集計には入れない。新規/再来・前回来店の判定にだけ使う）
--  4) import_presets：列の対応（見出し→項目）の保存（取り込み元×種類ごと）
--  5) undo_import()：取り込みの取り消し（その取り込みで作った人のうち、予約・会計・カルテが無い人だけ消す）
--  6) public_create_booking()：ネット予約の「新規限定」「前回来店から○日以内」の判定に旧POSの来店も入れる（0009 の関数に1か所足しただけ）
--  7) 書き込みは owner・manager（my_role_in_company）。未ログイン（anon）からは触れない

do $$ begin
  if to_regclass('public.inbound_mails') is null or to_regclass('public.hpb_settings') is null then
    raise exception '0011 がまだ流れていません。先に 0011_hpb_inbound.sql を流してから、この 0012 を流してください';
  end if;
  if to_regprocedure('public.is_company_admin(uuid)') is null then
    raise exception '0008 がまだ流れていません。0008 → 0009 → 0010 → 0011 → 0012 の順に流してください';
  end if;
end $$;

-- =========================================================
-- 1) 取り込みの記録
-- =========================================================
create table if not exists import_logs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  kind text not null check (kind in ('customers', 'visits')),
  source text not null check (source in ('salonanswer', 'comingsoon', 'other')),
  file_name text not null default '',
  mode text not null default 'fill' check (mode in ('fill', 'overwrite')),
  actor_staff_id uuid references staff(id) on delete set null,
  actor_name text,
  counts jsonb not null default '{}',
  undone_at timestamptz,
  undo_result jsonb,
  created_at timestamptz not null default now()
);
alter table import_logs drop constraint if exists import_logs_file_check;
alter table import_logs add constraint import_logs_file_check check (length(file_name) <= 300);
create index if not exists import_logs_company_idx on import_logs (company_id, created_at desc);

-- 記録した人：ログイン中のスタッフを自動で入れる（画面から送られた名前は使わない）
create or replace function import_logs_actor() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    select s.id, s.name into new.actor_staff_id, new.actor_name from staff s
     where s.auth_user_id = auth.uid() and s.company_id = new.company_id
     order by case s.role when 'owner' then 0 when 'manager' then 1 else 2 end limit 1;
    new.created_at := now(); new.undone_at := null; new.undo_result := null;
  else
    new.actor_staff_id := old.actor_staff_id; new.actor_name := old.actor_name; new.created_at := old.created_at;
    new.company_id := old.company_id; new.store_id := old.store_id; new.kind := old.kind; new.source := old.source;
  end if;
  return new;
end $$;
drop trigger if exists import_logs_actor_trg on import_logs;
create trigger import_logs_actor_trg before insert or update on import_logs for each row execute function import_logs_actor();

-- =========================================================
-- 2) お客様の項目
-- =========================================================
alter table customers add column if not exists birthday date;
alter table customers add column if not exists postal_code text;
alter table customers add column if not exists address text;
alter table customers add column if not exists import_source text;
alter table customers add column if not exists external_id text;
alter table customers add column if not exists import_id uuid references import_logs(id) on delete set null;
alter table customers drop constraint if exists customers_import_source_check;
alter table customers add constraint customers_import_source_check check (import_source is null or import_source in ('salonanswer', 'comingsoon', 'other'));
alter table customers drop constraint if exists customers_external_id_check;
alter table customers add constraint customers_external_id_check check (external_id is null or length(external_id) between 1 and 100);
create unique index if not exists customers_import_ext_uq on customers (company_id, import_source, external_id) where external_id is not null and import_source is not null;
create index if not exists customers_import_id_idx on customers (import_id) where import_id is not null;

-- =========================================================
-- 3) 旧POSの来店（売上台帳・経理には入れない）
-- =========================================================
create table if not exists historical_visits (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  store_id uuid not null references stores(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  kind text not null default 'visit' check (kind in ('visit', 'summary')),
  visited_on date,                                   -- kind=visit：来店日
  first_visit_on date, last_visit_on date, visit_count int,   -- kind=summary：顧客CSVの 初回・最終・回数
  staff_name text, menu_text text, amount int, slip_no text,
  source text not null check (source in ('salonanswer', 'comingsoon', 'other')),
  dedupe_key text not null,                          -- 同じ行を二重に入れないためのキー
  import_id uuid references import_logs(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table historical_visits drop constraint if exists historical_visits_shape_check;
alter table historical_visits add constraint historical_visits_shape_check check (
  (kind = 'visit' and visited_on is not null) or (kind = 'summary' and (first_visit_on is not null or last_visit_on is not null or visit_count is not null or staff_name is not null)));
alter table historical_visits drop constraint if exists historical_visits_len_check;
alter table historical_visits add constraint historical_visits_len_check check (
  length(dedupe_key) <= 400 and length(coalesce(menu_text, '')) <= 500 and length(coalesce(staff_name, '')) <= 100 and length(coalesce(slip_no, '')) <= 100
  and (visit_count is null or visit_count between 0 and 100000));
create unique index if not exists historical_visits_dedupe_uq on historical_visits (company_id, store_id, source, dedupe_key);
create index if not exists historical_visits_cust_idx on historical_visits (store_id, customer_id);
create index if not exists historical_visits_import_idx on historical_visits (import_id) where import_id is not null;

-- =========================================================
-- 4) 列の対応の保存
-- =========================================================
create table if not exists import_presets (
  company_id uuid not null references companies(id) on delete cascade,
  source text not null check (source in ('salonanswer', 'comingsoon', 'other')),
  kind text not null check (kind in ('customers', 'visits')),
  mapping jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (company_id, source, kind)
);
alter table import_presets drop constraint if exists import_presets_size_check;
alter table import_presets add constraint import_presets_size_check check (length(mapping::text) <= 20000);

-- =========================================================
-- 5) 取り込みの取り消し
-- =========================================================
create or replace function undo_import(p_import uuid) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare lg import_logs; v_removed int := 0; v_kept int := 0; v_visits int := 0; res jsonb;
begin
  select * into lg from import_logs where id = p_import for update;
  if lg.id is null then raise exception 'import_not_found'; end if;
  if not is_company_admin(lg.company_id) then raise exception 'not_allowed'; end if;
  if lg.undone_at is not null then raise exception 'already_undone'; end if;
  delete from historical_visits where import_id = lg.id;
  get diagnostics v_visits = row_count;
  -- その取り込みで作った人のうち、予約・会計・カルテ・ほかの来店履歴・統合先になっていない人だけ消す
  with del as (
    delete from customers c where c.import_id = lg.id and c.company_id = lg.company_id
      and not exists (select 1 from bookings b where b.customer_id = c.id)
      and not exists (select 1 from sales s where s.customer_id = c.id)
      and not exists (select 1 from karte_entries k where k.customer_id = c.id)
      and not exists (select 1 from historical_visits h where h.customer_id = c.id)
      and not exists (select 1 from customers m where m.merged_into = c.id)
    returning c.id)
  select count(*) into v_removed from del;
  select count(*) into v_kept from customers where import_id = lg.id;
  res := jsonb_build_object('removed', v_removed, 'kept', v_kept, 'visits', v_visits);
  update import_logs set undone_at = now(), undo_result = res where id = lg.id;
  -- update のトリガーは undone_at を消さないように（insert のときだけ初期化する）
  return res;
end $$;
revoke all on function undo_import(uuid) from public, anon;
grant execute on function undo_import(uuid) to authenticated;

-- =========================================================
-- 6) ネット予約：旧POSの来店も「前回来店」に数える
-- =========================================================
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

-- =========================================================
-- 7) RLS
-- =========================================================
alter table import_logs enable row level security;
alter table historical_visits enable row level security;
alter table import_presets enable row level security;

-- 取り込みの記録：見る・書くのは owner・manager だけ（消すのは不可。取り消しは undo_import で記録を残す）
drop policy if exists import_logs_sel on import_logs;
drop policy if exists import_logs_ins on import_logs;
drop policy if exists import_logs_upd on import_logs;
create policy import_logs_sel on import_logs for select using (is_company_admin(company_id));
create policy import_logs_ins on import_logs for insert with check (is_company_admin(company_id) and store_id in (select id from stores where company_id = import_logs.company_id));
create policy import_logs_upd on import_logs for update using (is_company_admin(company_id)) with check (is_company_admin(company_id));

-- 旧POSの来店：読むのは会社のスタッフ（会計画面の新規/再来の判定に使う）、書くのは owner・manager
drop policy if exists historical_visits_sel on historical_visits;
drop policy if exists historical_visits_ins on historical_visits;
drop policy if exists historical_visits_upd on historical_visits;
drop policy if exists historical_visits_del on historical_visits;
create policy historical_visits_sel on historical_visits for select using (company_id in (select my_company_ids()));
create policy historical_visits_ins on historical_visits for insert with check (is_company_admin(company_id)
  and store_id in (select id from stores where company_id = historical_visits.company_id)
  and customer_id in (select id from customers where company_id = historical_visits.company_id));
create policy historical_visits_upd on historical_visits for update using (is_company_admin(company_id)) with check (is_company_admin(company_id)
  and customer_id in (select id from customers where company_id = historical_visits.company_id));
create policy historical_visits_del on historical_visits for delete using (is_company_admin(company_id));

-- 列の対応：owner・manager だけ
drop policy if exists import_presets_rw on import_presets;
create policy import_presets_rw on import_presets for all using (is_company_admin(company_id)) with check (is_company_admin(company_id));

revoke all on import_logs, historical_visits, import_presets from anon;
grant select, insert, update on import_logs to authenticated;
grant select, insert, update, delete on historical_visits, import_presets to authenticated;

-- 未ログイン（anon）からは表を一切触れないように（新しい表にも付け直す）
revoke all on all tables in schema public from anon;

-- API（PostgREST）に新しい表・列をすぐ見せる
notify pgrst, 'reload schema';

select '0012 OK：顧客CSV取り込み（取り込みの記録・旧POSの来店・列の対応・取り消し）を用意しました' as result,
       (select count(*) from import_logs) as logs, (select count(*) from historical_visits) as visits;
