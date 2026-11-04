-- KOKAGE西五反田 初期データ（価格・時間は仮。本番前に増美さんが確認する）
insert into stores (id, company_id, name, business_type, open_time, close_time, slot_minutes, hpb_salon_id) values
  ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'KOKAGE西五反田', 'headspa', '10:00', '19:00', 15, 'H000719142')
on conflict (id) do nothing;

insert into staff (id, company_id, name, role) values
  ('bbbbbbbb-0000-0000-0000-000000000011', '22222222-2222-2222-2222-222222222222', '菊池', 'manager'),
  ('bbbbbbbb-0000-0000-0000-000000000012', '22222222-2222-2222-2222-222222222222', '富塚', 'staff')
on conflict (id) do nothing;
insert into staff_stores values
  ('bbbbbbbb-0000-0000-0000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000002'),
  ('bbbbbbbb-0000-0000-0000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000002')
on conflict do nothing;

insert into resources (store_id, name, kind, sort_order) values
  ('aaaaaaaa-0000-0000-0000-000000000002', '個室1', 'room', 1),
  ('aaaaaaaa-0000-0000-0000-000000000002', '個室2', 'room', 2),
  ('aaaaaaaa-0000-0000-0000-000000000002', '個室3', 'room', 3);

insert into lanes (store_id, name, capacity, sort_order) values
  ('aaaaaaaa-0000-0000-0000-000000000002', '1名様でのご予約', 1, 1),
  ('aaaaaaaa-0000-0000-0000-000000000002', '2名様でのご予約（ペア予約）', 2, 2);

insert into menus (store_id, name, short_name, color, category, price, duration_min, interval_min, sort_order) values
  ('aaaaaaaa-0000-0000-0000-000000000002', '90分サブリミックヘッドスパ', '90分サブ', '#e8547a', 'technical', 13200, 90, 0, 1),
  ('aaaaaaaa-0000-0000-0000-000000000002', '90分リラクゼーションヘッドスパ', '90分リラ', '#b57edc', 'technical', 13200, 90, 0, 2),
  ('aaaaaaaa-0000-0000-0000-000000000002', '90分育毛ヘッドスパ', '90分育毛', '#2bb3a3', 'technical', 14300, 90, 0, 3),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'クイックヘッドスパ 60分', 'クイック', '#c5d94b', 'technical', 9900, 60, 0, 4),
  ('aaaaaaaa-0000-0000-0000-000000000002', '平日90分ヘッドスパ', '平日90分', '#d9534f', 'technical', 11000, 90, 0, 5),
  ('aaaaaaaa-0000-0000-0000-000000000002', 'ヘッドスキンケア追加', 'スキンケア', '#bbbbbb', 'option', 3300, 15, 0, 20);

insert into products (store_id, name, price, cost, stock, reorder_point) values
  ('aaaaaaaa-0000-0000-0000-000000000002', 'スカルプシャンプー', 4400, 1800, 6, 2),
  ('aaaaaaaa-0000-0000-0000-000000000002', '育毛エッセンス', 6600, 2800, 4, 2);

-- 箱崎のメニューにも略名・色を入れる
update menus set short_name='パーマ', color='#d9a441' where store_id='aaaaaaaa-0000-0000-0000-000000000001' and name='まつ毛パーマ';
update menus set short_name='100本', color='#e07a9a' where store_id='aaaaaaaa-0000-0000-0000-000000000001' and name='マツエク 100本';
update menus set short_name='120本', color='#c8559a' where store_id='aaaaaaaa-0000-0000-0000-000000000001' and name='マツエク 120本';
update menus set short_name='パリ', color='#7a9cd9' where store_id='aaaaaaaa-0000-0000-0000-000000000001' and name='パリジェンヌラッシュリフト';
update menus set short_name='眉', color='#8cc084' where store_id='aaaaaaaa-0000-0000-0000-000000000001' and name='眉Wax';
update menus set short_name='パーマ+眉', color='#d98c5f' where store_id='aaaaaaaa-0000-0000-0000-000000000001' and name='まつ毛パーマ＋眉Wax';

-- 管理者（増美さん）：両社に所属させる。auth_user_id はログインユーザー作成後に 0003 で紐づける
insert into staff (id, company_id, name, role) values
  ('bbbbbbbb-0000-0000-0000-000000000090', '22222222-2222-2222-2222-222222222222', '中嶋', 'owner'),
  ('bbbbbbbb-0000-0000-0000-000000000091', '11111111-1111-1111-1111-111111111111', '中嶋', 'owner')
on conflict (id) do nothing;
