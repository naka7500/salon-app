-- 総点検（2026-11-07 監査）で見つかった お金・権限 の不具合の修正 ＋ 予約台帳のメニューのチップ。
-- ※必ず 0013_tracking_mainlabel_repeat.sql の後に流すこと（0013 が無いと最初で止まります。DBは何も変わりません）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists）。
-- 0014 が未適用でもアプリは落ちない（会計は今までの保存方法、台帳のチップの選択は端末に保存）。
-- LINE連携は別の 0015_line.sql（この 0014 の後に流す）。
--
-- やること
--  1) 退職した人（staff.active=false）はデータを一切見られない・書けない（my_company_ids に active を追加）
--  2) 役割の制限をDBにも：閲覧のみ（viewer）は見るだけ。店舗・会社の設定は owner・manager だけ。
--     受付枠・部屋・目標売上も owner・manager。予約・お客様・カルテ・シフト・在庫の動きは viewer 以外
--  3) 売上（sales・sale_lines・payments）とレジ締めは画面から直接書けない。
--     会計＝create_sale()（1回の呼び出し・1トランザクション・二重にならない合言葉つき）、取消＝reverse_sale()（0007）、
--     締め＝save_register_closing()（スタッフ以上。締め後の修正は owner・manager。締め後の修正は修正履歴へ）。締め済みの明細・支払は書き換え不可
--  4) 伝票番号：店舗×日の採番表で、同時に2台で会計しても重ならない（店舗×伝票番号の重複をDBで拒否）
--  5) 消費税：経理日別売上集計と同じ計算（区分×税率ごとに内税を四捨五入・値引は技術から）でサーバが計算
--  6) スタッフ側の予約の重なり：同じ担当の重なり・部屋（ベッド）の不足を拒否（「それでも入れる」＝alert='forced' を付けたときだけ通す）
--     ネット予約と同じロックで順番に処理する（2台のiPad・ネット予約が同時でも数え間違えない）
--  7) stores.ledger_menu_ids：予約台帳の上に出すメニューのチップ（並び順）
--  8) 未ログイン（anon）からは触れない

do $$ begin
  if to_regclass('public.store_report_settings') is null or to_regclass('public.booking_history') is null then
    raise exception '0013 がまだ流れていません。先に 0013_tracking_mainlabel_repeat.sql を流してから、この 0014 を流してください';
  end if;
  if to_regprocedure('public.my_role_in_company(uuid)') is null or to_regprocedure('public.reverse_sale(uuid,text)') is null then
    raise exception '0007・0008 がまだ流れていません。0001 → … → 0013 → 0014 の順に流してください';
  end if;
end $$;

-- =========================================================
-- 1) 退職した人はデータにアクセスできない
-- =========================================================
create or replace function my_company_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select company_id from staff where auth_user_id = auth.uid() and coalesce(active, true);
$$;
revoke all on function my_company_ids() from public, anon;
grant execute on function my_company_ids() to authenticated;

-- 書ける人：viewer（閲覧のみ）以外の在籍スタッフ
create or replace function can_write_company(p_company uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(my_role_in_company(p_company) in ('owner', 'manager', 'staff'), false)
$$;
create or replace function can_write_store(p_store uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select can_write_company(company_id) from stores where id = p_store), false)
$$;
revoke all on function can_write_company(uuid) from public, anon;
revoke all on function can_write_store(uuid) from public, anon;
grant execute on function can_write_company(uuid) to authenticated;
grant execute on function can_write_store(uuid) to authenticated;

-- =========================================================
-- 2) 役割の制限（表ごとに 見る／書く を分ける）
-- =========================================================
-- 古い「for all」の方針と、この 0014 で作る方針を消してから作り直す
do $$ declare t text; begin
  foreach t in array array['companies','stores','customers','resources','shifts','products','karte_entries','bookings','channel_blocks','sales','sale_lines','payments','register_closings','inventory_moves','lanes','shift_patterns','shift_months','store_goals','notifications']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table %I enable row level security', t);
      execute format('drop policy if exists %I on %I', t || '_rw', t);
      execute format('drop policy if exists %I on %I', t || '_sel', t);
      execute format('drop policy if exists %I on %I', t || '_ins', t);
      execute format('drop policy if exists %I on %I', t || '_upd', t);
      execute format('drop policy if exists %I on %I', t || '_del', t);
    end if;
  end loop;
end $$;
-- 0001 の別名の方針
drop policy if exists karte_rw on karte_entries;
drop policy if exists blocks_rw on channel_blocks;
drop policy if exists closings_rw on register_closings;
drop policy if exists inv_rw on inventory_moves;

-- 会社：見る＝所属、変える＝owner・manager（作る・消すは画面からはしない）
create policy companies_sel on companies for select using (id in (select my_company_ids()));
create policy companies_upd on companies for update using (is_company_admin(id)) with check (is_company_admin(id));
-- 店舗：見る＝所属、変える＝owner・manager（通知先メール・ネット予約のオン/オフ・部屋数など）
create policy stores_sel on stores for select using (company_id in (select my_company_ids()));
create policy stores_upd on stores for update using (is_company_admin(company_id)) with check (is_company_admin(company_id));
-- お客様：viewer 以外が書ける
create policy customers_sel on customers for select using (company_id in (select my_company_ids()));
create policy customers_ins on customers for insert with check (can_write_company(company_id));
create policy customers_upd on customers for update using (can_write_company(company_id)) with check (can_write_company(company_id));
create policy customers_del on customers for delete using (can_write_company(company_id));

-- 店舗の表：見る＝所属。書く＝ viewer 以外（予約・カルテ・シフト・在庫・通知の既読）／owner・manager（受付枠・部屋・目標売上）
do $$ declare t text; w text; begin
  for t, w in select * from (values
    ('bookings','staff'), ('channel_blocks','staff'), ('karte_entries','staff'), ('shifts','staff'), ('shift_patterns','staff'), ('shift_months','staff'),
    ('inventory_moves','staff'), ('products','staff'), ('notifications','staff'),
    ('resources','admin'), ('lanes','admin'), ('store_goals','admin')) v(t, w)
  loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('create policy %I on %I for select using (store_id in (select id from stores where company_id in (select my_company_ids())))', t || '_sel', t);
    if w = 'staff' then
      execute format('create policy %I on %I for insert with check (can_write_store(store_id))', t || '_ins', t);
      execute format('create policy %I on %I for update using (can_write_store(store_id)) with check (can_write_store(store_id))', t || '_upd', t);
      execute format('create policy %I on %I for delete using (can_write_store(store_id))', t || '_del', t);
    else
      execute format('create policy %I on %I for insert with check (is_store_admin(store_id))', t || '_ins', t);
      execute format('create policy %I on %I for update using (is_store_admin(store_id)) with check (is_store_admin(store_id))', t || '_upd', t);
      execute format('create policy %I on %I for delete using (is_store_admin(store_id))', t || '_del', t);
    end if;
  end loop;
end $$;

-- =========================================================
-- 3) 売上・レジ締め：見るだけ（書くのは関数だけ）
-- =========================================================
create policy sales_sel on sales for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy sale_lines_sel on sale_lines for select using (sale_id in (select id from sales where store_id in (select id from stores where company_id in (select my_company_ids()))));
create policy payments_sel on payments for select using (sale_id in (select id from sales where store_id in (select id from stores where company_id in (select my_company_ids()))));
create policy register_closings_sel on register_closings for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
revoke insert, update, delete, truncate on sales, sale_lines, payments, register_closings from authenticated;
grant select on sales, sale_lines, payments, register_closings to authenticated;

-- 締め済みの伝票の明細・支払は書き換え・削除できない（関数の中で app.sale_edit=on のときだけ）
create or replace function guard_closed_sale_children() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('app.sale_edit', true), '') <> 'on'
     and exists (select 1 from sales s where s.id = old.sale_id and s.closed_on is not null) then
    raise exception 'closed_sale_locked';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists t_sale_lines_guard_closed on sale_lines;
create trigger t_sale_lines_guard_closed before update or delete on sale_lines for each row execute function guard_closed_sale_children();
drop trigger if exists t_payments_guard_closed on payments;
create trigger t_payments_guard_closed before update or delete on payments for each row execute function guard_closed_sale_children();

-- =========================================================
-- 4) 伝票番号（店舗×日の採番表）
-- =========================================================
create table if not exists sale_counters (
  store_id uuid not null references stores(id) on delete cascade,
  day date not null,
  n int not null,
  primary key (store_id, day)
);
alter table sale_counters enable row level security;
revoke all on sale_counters from anon, authenticated;

create or replace function next_sale_no(p_store uuid) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare d date := (now() at time zone 'Asia/Tokyo')::date; v int; no text;
begin
  insert into sale_counters (store_id, day, n)
  values (p_store, d, (select count(*) from sales where store_id = p_store and (sold_at at time zone 'Asia/Tokyo')::date = d) + 1)
  on conflict (store_id, day) do update set n = sale_counters.n + 1
  returning n into v;
  no := to_char(d, 'YYYYMMDD') || '-' || lpad(v::text, 3, '0');
  while exists (select 1 from sales where store_id = p_store and sale_no = no) loop     -- 古い番号と重なったら飛ばす
    update sale_counters set n = n + 1 where store_id = p_store and day = d returning n into v;
    no := to_char(d, 'YYYYMMDD') || '-' || lpad(v::text, 3, '0');
  end loop;
  return no;
end $$;
revoke all on function next_sale_no(uuid) from public, anon, authenticated;

-- 店舗×伝票番号の重複を拒否（すでに重複がある古いデータなら、作らずに知らせる）
do $$ begin
  if to_regclass('public.sales_store_sale_no_key') is null then
    if exists (select 1 from sales group by store_id, sale_no having count(*) > 1) then
      raise notice '伝票番号の重複が既にあるため、重複チェックの索引は作りませんでした（古い伝票の番号を確認してください）';
    else
      create unique index sales_store_sale_no_key on sales (store_id, sale_no);
    end if;
  end if;
end $$;

-- 会計1回ぶんの合言葉（同じ合言葉の会計は1枚だけ）
alter table sales add column if not exists client_key uuid;
create unique index if not exists sales_client_key_key on sales (client_key) where client_key is not null;

-- =========================================================
-- 5) 会計：create_sale（1トランザクション・サーバで入力チェックと消費税の計算）
-- =========================================================
create or replace function create_sale(p_store uuid, p_input jsonb, p_client_key uuid) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  st stores; me staff; bk bookings; v_id uuid; x jsonb; g record;
  v_sub bigint := 0; v_disc bigint; v_total bigint; v_paid bigint := 0; v_noncash bigint := 0; v_tax bigint := 0;
  v_left bigint; v_take bigint; v_gross bigint; v_rate numeric; v_no text; v_pid uuid; v_mid uuid; v_lane uuid;
begin
  if p_client_key is null then raise exception 'client_key_required'; end if;
  -- 同じ合言葉はここで順番待ち → 先に保存した伝票を返す（二度押し・通信のやり直しでも1枚）
  perform pg_advisory_xact_lock(hashtext('create_sale:' || p_client_key::text));
  select id into v_id from sales where client_key = p_client_key;
  if v_id is not null then return v_id; end if;

  select * into st from stores where id = p_store;
  if st.id is null then raise exception 'store_not_found'; end if;
  select s.* into me from staff s where s.company_id = st.company_id and s.auth_user_id = auth.uid() and coalesce(s.active, true)
   order by case s.role when 'owner' then 0 when 'manager' then 1 when 'staff' then 2 else 3 end limit 1;
  if me.id is null or me.role = 'viewer' then raise exception 'forbidden'; end if;

  -- 明細
  if jsonb_typeof(p_input -> 'lines') is distinct from 'array' or jsonb_array_length(p_input -> 'lines') = 0 then raise exception 'no_lines'; end if;
  if jsonb_array_length(p_input -> 'lines') > 100 then raise exception 'invalid_line'; end if;
  for x in select * from jsonb_array_elements(p_input -> 'lines') loop
    if coalesce(x ->> 'kind', '') not in ('menu', 'product', 'option', 'fee') then raise exception 'invalid_line'; end if;
    if coalesce(x ->> 'qty', '') !~ '^[0-9]{1,3}$' or (x ->> 'qty')::int < 1 then raise exception 'invalid_qty'; end if;
    if coalesce(x ->> 'unit_price', '') !~ '^[0-9]{1,8}$' then raise exception 'invalid_line'; end if;
    if length(btrim(coalesce(x ->> 'name', ''))) not between 1 and 200 then raise exception 'invalid_line'; end if;
    v_rate := coalesce(nullif(x ->> 'tax_rate', '')::numeric, 0.1); if v_rate > 1 then v_rate := v_rate / 100; end if;
    if v_rate < 0 or v_rate > 0.2 then raise exception 'invalid_line'; end if;
    if nullif(x ->> 'menu_id', '') is not null and not exists (select 1 from menus where id = (x ->> 'menu_id')::uuid and store_id = st.id) then raise exception 'menu_store_mismatch'; end if;
    if nullif(x ->> 'product_id', '') is not null and not exists (select 1 from products where id = (x ->> 'product_id')::uuid and store_id = st.id) then raise exception 'product_store_mismatch'; end if;
    v_sub := v_sub + (x ->> 'unit_price')::bigint * (x ->> 'qty')::int;
  end loop;
  if coalesce(p_input ->> 'discount', '0') !~ '^[0-9]{1,8}$' then raise exception 'invalid_discount'; end if;
  v_disc := coalesce((p_input ->> 'discount')::bigint, 0);
  if v_disc > v_sub then raise exception 'invalid_discount'; end if;
  v_total := v_sub - v_disc;

  -- 支払（現金以外は合計まで。お釣りが出るのは現金だけ）
  if jsonb_typeof(coalesce(p_input -> 'payments', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_input -> 'payments', '[]'::jsonb)) > 10 then raise exception 'invalid_payment'; end if;
  for x in select * from jsonb_array_elements(coalesce(p_input -> 'payments', '[]'::jsonb)) loop
    if coalesce(x ->> 'method', '') not in ('cash', 'card', 'emoney', 'qr', 'gift', 'voucher', 'ota_prepaid', 'other') then raise exception 'invalid_payment'; end if;
    if coalesce(x ->> 'amount', '') !~ '^[0-9]{1,8}$' then raise exception 'invalid_payment'; end if;
    v_paid := v_paid + (x ->> 'amount')::bigint;
    if x ->> 'method' <> 'cash' then v_noncash := v_noncash + (x ->> 'amount')::bigint; end if;
  end loop;
  if v_noncash > v_total then raise exception 'noncash_over_total'; end if;
  if v_paid < v_total then raise exception 'paid_short'; end if;

  -- 予約（この店舗の予約・まだ会計していない）
  if nullif(p_input ->> 'booking_id', '') is not null then
    select * into bk from bookings where id = (p_input ->> 'booking_id')::uuid for update;
    if bk.id is null or bk.store_id <> st.id then raise exception 'booking_store_mismatch'; end if;
    if bk.status = 'done' then raise exception 'booking_already_paid'; end if;
  end if;
  if nullif(p_input ->> 'customer_id', '') is not null and not exists (select 1 from customers where id = (p_input ->> 'customer_id')::uuid and company_id = st.company_id) then raise exception 'customer_company_mismatch'; end if;
  if nullif(p_input ->> 'main_staff_id', '') is not null and not exists (select 1 from staff where id = (p_input ->> 'main_staff_id')::uuid and company_id = st.company_id) then raise exception 'main_staff_company'; end if;
  if nullif(p_input ->> 'coupon_id', '') is not null and not exists (select 1 from coupons where id = (p_input ->> 'coupon_id')::uuid and store_id = st.id) then raise exception 'coupon_store_mismatch'; end if;
  v_lane := case when nullif(p_input ->> 'main_staff_id', '') is null then nullif(p_input ->> 'main_lane_id', '')::uuid else null end;

  -- 消費税（経理日別売上集計と同じ：区分×税率ごとに内税を四捨五入。値引は技術（税率の高い順）→店販）
  v_left := v_disc;
  for g in
    select * from (
      select case when e ->> 'kind' = 'product' then 'product' else 'tech' end as cat,
             (case when coalesce(nullif(e ->> 'tax_rate', '')::numeric, 0.1) > 1 then coalesce(nullif(e ->> 'tax_rate', '')::numeric, 0.1) / 100 else coalesce(nullif(e ->> 'tax_rate', '')::numeric, 0.1) end) as rate,
             sum((e ->> 'unit_price')::bigint * (e ->> 'qty')::int) as gross
        from jsonb_array_elements(p_input -> 'lines') e group by 1, 2) q
     order by (q.cat = 'tech') desc, q.rate desc
  loop
    v_take := least(greatest(g.gross, 0), v_left); v_left := v_left - v_take; v_gross := g.gross - v_take;
    if g.rate > 0 and v_gross <> 0 then v_tax := v_tax + sign(v_gross) * floor(abs(v_gross) * g.rate / (1 + g.rate) + 0.5); end if;
  end loop;

  v_no := next_sale_no(st.id);
  insert into sales (store_id, booking_id, customer_id, main_staff_id, main_label, main_lane_id, sale_no, status, subtotal, discount, tax, total, discount_reason, coupon_id, note, created_by, client_key)
  values (st.id, bk.id, nullif(p_input ->> 'customer_id', '')::uuid, nullif(p_input ->> 'main_staff_id', '')::uuid,
          case when nullif(p_input ->> 'main_staff_id', '') is null then left(nullif(btrim(p_input ->> 'main_label'), ''), 60) else null end, v_lane,
          v_no, 'confirmed', v_sub, v_disc, v_tax, v_total, left(nullif(p_input ->> 'discount_reason', ''), 200), nullif(p_input ->> 'coupon_id', '')::uuid,
          left(nullif(p_input ->> 'note', ''), 1000), me.id, p_client_key)
  returning id into v_id;
  insert into sale_lines (sale_id, kind, menu_id, product_id, name, unit_price, qty, tax_rate, staff_id, amount)
  select v_id, e ->> 'kind', nullif(e ->> 'menu_id', '')::uuid, nullif(e ->> 'product_id', '')::uuid, left(btrim(e ->> 'name'), 200),
         (e ->> 'unit_price')::int, (e ->> 'qty')::int,
         case when coalesce(nullif(e ->> 'tax_rate', '')::numeric, 0.1) > 1 then coalesce(nullif(e ->> 'tax_rate', '')::numeric, 0.1) / 100 else coalesce(nullif(e ->> 'tax_rate', '')::numeric, 0.1) end,
         nullif(e ->> 'staff_id', '')::uuid, (e ->> 'unit_price')::int * (e ->> 'qty')::int
    from jsonb_array_elements(p_input -> 'lines') e;
  insert into payments (sale_id, method, amount)
  select v_id, e ->> 'method', (e ->> 'amount')::int from jsonb_array_elements(coalesce(p_input -> 'payments', '[]'::jsonb)) e where (e ->> 'amount')::int <> 0;

  -- 予約を「会計済」に（ペアを1枚にまとめたときは相手も）
  if bk.id is not null then
    update bookings set status = 'done' where id = bk.id;
    if bk.pair_group is not null and jsonb_typeof(p_input -> 'partner_booking_ids') = 'array' then
      update bookings set status = 'done'
       where store_id = st.id and pair_group = bk.pair_group and status not in ('cancelled', 'done')
         and id in (select (v #>> '{}')::uuid from jsonb_array_elements(p_input -> 'partner_booking_ids') v);
    end if;
  end if;
  return v_id;
end $$;
revoke all on function create_sale(uuid, jsonb, uuid) from public, anon;
grant execute on function create_sale(uuid, jsonb, uuid) to authenticated;

-- =========================================================
-- 5b) レジ締め：スタッフ以上（締めた後の修正は owner・manager だけ）。あるべき現金はサーバで計算。締めたらその日の伝票をロック。締め後の修正は修正履歴へ
-- =========================================================
create or replace function save_register_closing(p_store uuid, p_date date, p_opening int, p_counted int, p_note text, p_lock boolean) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare st stores; me staff; old register_closings; r register_closings; tz text; v_cash bigint;
begin
  select * into st from stores where id = p_store;
  if st.id is null then raise exception 'store_not_found'; end if;
  select s.* into me from staff s where s.company_id = st.company_id and s.auth_user_id = auth.uid() and coalesce(s.active, true)
   order by case s.role when 'owner' then 0 when 'manager' then 1 else 2 end limit 1;
  -- 締めはスタッフもできる（増美さん 2026-11-07：レジ締めはスタッフがしている）。締めた後の修正だけ owner・manager
  if me.id is null or me.role not in ('owner', 'manager', 'staff') then raise exception 'forbidden'; end if;
  if p_date is null or coalesce(p_opening, 0) < 0 or coalesce(p_opening, 0) > 10000000 or (p_counted is not null and (p_counted < 0 or p_counted > 100000000)) then raise exception 'invalid_input'; end if;
  tz := coalesce(st.timezone, 'Asia/Tokyo');
  perform pg_advisory_xact_lock(hashtext('closing:' || p_store::text || p_date::text));
  -- 現金売上（お釣りを引いた額。赤伝はマイナス）：画面（lib/money.ts netPayments）と同じ
  select coalesce(sum(case when c.has_cash then c.cash - c.sgn * greatest(0, c.sgn * (c.paid - c.total)) else 0 end), 0) into v_cash
    from (select s.id, s.total, case when s.total < 0 then -1 else 1 end as sgn,
                 coalesce(sum(p.amount) filter (where p.method = 'cash'), 0) as cash, coalesce(bool_or(p.method = 'cash'), false) as has_cash, coalesce(sum(p.amount), 0) as paid
            from sales s left join payments p on p.sale_id = s.id
           where s.store_id = st.id and (s.sold_at at time zone tz)::date = p_date group by s.id, s.total) c;
  select * into old from register_closings where store_id = st.id and date = p_date;
  if old.closed_at is not null and me.role not in ('owner', 'manager') then raise exception 'closed_owner_only'; end if;
  insert into register_closings (store_id, date, opening_float, counted_cash, expected_cash, difference, closed_by, closed_at, note)
  values (st.id, p_date, coalesce(p_opening, 0), p_counted, coalesce(p_opening, 0) + v_cash,
          case when p_counted is null then null else p_counted - (coalesce(p_opening, 0) + v_cash) end,
          case when p_lock then me.id else null end, case when p_lock then now() else null end, left(p_note, 1000))
  on conflict (store_id, date) do update set
    opening_float = excluded.opening_float, counted_cash = excluded.counted_cash, expected_cash = excluded.expected_cash, difference = excluded.difference,
    note = excluded.note,
    closed_at = coalesce(register_closings.closed_at, excluded.closed_at), closed_by = coalesce(register_closings.closed_by, excluded.closed_by)
  returning * into r;
  if old.closed_at is not null then
    insert into audit_logs (actor, actor_staff_id, actor_name, store_id, table_name, row_id, action, reason, before, after)
    values (auth.uid(), me.id, me.name, st.id, 'register_closings', r.id::text, 'closing_edit_after_close', null, to_jsonb(old), to_jsonb(r));
  end if;
  if p_lock then
    update sales set closed_on = p_date where store_id = st.id and (sold_at at time zone tz)::date = p_date and closed_on is null;
  end if;
  return to_jsonb(r);
end $$;
revoke all on function save_register_closing(uuid, date, int, int, text, boolean) from public, anon;
grant execute on function save_register_closing(uuid, date, int, int, text, boolean) to authenticated;

-- =========================================================
-- 6) スタッフ側の予約の重なり（ログイン中のスタッフの操作だけ。HPB取り込み＝サービスキー・ネット予約は今までどおり）
-- =========================================================
-- 予約の印に 'forced'（重なり・部屋不足を承知で入れた）を足す
alter table bookings drop constraint if exists bookings_alert_check;
alter table bookings add constraint bookings_alert_check check (alert is null or alert in ('double_booking', 'forced'));

create or replace function guard_booking_overlap() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_role text; v_claims text; rooms int; n int;
begin
  if new.status not in ('booked', 'arrived') then return null; end if;
  if coalesce(new.alert, '') = 'forced' then return null; end if;                       -- 「それでも入れる」
  if tg_op = 'UPDATE' and old.start_at = new.start_at and old.end_at = new.end_at and old.staff_id is not distinct from new.staff_id
     and old.status = new.status then return null; end if;                              -- 時間・担当・状態が変わらない更新は見ない
  v_claims := nullif(current_setting('request.jwt.claims', true), '');
  v_role := coalesce(case when v_claims is not null then v_claims::jsonb ->> 'role' end, '');
  if v_role <> 'authenticated' then return null; end if;
  perform pg_advisory_xact_lock(hashtext('web_booking:' || new.store_id::text));      -- ネット予約と同じロック
  if new.staff_id is not null and exists (
       select 1 from bookings y
        where y.store_id = new.store_id and y.id <> new.id and y.staff_id = new.staff_id
          and y.start_at < new.end_at and y.end_at > new.start_at
          and (new.pair_group is null or y.pair_group is distinct from new.pair_group)
          and ((y.status in ('booked', 'arrived', 'done')) or (y.status = 'block' and coalesce(y.block_kind, 'close') in ('break', 'close', 'guarantee')))) then
    raise exception 'staff_overlap';
  end if;
  if new.status <> 'block' then
    select room_count into rooms from stores where id = new.store_id;
    if rooms is not null then
      select count(*) into n from bookings y
       where y.store_id = new.store_id and y.status in ('booked', 'arrived') and y.start_at < new.end_at and y.end_at > new.start_at;
      if n > rooms then raise exception 'rooms_full'; end if;
    end if;
  end if;
  return null;
end $$;
revoke all on function guard_booking_overlap() from public, anon;
drop trigger if exists t_bookings_overlap on bookings;
create trigger t_bookings_overlap after insert or update of start_at, end_at, staff_id, status on bookings for each row execute function guard_booking_overlap();

-- =========================================================
-- 7) 予約台帳の上に出すメニューのチップ（null＝既定：ネット掲載の技術メニュー先頭8件）
-- =========================================================
alter table stores add column if not exists ledger_menu_ids uuid[];
alter table stores drop constraint if exists stores_ledger_menu_ids_check;
alter table stores add constraint stores_ledger_menu_ids_check check (ledger_menu_ids is null or cardinality(ledger_menu_ids) <= 24);

-- 未ログイン（anon）からは表を一切触れないように（新しい表にも付け直す）
revoke all on all tables in schema public from anon;

notify pgrst, 'reload schema';

select '0014 OK：退職者の遮断・役割の制限・会計を1回の保存に・伝票番号の重複防止・消費税の統一・予約の重なりチェック・台帳のチップを用意しました' as result,
       (select count(*) from staff where not coalesce(active, true)) as inactive_staff,
       (select count(*) from sales where client_key is not null) as sales_with_key;
