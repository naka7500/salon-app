-- テスト店舗（練習用）：使い勝手・集計の確認用。本番の店舗とは会社ごと分けてあるので、データは混ざらない。
-- 何度流しても同じ状態に作り直せる（テスト会社のデータを消してから入れ直す）。
do $$
declare
  c_id uuid := '33333333-3333-3333-3333-333333333333';
  s_id uuid := 'aaaaaaaa-0000-0000-0000-000000000099';
  l_id uuid; st uuid[]; menus_ids uuid[]; m record; cust uuid[];
  d date; t timestamptz; n int; i int; b_id uuid; v_sale uuid; k int; pm text; owner_uid uuid;
begin
  perform setseed(0.42);
  -- 作り直し（テスト会社の分だけ）
  delete from payments where sale_id in (select id from sales where store_id = s_id);
  delete from inventory_moves where store_id = s_id;
  delete from sale_lines where sale_id in (select id from sales where store_id = s_id);
  delete from sales where store_id = s_id;
  delete from booking_history where booking_id in (select id from bookings where store_id = s_id);
  delete from bookings where store_id = s_id;
  delete from register_closings where store_id = s_id;
  delete from karte_entries where store_id = s_id;
  delete from customers where company_id = c_id;
  delete from lanes where store_id = s_id; delete from resources where store_id = s_id;
  delete from menus where store_id = s_id; delete from products where store_id = s_id;
  delete from staff_stores where store_id = s_id;
  delete from shifts where store_id = s_id; delete from shift_months where store_id = s_id;   -- 0005 適用後

  insert into companies (id, name) values (c_id, 'テスト会社（練習用）') on conflict (id) do nothing;
  insert into stores (id, company_id, name, business_type, open_time, close_time, slot_minutes)
    values (s_id, c_id, 'テスト店舗（練習用）', 'eyelash', '10:00', '19:00', 15) on conflict (id) do nothing;

  -- スタッフ：練習用2名＋テスト用ログイン＋増美さん
  insert into staff (id, company_id, name, role) values
    ('bbbbbbbb-0000-0000-0000-000000000901', c_id, '練習A', 'manager'),
    ('bbbbbbbb-0000-0000-0000-000000000902', c_id, '練習B', 'staff')
  on conflict (id) do nothing;
  insert into staff (id, company_id, name, role, email) values
    ('bbbbbbbb-0000-0000-0000-000000000903', c_id, 'テスト担当', 'manager', 'pos-test@example.com')
  on conflict (id) do nothing;
  select auth_user_id into owner_uid from staff where id = 'bbbbbbbb-0000-0000-0000-000000000090';
  insert into staff (id, company_id, name, role, email, auth_user_id) values
    ('bbbbbbbb-0000-0000-0000-000000000990', c_id, '中嶋', 'owner', 'kokage.corp@gmail.com', owner_uid)
  on conflict (id) do update set auth_user_id = excluded.auth_user_id;
  insert into staff_stores values
    ('bbbbbbbb-0000-0000-0000-000000000901', s_id), ('bbbbbbbb-0000-0000-0000-000000000902', s_id);

  insert into resources (store_id, name, kind, sort_order) values (s_id, 'ベッド1', 'bed', 1), (s_id, 'ベッド2', 'bed', 2);
  insert into lanes (store_id, name, capacity, sort_order) values (s_id, 'ネット予約枠', 1, 1) returning id into l_id;
  -- 勤務パターン（0005）と先月分のシフト（「先月をコピー」の練習用。火曜は店休、練習Bは水・土休み）
  perform ensure_default_shift_patterns(s_id);
  insert into shifts (store_id, staff_id, date, kind, pattern_id, start_time, end_time, is_store_closed)
  select s_id, sx.id, g.dd::date, p.kind, p.id, p.start_time, p.end_time, p.kind = 'closed'
  from generate_series(date_trunc('month', current_date) - interval '1 month', date_trunc('month', current_date) - interval '1 day', interval '1 day') g(dd)
  cross join (values ('bbbbbbbb-0000-0000-0000-000000000901'::uuid, 1), ('bbbbbbbb-0000-0000-0000-000000000902'::uuid, 2)) sx(id, k)
  join shift_patterns p on p.store_id = s_id and p.active and p.name = case
       when extract(dow from g.dd) = 2 then '店休'
       when sx.k = 2 and extract(dow from g.dd) in (3, 6) then '休'
       when sx.k = 2 then '遅番' else '通し' end;

  insert into menus (store_id, name, short_name, color, category, price, duration_min, interval_min, sort_order) values
    (s_id, 'まつ毛パーマ', 'パーマ', '#d9a441', 'technical', 6600, 60, 10, 1),
    (s_id, 'マツエク 100本', '100本', '#e07a9a', 'technical', 7700, 75, 10, 2),
    (s_id, 'マツエク 120本', '120本', '#c8559a', 'technical', 8800, 90, 10, 3),
    (s_id, 'パリジェンヌラッシュリフト', 'パリ', '#7a9cd9', 'technical', 7700, 60, 10, 4),
    (s_id, '眉Wax', '眉', '#8cc084', 'technical', 4400, 30, 5, 5),
    (s_id, 'コーティング', 'コート', '#bbbbbb', 'option', 1100, 5, 0, 20);
  insert into products (store_id, name, price, cost, stock, reorder_point) values
    (s_id, 'まつ毛美容液', 3300, 1500, 30, 3), (s_id, 'アイシャンプー', 1980, 800, 30, 2);

  select array_agg(id) into st from staff where id in ('bbbbbbbb-0000-0000-0000-000000000901','bbbbbbbb-0000-0000-0000-000000000902');

  -- お客様40名（架空）
  for i in 1..40 loop
    insert into customers (company_id, name, kana, phone, source)
    values (c_id, 'テスト客' || lpad(i::text, 2, '0'), 'てすときゃく' || i, '090-0000-' || lpad(i::text, 4, '0'),
            (array['HPB','Instagram','紹介','LINE'])[1 + floor(random()*4)::int]);
  end loop;
  select array_agg(id) into cust from customers where company_id = c_id;

  -- 過去60日：会計まで済んだ予約（火曜定休）。未来14日：予約のみ
  for d in select generate_series(current_date - 60, current_date + 14, interval '1 day')::date loop
    continue when extract(dow from d) = 2;
    n := 2 + floor(random()*4)::int;
    for i in 1..n loop
      select * into m from menus where store_id = s_id and category = 'technical' order by random() limit 1;
      t := (d::text || ' ' || (10 + (i-1)*2)::text || ':00:00+09')::timestamptz;
      insert into bookings (store_id, customer_id, staff_id, lane_id, start_at, end_at, status, channel, menu_ids)
      values (s_id, cust[1 + floor(random()*40)::int], st[1 + floor(random()*2)::int], l_id,
              t, t + make_interval(mins => m.duration_min), case when d < current_date then 'done' else 'booked' end,
              (array['hpb','hpb','own','phone','line'])[1 + floor(random()*5)::int], array[m.id])
      returning id into b_id;
      if d < current_date then
        k := m.price; pm := (array['cash','card','card','qr'])[1 + floor(random()*4)::int];
        insert into sales (store_id, booking_id, customer_id, main_staff_id, sale_no, sold_at, subtotal, discount, tax, total)
          select s_id, b.id, b.customer_id, b.staff_id, to_char(d, 'YYYYMMDD') || '-' || lpad(i::text, 3, '0'), b.end_at, k, 0, floor(k - k/1.1), k
          from bookings b where b.id = b_id returning id into v_sale;
        insert into sale_lines (sale_id, kind, menu_id, name, unit_price, qty, staff_id, amount)
          select v_sale, 'menu', m.id, m.name, m.price, 1, b.staff_id, m.price from bookings b where b.id = b_id;
        insert into payments (sale_id, method, amount) values (v_sale, pm, k);
      end if;
    end loop;
  end loop;
end $$;
