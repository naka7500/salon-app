-- 箱崎（BE.COLLECTION.5）初期データ。価格・時間は仮。本番前に増美さんが確認する。
insert into companies (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'BE.COLLECTION.5'),
  ('22222222-2222-2222-2222-222222222222', '株式会社KOKAGE');

insert into stores (id, company_id, name, business_type, open_time, close_time, slot_minutes, hpb_salon_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'ラシエル箱崎', 'eyelash', '10:00', '19:00', 15, 'H000805291');

insert into staff (id, company_id, name, role) values
  ('bbbbbbbb-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', '飯田', 'manager'),
  ('bbbbbbbb-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'スタッフ2', 'staff');
insert into staff_stores values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001');

insert into resources (store_id, name, kind, sort_order) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ベッド1', 'bed', 1),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ベッド2', 'bed', 2);

insert into menus (store_id, name, category, price, duration_min, interval_min, sort_order) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'まつ毛パーマ', 'technical', 6600, 60, 10, 1),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'マツエク 100本', 'technical', 7700, 75, 10, 2),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'マツエク 120本', 'technical', 8800, 90, 10, 3),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'パリジェンヌラッシュリフト', 'technical', 7700, 60, 10, 4),
  ('aaaaaaaa-0000-0000-0000-000000000001', '眉Wax', 'technical', 4400, 30, 5, 5),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'まつ毛パーマ＋眉Wax', 'technical', 9900, 90, 10, 6),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'コーティング', 'option', 1100, 5, 0, 20),
  ('aaaaaaaa-0000-0000-0000-000000000001', '予約割引（次回予約）', 'option', -500, 0, 0, 30);

insert into products (store_id, name, price, cost, stock, reorder_point) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'まつ毛美容液', 3300, 1500, 10, 3),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'コーティング剤（ホームケア）', 2200, 900, 8, 3),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'アイシャンプー', 1980, 800, 6, 2);

-- 受付枠（ネット予約の受け皿）
insert into lanes (store_id, name, capacity, sort_order) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'ネット予約枠', 1, 1);
