-- 0022：LINE予約の本人＝LINEのユーザーID（オーナー決定「案B」2026-11-08）
-- 決まったこと：
--  1) LINEの中の予約（LIFF）では、LINEのユーザーIDがそのお客様の「本人」。電話番号では既存のお客様に一切つながない。
--     ・そのLINEにつながっているお客様がいれば、そのお客様の予約として作る
--     ・いなければ、新しいお客様を作って（入力した名前・フリガナ・電話・メールをそのまま保存）、すぐにつなぐ（linked_via='line_id'）
--     ・「確認待ち」（0020 の line_link_requests）は LINE予約からは作らない。表と承認の仕組みは残す（残っている確認待ちの決着用）
--  2) LINE以外のネット予約（ブラウザ）は 0020 のまま：電話番号で既存のお客様につなぐが、登録内容は変えない・出さない（S1・C1・C2・C3）
--  3) 0020 の C7（LINE予約で作られたお客様に別の予約が寄ったら needs_confirm＝true にして止めるトリガ）は外す。
--     案B では LINE予約が電話番号で他人につながることが無いので「先取り」は起きない。残っていた needs_confirm は全部 false に戻す。
--     （LINE以外のネット予約で他人の電話番号を使うと、前日確認はその電話番号の持ち主のLINEに届く＝本人への警告になる。オーナー了承）
--  4) 同じ電話番号のお客様が2人以上いるときは、スタッフが見て「統合する」（merge_customers）。自動では統合しない。
--     統合できるのは、その会社の在籍の owner・manager・staff（can_write_company）。予約・会計・カルテ・旧POSの来店・LINEを残す側へ移す。
--  5) 新規限定のクーポンなど：LINE予約で新しいお客様ができても、同じ電話番号の別のお客様がいれば web_check に「同じ電話番号のお客様がいます（新規クーポンの対象外の可能性）」
--  6) 事業者名：companies.legal_name（規約・プライバシーポリシーの表示だけに使う。無ければ name）。
--     店舗 aaaaaaaa-…0001（ラシエル箱崎）の会社に「株式会社BE.COLLECTION.5」を入れる（すでに入っていれば変えない）
--  7) 予約の確定：public_create_booking（anon・13引数・今までどおり）→ _create_booking_impl（内部）。
--     LINE予約は service_create_booking（service_role だけ。current_user を確かめる）→ _create_booking_impl(p_line_user_id, …)。
--     本体は 0020 の public_create_booking をそのまま写して、★0022 の行だけ変えた。
-- ※必ず 0020 → 0021 の後に流すこと（無いと最初で止まります。DBは何も変わりません）。
-- ※何度流しても同じ（if not exists / create or replace / drop ... if exists）。

begin;

do $$ begin
  if to_regclass('public.line_link_requests') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name = 'web_check')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'line_links' and column_name = 'needs_confirm') then
    raise exception '0020 が流れていません。先に 0020_line_link_requests.sql → 0021_security_hardening.sql を流してから、もう一度 0022 を流してください（DBは何も変わっていません）';
  end if;
  if to_regprocedure('public.guard_customer_company()') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'hpb_settings' and column_name = 'allowed_from_domains') then
    raise exception '0021 が流れていません。先に 0021_security_hardening.sql を流してから、もう一度 0022 を流してください（DBは何も変わっていません）';
  end if;
end $$;

-- =========================================================
-- 1) 事業者名（規約・プライバシーポリシーの表示だけ）
-- =========================================================
alter table companies add column if not exists legal_name text;
comment on column companies.legal_name is '0022：規約・プライバシーポリシーに出す正式な事業者名（例 株式会社BE.COLLECTION.5）。null なら name を使う。画面の店舗一覧などは name のまま';
update companies set legal_name = '株式会社BE.COLLECTION.5'
 where id = (select company_id from stores where id = 'aaaaaaaa-0000-0000-0000-000000000001') and legal_name is null;

-- =========================================================
-- 2) つないだ経路に line_id（LINE予約＝LINEのユーザーIDが本人）を足す
-- =========================================================
alter table line_links drop constraint if exists line_links_linked_via_check;
alter table line_links add constraint line_links_linked_via_check check (linked_via is null or linked_via in ('token', 'booking_new', 'booking', 'staff_approved', 'line_id'));
comment on column line_links.linked_via is '0022：つないだ経路。line_id＝LINE予約（LINEのユーザーIDが本人・案B）／token＝会計のQR／staff_approved＝確認待ちをスタッフが承認／booking_new・booking＝0019〜0020 の間のLINE予約（0022 以降は作らない）。前回入力は line_id・token・booking_new・staff_approved';

-- =========================================================
-- 3) 0020 の C7（持ち主の確認）を外す
-- =========================================================
drop trigger if exists bookings_line_link_flag on bookings;
drop function if exists _line_link_flag_on_booking();
update line_links set needs_confirm = false, updated_at = now() where needs_confirm;
comment on column line_links.needs_confirm is '0022：使わない（常に false）。0020 の C7 で使っていた。列は互換のため残す';
-- LINE予約からの確認待ちは作らなくなったので、残っている確認待ちは期限切れにする（必要なら会計のQRでつなぐ）
update line_link_requests set status = 'expired', decided_at = now() where status = 'pending';

-- =========================================================
-- 4) 同じ電話番号のお客様（スタッフ向けのヒント。自動では何もしない）
-- =========================================================
create or replace function customers_same_phone(p_customer uuid) returns setof customers
language sql stable security definer set search_path = public, pg_temp as $$
  select o.* from customers c
  join customers o on o.company_id = c.company_id and o.id <> c.id and o.merged_into is null
  where c.id = p_customer
    and c.company_id in (select my_company_ids())
    and length(_norm_phone(c.phone)) >= 8
    and _norm_phone(o.phone) = _norm_phone(c.phone)
  order by o.created_at
  limit 10
$$;
revoke all on function customers_same_phone(uuid) from public, anon;
grant execute on function customers_same_phone(uuid) to authenticated;

-- =========================================================
-- 5) お客様の統合（手動。在籍の owner・manager・staff）
--    p_keep に残し、p_merge の予約・会計・カルテ・旧POSの来店・LINEのメッセージを移して、p_merge を「統合済み」（merged_into）にする。
--    LINE：残す側につながりが無ければ移す。両方にあれば残す側のものを残し、消える側のつながりは外す（そのLINEから次に予約すると新しいお客様になる）。
--    空の項目（フリガナ・メール・生年月日・住所など）は消える側の値で埋める。名前・電話は残す側のまま。
-- =========================================================
create or replace function merge_customers(p_keep uuid, p_merge uuid, p_store uuid default null) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  k customers; m customers; v_role text; v_store uuid; v_staff staff; n int;
  n_bookings int := 0; n_sales int := 0; n_kartes int := 0; n_hist int := 0; n_msgs int := 0;
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
          jsonb_build_object('kept_id', k.id, 'merged_id', m.id, 'bookings', n_bookings, 'sales', n_sales, 'kartes', n_kartes, 'historical_visits', n_hist, 'line_messages', n_msgs, 'line', v_line, 'role', v_role));
  return jsonb_build_object('ok', true, 'kept_id', k.id, 'merged_id', m.id, 'bookings', n_bookings, 'sales', n_sales, 'kartes', n_kartes, 'historical_visits', n_hist, 'line', v_line);
end $$;
revoke all on function merge_customers(uuid, uuid, uuid) from public, anon;
grant execute on function merge_customers(uuid, uuid, uuid) to authenticated;

-- =========================================================
-- 6) 予約の確定（0020 の public_create_booking を _create_booking_impl に写し、★0022 の行だけ変更）
-- =========================================================
create or replace function _create_booking_impl(
  p_slug text, p_menu uuid, p_start timestamptz, p_name text, p_kana text, p_phone text, p_email text,
  p_intake jsonb, p_coupon uuid, p_code text, p_staff uuid, p_lang text, p_options uuid[],
  p_line_user_id text, p_line_display_name text
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st stores; m menus; cp coupons; ln record; tz text; d date; slot record; o record;
  v_phone text; v_email text; nm text; kn text; cust customers; is_new boolean; last_visit timestamptz;
  price int; total int; blk int; tok text; bno text; grp uuid; b_id uuid; first_id uuid; i int; staff_name text; sid uuid; ppl int;
  note_text text; body text; fee int := 0; opt_ids uuid[];
  v_new_cust boolean := false;   -- ★0019：この予約でお客様を新しく作ったか
  v_check text[] := '{}';         -- ★0020（C1）：来店歴で決まる条件に合わないかもしれないもの（断らずにスタッフへ）
  v_will_create boolean;          -- ★0022：この予約でお客様を新しく作ることになるか（店全体の上限の数え方）
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
  if p_line_user_id is not null and p_line_user_id !~ '^U[0-9a-f]{32}$' then raise exception 'invalid_line_user'; end if;   -- ★0022
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

  -- ★0022：この予約でお客様を新しく作るか（LINE予約＝そのLINEにつながったお客様がいないとき／ブラウザ＝電話番号のお客様がいないとき）
  if p_line_user_id is not null then
    v_will_create := not exists (select 1 from line_links l join customers c on c.id = l.customer_id
                                  where l.store_id = st.id and l.line_user_id = p_line_user_id and c.company_id = st.company_id);
  else
    v_will_create := not exists (select 1 from customers c where c.company_id = st.company_id and c.merged_into is null and _norm_phone(c.phone) = v_phone);
  end if;

  if (select count(*) from bookings y join customers c on c.id = y.customer_id
       where y.store_id = st.id and y.channel = 'own' and y.cancel_token is not null and _norm_phone(c.phone) = v_phone and y.created_at > now() - interval '1 hour') >= 3
     or (select count(*) from bookings y join customers c on c.id = y.customer_id
       where y.store_id = st.id and y.channel = 'own' and y.cancel_token is not null and _norm_phone(c.phone) = v_phone and y.status = 'booked' and y.start_at > now()) >= 5
     -- ★0020（C2）：店全体の上限は「新しいお客様を作る予約」だけで数える（1時間20件・1日60件）。いつものお客様は止めない（★0022：LINE予約も同じ数え方）
     or (v_will_create
         and ((select count(*) from bookings y where y.store_id = st.id and y.customer_created and y.created_at > now() - interval '1 hour') >= 20
           or (select count(*) from bookings y where y.store_id = st.id and y.customer_created and y.created_at > now() - interval '1 day') >= 60))
     -- ★0022：同じ LINE からは1日5件まで
     or (p_line_user_id is not null
         and (select count(*) from bookings y join line_links l on l.store_id = y.store_id and l.customer_id = y.customer_id
               where y.store_id = st.id and l.line_user_id = p_line_user_id and y.channel = 'own' and y.cancel_token is not null and y.created_at > now() - interval '1 day') >= 5) then
    raise exception 'too_many';
  end if;

  -- ロックの中で空きを再確認（オプション込みの時間で）
  d := (p_start at time zone tz)::date;
  select * into slot from _web_slots(st.id, m.id, d, p_staff, p_coupon, opt_ids) s where s.slot_start = p_start;
  if slot.slot_start is null then raise exception 'slot_taken'; end if;

  if p_line_user_id is not null then
    -- ★0022（案B）：LINEの中の予約は LINE のユーザーIDが本人。電話番号では既存のお客様につながない
    select c2.* into cust from line_links l
      join customers c on c.id = l.customer_id
      join customers c2 on c2.id = coalesce(c.merged_into, c.id)
     where l.store_id = st.id and l.line_user_id = p_line_user_id and c2.company_id = st.company_id and c2.merged_into is null
     limit 1;
    if cust.id is null then
      insert into customers (company_id, name, kana, phone, email, source, language)
      values (st.company_id, nm, nullif(kn, ''), p_phone, v_email, 'own', coalesce(p_lang, 'ja')) returning * into cust;
      v_new_cust := true;
      insert into line_links (store_id, line_user_id, customer_id, display_name, linked_at, linked_via, needs_confirm)
      values (st.id, p_line_user_id, cust.id, left(p_line_display_name, 80), now(), 'line_id', false)
      on conflict (store_id, line_user_id) do update
        set customer_id = excluded.customer_id, display_name = coalesce(excluded.display_name, line_links.display_name),
            linked_at = now(), linked_via = 'line_id', needs_confirm = false, updated_at = now();
    end if;
    -- 同じ電話番号の別のお客様がいれば、スタッフに知らせる（統合は人が判断）
    if exists (select 1 from customers c where c.company_id = st.company_id and c.merged_into is null and c.id <> cust.id and _norm_phone(c.phone) = v_phone) then
      v_check := array_append(v_check, ('同じ電話番号のお客様がいます' ||
        case when m.target = 'new' or (p_coupon is not null and exists (select 1 from coupons c where c.id = p_coupon and c.target = 'new')) then '（新規クーポンの対象外の可能性）' else '' end)::text);
    end if;
  else
    select * into cust from customers where company_id = st.company_id and merged_into is null and _norm_phone(customers.phone) = v_phone order by created_at limit 1;
    if cust.id is null then
      insert into customers (company_id, name, kana, phone, email, source, language)
      values (st.company_id, nm, nullif(kn, ''), p_phone, v_email, 'own', coalesce(p_lang, 'ja')) returning * into cust;
      v_new_cust := true;   -- ★0019
    -- ★0020：既存のお客様の名前・フリガナ・メール・電話は、ネット予約の入力で変えない・埋めない（入力は予約の web_* に残す）
    end if;
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
  note_text := 'ネット予約 ' || bno || case when p_line_user_id is not null then '（LINE）' else '' end   -- ★0022
               || case when cp.id is not null then '／クーポン：' || cp.name else '' end
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
    'people', ppl, 'store_name', st.name, 'staff_name', staff_name, 'coupon_name', cp.name, 'deadline', _cancel_deadline(st.id, p_start))
    -- ★0022：LINE予約のときだけ（サーバが受け取る。anon には返さない）
    || case when p_line_user_id is not null then jsonb_build_object('customer_id', cust.id, 'customer_created', v_new_cust, 'line_linked', true) else '{}'::jsonb end;
end $$;
revoke all on function _create_booking_impl(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[], text, text) from public, anon, authenticated;
grant execute on function _create_booking_impl(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[], text, text) to service_role;

-- ブラウザのネット予約（anon）：今までどおりの13引数。LINE のユーザーIDは渡せない（電話番号で既存のお客様につなぐ・登録内容は変えない）
create or replace function public_create_booking(
  p_slug text, p_menu uuid, p_start timestamptz, p_name text, p_kana text, p_phone text, p_email text,
  p_intake jsonb default '[]'::jsonb, p_coupon uuid default null, p_code text default null, p_staff uuid default null, p_lang text default 'ja',
  p_options uuid[] default null
) returns jsonb
language sql volatile security definer set search_path = public, pg_temp as $$
  select _create_booking_impl(p_slug, p_menu, p_start, p_name, p_kana, p_phone, p_email, p_intake, p_coupon, p_code, p_staff, p_lang, p_options, null, null)
$$;
revoke all on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[]) from public;
grant execute on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[]) to anon, authenticated;

-- LINE予約（サーバ /api/line/book だけ。IDトークンを LINE で確かめた LINE のユーザーIDを渡す）
--  security invoker：current_user が service_role のときだけ動く（anon・authenticated には実行権限も無い）
create or replace function service_create_booking(
  p_slug text, p_menu uuid, p_start timestamptz, p_name text, p_kana text, p_phone text, p_email text,
  p_intake jsonb, p_coupon uuid, p_code text, p_staff uuid, p_lang text, p_options uuid[],
  p_line_user_id text, p_line_display_name text default null
) returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
begin
  if current_user <> 'service_role' then raise exception 'forbidden'; end if;
  if p_line_user_id is null or p_line_user_id !~ '^U[0-9a-f]{32}$' then raise exception 'invalid_line_user'; end if;
  return _create_booking_impl(p_slug, p_menu, p_start, p_name, p_kana, p_phone, p_email, coalesce(p_intake, '[]'::jsonb), p_coupon, p_code, p_staff, coalesce(p_lang, 'ja'), p_options, p_line_user_id, p_line_display_name);
end $$;
revoke all on function service_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[], text, text) from public, anon, authenticated;
grant execute on function service_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[], text, text) to service_role;

notify pgrst, 'reload schema';

commit;

-- 7) 結果
select '0022 OK：LINE予約の本人＝LINEのユーザーID（案B）。service_create_booking・_create_booking_impl・customers_same_phone・merge_customers・companies.legal_name を追加し、0020 の C7 トリガを外しました／事業者名 '
       || coalesce((select legal_name from companies where id = (select company_id from stores where id = 'aaaaaaaa-0000-0000-0000-000000000001')), '（未設定）')
       || '／LINE連携（line_id） ' || (select count(*) from line_links where linked_via = 'line_id') || '件' as result;
