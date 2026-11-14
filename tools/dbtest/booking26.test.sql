-- 0026（ネット予約の受け方：LINEの中だけ／両方、LINEの予約完了のお知らせ）の DB テスト。ローカルの PostgreSQL 専用（tools/dbtest/run.sh から呼ぶ）。
-- 土台は tools/dbtest/pre26.sql（0026 の前に入れた2店舗：箱崎テスト＝箱崎と同じID／両方テスト）。
-- 「未ログインのブラウザ（anon）」「サーバ（service_role）」「ログイン中のスタッフ」をまねて実行する。1つでも期待と違えば ERROR で止まる。
\set QUIET 1
set client_min_messages = notice;
\o /dev/null

create schema t26;
grant usage on schema t26 to authenticated, anon, service_role;
create function t26.throws(p_sql text, p_pattern text, p_label text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlerrm ~* p_pattern then raise notice 'ok - %', p_label; return; end if;
    raise exception 'TEST FAILED（%）：別のエラー：%', p_label, sqlerrm;
  end;
  raise exception 'TEST FAILED（%）：エラーにならなかった', p_label;
end $$;
create function t26.ok(p_cond boolean, p_label text) returns void language plpgsql as $$
begin
  if not coalesce(p_cond, false) then raise exception 'TEST FAILED（%）', p_label; end if;
  raise notice 'ok - %', p_label;
end $$;
grant execute on all functions in schema t26 to authenticated, anon, service_role;

\set H  'aaaaaaaa-0000-0000-0000-000000000001'
\set W  'cccccccc-0000-0000-0000-0000000000c2'

-- ---------- 0026 を流した直後の状態（run.sh が 0026 を3回流したあと） ----------
select t26.ok((select web_booking_line_only from stores where id = :'H'), '初めて流したとき：箱崎と同じIDの店舗は「LINEの中だけ」になる');
select t26.ok(not (select web_booking_line_only from stores where id = :'W'), 'ほかの店舗は今までどおり（LINEとWebの両方）');
select t26.ok((select column_default from information_schema.columns where table_name = 'stores' and column_name = 'web_booking_line_only') = 'true', 'これから作る店舗の既定は「LINEの中だけ」（安全側）');
select t26.ok((select not booked_enabled from (select coalesce(bool_or(booked_enabled), false) as booked_enabled from line_channels) x), '予約完了のお知らせは、どの店舗もオフのまま');
select t26.ok((select column_default from information_schema.columns where table_name = 'line_channels' and column_name = 'booked_enabled') = 'false', '予約完了のお知らせの既定はオフ');

-- ---------- 予約できる土台（スタッフ1人・メニュー1つ・3日後に出勤） ----------
set session_replication_role = replica;
insert into auth.users (id, email, email_confirmed_at) values ('00000000-0000-0000-0000-00000000c001', 'co@x.test', now()), ('00000000-0000-0000-0000-00000000c003', 'cs@x.test', now());
insert into staff (id, company_id, name, role, auth_user_id, active) values
 ('c0000000-0000-0000-0000-0000000000f1', 'cccccccc-0000-0000-0000-000000000001', 'Cowner', 'owner', '00000000-0000-0000-0000-00000000c001', true),
 ('c0000000-0000-0000-0000-0000000000f3', 'cccccccc-0000-0000-0000-000000000001', 'Cstaff', 'staff', '00000000-0000-0000-0000-00000000c003', true);
insert into menus (id, store_id, name, price, duration_min) values
 ('d0000000-0000-0000-0000-0000000000a1', :'H', 'まつげ60分', 6000, 60),
 ('d0000000-0000-0000-0000-0000000000a2', :'W', 'まつげ60分', 6000, 60);
insert into staff_stores (staff_id, store_id) select 'c0000000-0000-0000-0000-0000000000f1', s from unnest(array[:'H', :'W']::uuid[]) s;
insert into shifts (store_id, staff_id, date, start_time, end_time, kind)
select s, 'c0000000-0000-0000-0000-0000000000f1', (now() at time zone 'Asia/Tokyo')::date + 3, '10:00', '19:00', 'work' from unnest(array[:'H', :'W']::uuid[]) s;
set session_replication_role = origin;
select set_config('t26.d', ((now() at time zone 'Asia/Tokyo')::date + 3)::text, false);
\set SLOT1 '(current_setting(''t26.d'') || '' 11:00+09'')::timestamptz'
\set SLOT2 '(current_setting(''t26.d'') || '' 14:00+09'')::timestamptz'

-- ---------- 未ログインのブラウザ（anon） ----------
begin; set local role anon;
select t26.ok((public_store_info('hako-test') ->> 'line_only')::boolean, '予約ページに「LINEの中だけ」が伝わる（箱崎テスト）');
select t26.ok(not (public_store_info('both-test') ->> 'line_only')::boolean, '予約ページに「両方」が伝わる（両方テスト）');
select t26.ok(public_store_info('hako-test') ->> 'phone' = '092-000-0000' and public_store_info('hako-test') ? 'today' and public_store_info('hako-test') ? 'cancel_deadline_time', '店舗の情報は今までと同じ項目が返る');
select t26.ok(jsonb_array_length(public_availability('hako-test', 'd0000000-0000-0000-0000-0000000000a1', current_setting('t26.d')::date, current_setting('t26.d')::date + 1) -> 'days' -> current_setting('t26.d')) > 0, '空きは出ている（箱崎テスト）');
select t26.throws($$select public_create_booking('hako-test', 'd0000000-0000-0000-0000-0000000000a1', (current_setting('t26.d') || ' 11:00+09')::timestamptz, '山田 花子', 'ヤマダ ハナコ', '09011112222', 'a@example.com')$$,
  'line_only', '★LINEの中だけの店舗：LINE以外のブラウザからの予約を DB が断る');
select t26.throws($$select _create_booking_impl('hako-test', 'd0000000-0000-0000-0000-0000000000a1', (current_setting('t26.d') || ' 11:00+09')::timestamptz, '山田 花子', 'ヤマダ ハナコ', '09011112222', 'a@example.com', '[]'::jsonb, null, null, null, 'ja', null, null, null)$$,
  'permission denied', '予約の本体は anon から直接呼べない');
select t26.throws($$select service_create_booking('hako-test', 'd0000000-0000-0000-0000-0000000000a1', (current_setting('t26.d') || ' 11:00+09')::timestamptz, '山田 花子', 'ヤマダ ハナコ', '09011112222', 'a@example.com', '[]'::jsonb, null, null, null, 'ja', null, 'U0123456789abcdef0123456789abcdef', null)$$,
  'permission denied', 'LINE予約の入口は anon から呼べない（LINEのユーザーIDを勝手に名乗れない）');
select t26.throws($$select web_booking_line_only from stores$$, 'permission denied', 'anon は stores を直接読めない');
select t26.throws($$update stores set web_booking_line_only = false$$, 'permission denied', 'anon は受け方を変えられない');
select t26.ok((public_create_booking('both-test', 'd0000000-0000-0000-0000-0000000000a2', (current_setting('t26.d') || ' 11:00+09')::timestamptz, '佐藤 次郎', 'サトウ ジロウ', '09033334444', 'b@example.com') ->> 'booking_no') like 'W%',
  '両方の店舗：LINE以外のブラウザからの予約は今までどおり通る');
commit;
select t26.ok((select count(*) from bookings where store_id = :'H') = 0, '断った予約は1件も残っていない（お客様も作られていない）');
select t26.ok((select count(*) from customers where company_id = 'cccccccc-0000-0000-0000-000000000001' and phone = '09011112222') = 0, '断った予約のお客様は作られていない');

-- ---------- ログイン中のスタッフ（authenticated）：ブラウザの入口は同じように断る ----------
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c003', true);
select t26.throws($$select public_create_booking('hako-test', 'd0000000-0000-0000-0000-0000000000a1', (current_setting('t26.d') || ' 11:00+09')::timestamptz, '山田 花子', 'ヤマダ ハナコ', '09011112222', 'a@example.com')$$,
  'line_only', 'ログイン中でも、ブラウザの入口（public_create_booking）は LINEの中だけの店舗では断る');
select t26.throws($$select service_create_booking('hako-test', 'd0000000-0000-0000-0000-0000000000a1', (current_setting('t26.d') || ' 11:00+09')::timestamptz, '山田 花子', 'ヤマダ ハナコ', '09011112222', 'a@example.com', '[]'::jsonb, null, null, null, 'ja', null, 'U0123456789abcdef0123456789abcdef', null)$$,
  'permission denied', 'LINE予約の入口はスタッフのログインからも呼べない');
commit;

-- ---------- サーバ（service_role）：LINE が本人を確かめたあとの予約は通る ----------
begin; set local role service_role;
select set_config('t26.r', service_create_booking('hako-test', 'd0000000-0000-0000-0000-0000000000a1', (current_setting('t26.d') || ' 11:00+09')::timestamptz, '山田 花子', 'ヤマダ ハナコ', '09011112222', 'a@example.com', '[]'::jsonb, null, null, null, 'ja', null, 'U0123456789abcdef0123456789abcdef', 'はなこ')::text, false);
commit;
select t26.ok((current_setting('t26.r')::jsonb ->> 'booking_no') like 'W%' and (current_setting('t26.r')::jsonb ->> 'line_linked')::boolean, '★LINEの中だけの店舗：LINEの中の予約（サーバ経由）は通る・LINEとつながる');
select t26.ok((select count(*) from bookings where store_id = :'H' and status = 'booked' and channel = 'own' and note like '%（LINE）%') = 1, '台帳に（LINE）付きで1件入る');
select t26.ok((select count(*) from notifications where store_id = :'H' and kind = 'new_booking' and read_at is null) = 1, '台帳の「お知らせ」（new_booking・未確認）が1件できる＝ホットペッパーを閉じる合図');
begin; set local role service_role;
select t26.throws($$select service_create_booking('hako-test', 'd0000000-0000-0000-0000-0000000000a1', (current_setting('t26.d') || ' 11:00+09')::timestamptz, '山田 花子', 'ヤマダ ハナコ', '09011112222', 'a@example.com', '[]'::jsonb, null, null, null, 'ja', null, 'U0123456789abcdef0123456789abcdef', 'はなこ')$$,
  'slot_taken|duplicate', '同じ内容をもう一度送っても2件目はできない（通信が切れて送り直したとき）');
commit;
select t26.ok((select count(*) from bookings where store_id = :'H' and status = 'booked') = 1, '予約は1件のまま');

-- ---------- キャンセルのリンク（LINEに送るリンク）は LINE の外のブラウザからも使える ----------
begin; set local role anon;
select t26.ok((public_booking_by_token(current_setting('t26.r')::jsonb ->> 'cancel_token') ->> 'booking_no') = (current_setting('t26.r')::jsonb ->> 'booking_no'), 'キャンセルのリンクで予約が見える（LINEの中だけの店舗でも）');
select t26.ok((public_cancel_booking(current_setting('t26.r')::jsonb ->> 'cancel_token') ->> 'ok')::boolean, 'キャンセルできる');
commit;
select t26.ok((select count(*) from bookings where store_id = :'H' and status = 'booked') = 0, 'キャンセル後は予約中が0件');

-- ---------- 設定の切り替え（オーナーはできる・スタッフはできない） ----------
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c003', true);
update stores set web_booking_line_only = false where id = :'H';
commit;
select t26.ok((select web_booking_line_only from stores where id = :'H'), 'スタッフは受け方を変えられない（0行）');
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
update stores set web_booking_line_only = false where id = :'H';
insert into line_channels (store_id, booked_enabled) values (:'H', true);
update line_channels set booked_enabled = false where store_id = :'H';
commit;
select t26.ok(not (select web_booking_line_only from stores where id = :'H'), 'オーナーは「両方」に切り替えられる');
select t26.ok((select not booked_enabled from line_channels where store_id = :'H'), 'オーナーは予約完了のお知らせのオン/オフを保存できる');
begin; set local role anon;
select t26.ok((public_create_booking('hako-test', 'd0000000-0000-0000-0000-0000000000a1', (current_setting('t26.d') || ' 14:00+09')::timestamptz, '山田 花子', 'ヤマダ ハナコ', '09011112222', 'a@example.com') ->> 'booking_no') like 'W%',
  '「両方」にしたあとは、ブラウザからも予約できる');
commit;
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c001', true);
update stores set web_booking_enabled = false where id = :'H';
commit;
begin; set local role anon;
select t26.ok(public_store_info('hako-test') is null, '「受け付けない」にすると、予約ページは準備中（店舗の情報を返さない）');
select t26.throws($$select public_create_booking('hako-test', 'd0000000-0000-0000-0000-0000000000a1', (current_setting('t26.d') || ' 15:00+09')::timestamptz, '山田 花子', 'ヤマダ ハナコ', '09011112222', 'a@example.com')$$, 'store_not_found', '「受け付けない」の店舗は予約できない');
commit;

-- ---------- 流し直しても、設定画面で変えた内容を上書きしない ----------
update stores set web_booking_enabled = true, web_booking_line_only = false where id = :'H';
\i supabase/migrations/0026_line_only_booking.sql
select t26.ok(not (select web_booking_line_only from stores where id = :'H'), '0026 を流し直しても、「両方」に変えた設定は「LINEの中だけ」に戻らない');

\o
select 'ALL TESTS PASSED（予約の受け方 0026）' as result;
