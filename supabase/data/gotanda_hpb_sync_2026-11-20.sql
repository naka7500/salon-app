-- KOKAGE西五反田：HPB（ホットペッパービューティー）掲載中のクーポン16件・メニュー3件に、salon-app のメニュー・クーポン・HPB対応表を合わせる。
-- 出典：/home/claude/kokage_rep/hpb/gotanda_hpb_2026-11-20.md（2026-11-20 12:20 取得。名前は全角・空白も含めてそのまま）
-- ※マイグレーションではありません（データの同期）。0001〜0026 が流れている DB に、Supabase の SQL Editor で1回流してください。
-- ※触るのは店舗 aaaaaaaa-0000-0000-0000-000000000002（KOKAGE西五反田）だけ。他の店舗の行は1行も変えません。
-- ※何度流しても同じ結果（固定の ID で upsert）。行は消さない：HPB に無い古いメニュー・クーポン・対応表は「止める」だけ
--   （seed_gotanda.sql の仮メニュー6件＝90分サブリミック／90分リラクゼーション／90分育毛／クイック60分／平日90分／ヘッドスキンケア追加 も、
--    ID が固定でないので「西五反田の行で、この SQL が作る ID 以外」を active=false・web_visible=false にして止める）。
-- 作り（要点）
--  ・HPB のクーポンは「技術メニュー1つ＋特別価格（fixed）」。所要時間はアプリでは対象メニューの時間（クーポンに時間の欄は無い）
--    クイック60分＝60分、ほかは90分（HPB 公開ページに時間は出ない。サロンボードで「平日専用…90分」=01:30 を確認済み。Foreign の90分は推測）
--  ・ネット予約の「メニュー」タブに出す技術メニュー＝HPB のメニュータブと同じ3件（クイック60分 14,300／髪質改善90分 22,000／リラクゼーション集中90分 22,000）
--  ・クーポン専用（0018 coupon_only＝メニュータブに出さない・対象のクーポンでだけネット予約できる）の技術メニュー2件：
--      育毛促進・ヘッドスキンケア90分（定価 22,000 は推測。HPB のメニュータブに定価が無い）／For Foreign Visitors 90分（22,000＝クーポン No.16 の価格）
--  ・ペア（2名様）：HPB には無いが公式ネット予約・LINE ではお二人同時を受けるので（HPB No.15 の案内どおり）、people=2 の技術メニューを1つ作ってネットに出す。
--      名前はカミングスーン台帳の「ペア90分+90分」に寄せる。価格 28,600（＝14,300×2）は推測・要確認。受付枠は「2名様レーン」（capacity>=2 の枠。無ければ標準の枠）
--  ・クーポン16件のうち15件を作る。No.15「※ご案内用※お二人でのご予約は…」は価格0円の案内で予約にならないので作らない
--  ・対象：新規=new／全員=all／再来=repeat（アプリに repeat があるのでそのまま）
--  ・《平日専用》の6件（No.2〜4・9〜11）は、アプリのクーポンの受付曜日（weekdays）を月〜金にする（祝日は判定しない）
--  ・説明文は HPB の文＋末尾に「【利用条件】…／提示条件：…／有効期限：なし」
--  ・準備・インターバルは0分（HPB の所要目安時間＝台帳でふさぐ時間）
--  ・HPB 対応表：クーポン名そのまま（同名は1行＝9行。No.15 は入れない）＋短い言葉6つ。「ペア」は HPB 経由では来ないので入れない

begin;

do $$ begin
  if not exists (select 1 from stores where id = 'aaaaaaaa-0000-0000-0000-000000000002') then raise exception '店舗 aaaaaaaa-0000-0000-0000-000000000002（KOKAGE西五反田）がありません'; end if;
  if to_regclass('public.option_groups') is null or to_regclass('public.hpb_mappings') is null or to_regclass('public.hpb_settings') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stores' and column_name = 'ledger_menu_ids')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'menus' and column_name = 'coupon_only')
     or to_regclass('public.consent_documents') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stores' and column_name = 'web_booking_line_only') then
    raise exception '0001〜0026 がすべて流れていません（0009・0011・0014・0018・0025・0026 のどれかが見つかりません）。先にマイグレーションを流してください';
  end if;
end $$;

-- 1) 技術メニュー6件（ネットに出す3＋クーポン専用2＋ペア1）
insert into menus (id, store_id, name, name_en, short_name, color, category, price, tax_rate, duration_min, interval_min, needs_resource, sort_order, active,
                   description, target, publish_from, publish_to, weekdays, time_from, time_to, lane_id, nominatable, web_visible,
                   people, option_group_id, option_group_ids, coupon_only) values
  ('a5a20001-0b5a-4c05-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', '【女性用】頭浸浴 リトリートスパ クイック60分【髪の長さが肩上までの方】', null, 'クイック', '#c5d94b', 'technical', 14300, 0.10, 60, 0, true, 10, true,
   'クイックコース。頭浸浴・スパや超高濃度水素ケア込みで癒しやヘアケアも充実。ご来店から退店まで60分。髪の長さが肩上までの方限定メニュー。', 'all', null, null, null, null, null, null, true, true, 1, null, '{}'::uuid[], false),
  ('a5a20001-0b5a-4c05-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', '人気No.1【女性用】頭浸浴 リトリートスパ 髪質改善ケアコース 90分', null, '髪質改善', '#e8547a', 'technical', 22000, 0.10, 90, 0, true, 20, true,
   '【サブリミック使用】水素シャンプー・頭浸浴スパ・リンパケア・超高濃度水素ケア＆酸熱トリートメント・※シャンプー台での施術時間は40分。', 'all', null, null, null, null, null, null, true, true, 1, null, '{}'::uuid[], false),
  ('a5a20001-0b5a-4c05-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', '人気No.2【女性用】頭浸浴 リトリートスパ リラクゼーション集中コース 90分', null, 'リラク', '#b57edc', 'technical', 22000, 0.10, 90, 0, true, 30, true,
   '【バリジョア使用】水素シャンプー・頭浸浴スパ ロング・リンパケア・超高濃度水素ケア・クイックトリートメント※シャンプー台での施術は40分。', 'all', null, null, null, null, null, null, true, true, 1, null, '{}'::uuid[], false),
  -- クーポン専用：定価 22,000 は推測（HPB のメニュータブに無い。髪質改善・リラクと同じ90分コースなので同額と仮置き）
  ('a5a20001-0b5a-4c05-8000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000002', '【女性用】頭浸浴 リトリートスパ 育毛促進・ヘッドスキンケアコース90分', null, '育毛', '#2bb3a3', 'technical', 22000, 0.10, 90, 0, true, 40, true,
   '30代からの頭皮悩み（抜け毛・分け目・ボリューム）に。頭浸浴×資生堂アデノバイタル(医薬部外品)で育む頭皮環境へ。男性にもおすすめ、お二人でのご予約もお待ちしています。', 'all', null, null, null, null, null, null, true, true, 1, null, '{}'::uuid[], true),
  -- クーポン専用：22,000＝クーポン No.16 の価格。90分は推測（サロンボードの掲載管理で要確認）
  ('a5a20001-0b5a-4c05-8000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000002', '【For Foreign Visitors】Premium Head Spa 90min (Spa time 40min)', 'Premium Head Spa 90min (Spa time 40min) - For Foreign Visitors', 'Foreign', '#1f7f9a', 'technical', 22000, 0.10, 90, 0, true, 50, true,
   '40min bowl-spa with warm head soak, head massage & hair treatment. No body/face. 10min late = cancel. Total 90min including prep time. Price includes 12% service charge and 10% tax', 'all', null, null, null, null, null, null, true, true, 1, null, '{}'::uuid[], true),
  -- ペア（2名様）：価格 28,600＝14,300×2 は推測・要確認。lane_id＝2名様レーン（最初の枠以外で同時2名以上の枠。無ければ null＝標準の枠）
  ('a5a20001-0b5a-4c05-8000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000002', 'ペア90分+90分（2名様でのご予約）', 'Pair 90min + 90min (2 guests)', 'ペア', '#d98c5f', 'technical', 28600, 0.10, 90, 0, true, 60, true,
   'お二人で同じ時間にヘッドスパ90分。料金は2名様1組の料金です。コース（髪質改善ケア／リラクゼーション集中／育毛促進）はご来店時にお一人ずつお選びいただけます。', 'all', null, null, null, null, null,
   (select l.id from lanes l where l.store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and coalesce(l.active, true) and l.capacity >= 2
      and l.id is distinct from (select f.id from lanes f where f.store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and coalesce(f.active, true) order by f.sort_order, f.id limit 1)
    order by l.sort_order, l.id limit 1),
   true, true, 2, null, '{}'::uuid[], false)
on conflict (id) do update set name = excluded.name, name_en = excluded.name_en, short_name = excluded.short_name, color = excluded.color, category = excluded.category,
  price = excluded.price, tax_rate = excluded.tax_rate, duration_min = excluded.duration_min, interval_min = excluded.interval_min,
  needs_resource = excluded.needs_resource, sort_order = excluded.sort_order, active = true, description = excluded.description,
  target = excluded.target, publish_from = null, publish_to = null, weekdays = null, time_from = null, time_to = null, lane_id = excluded.lane_id,
  nominatable = excluded.nominatable, web_visible = true, people = excluded.people, option_group_id = null, option_group_ids = '{}'::uuid[],
  coupon_only = excluded.coupon_only
  where menus.store_id = excluded.store_id;

-- 2) クーポン15件（HPB の掲載順＝sort_order＝HPB の No.・特別価格。No.15 は作らない）
insert into coupons (id, store_id, name, description, kind, value, menu_ids, target, within_days, weekdays, time_from, time_to,
                     first_n, per_customer_limit, code, publish_from, publish_to, web_visible, sort_order, active, option_group_ids) values
  ('a5a20003-0b5a-4c05-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', '【女性用】頭浸浴 リトリートスパ クイック60分【髪の長さが肩上までの方】',
   '時間が短めのコースとなりますが頭浸浴・スパや超高濃度水素ケア込みで癒しやヘアケアも充実。ご来店から退店まで60分。髪の長さが肩上までの方限定メニュー。
【利用条件】ご新規の方・長さ肩上まで／提示条件：予約時／有効期限：なし',
   'fixed', 9900, array['a5a20001-0b5a-4c05-8000-000000000001']::uuid[], 'new', null, null, null, null, null, null, null, null, null, true, 1, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', '《平日専用/ギフト付》【女性用】頭浸浴リトリートスパ 髪質改善ケア90分',
   '11月ご来店の方限定。施術内容は通常の髪質改善ケア90分メニューと変わりません。「おつかれさまギフト」をプレゼント。※シャンプー台での施術時間は40分。
【利用条件】平日限定※女性のみ／提示条件：予約時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000002']::uuid[], 'new', null, array[1,2,3,4,5], null, null, null, null, null, null, null, true, 2, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', '《平日専用/ギフト付》【女性用】頭浸浴リトリートスパ リラク集中90分',
   '11月ご来店の方限定。施術内容は通常のリラクゼーション集中メニューと変わりません。「おつかれさまギフト」をプレゼント。※シャンプー台での施術時間は40分。
【利用条件】平日限定※女性のみ／提示条件：予約時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000003']::uuid[], 'new', null, array[1,2,3,4,5], null, null, null, null, null, null, null, true, 3, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000002', '《平日専用/ギフト付》【女性用】頭浸浴リトリートスパ 育毛促進90分',
   '11月ご来店の方限定。施術内容は通常の育毛促進・ヘッドスキンケアメニューと変わりません。「おつかれさまギフト」をプレゼント。※シャンプー台での施術時間は40分。
【利用条件】平日限定※女性のみ／提示条件：予約時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000004']::uuid[], 'new', null, array[1,2,3,4,5], null, null, null, null, null, null, null, true, 4, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000002', '人気No.1【女性用】頭浸浴 リトリートスパ 髪質改善ケアコース 90分',
   '【オープン特別価格】【サブリミック使用・素髪のような柔らかい艶髪へ】水素シャンプー・頭浸浴スパ・リンパケア・超高濃度水素ケア＆酸熱トリートメント・※シャンプー台での施術時間は40分。
【利用条件】ご新規の方／提示条件：予約時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000002']::uuid[], 'new', null, null, null, null, null, null, null, null, null, true, 5, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000002', '人気No.2【女性用】頭浸浴 リトリートスパ リラクゼーション集中コース 90分',
   '【オープン特別価格】【クイックトリートメント込み】水素シャンプー・頭浸浴スパ ロング・頭皮リンパケア・超高濃度水素ケア・クイックトリートメント※シャンプー台での施術時間は40分。
【利用条件】ご新規の方／提示条件：予約時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000003']::uuid[], 'new', null, null, null, null, null, null, null, null, null, true, 6, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000002', '【女性用】頭浸浴 リトリートスパ 育毛促進・ヘッドスキンケアコース90分',
   '30代からの頭皮悩み（抜け毛・分け目・ボリューム）に。頭浸浴×資生堂アデノバイタル(医薬部外品)で育む頭皮環境へ。男性にもおすすめ、お二人でのご予約もお待ちしています。
【利用条件】全員可（男性は女性同伴のみ）／提示条件：予約時＆入店時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000004']::uuid[], 'new', null, null, null, null, null, null, null, null, null, true, 7, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000002', '【女性用】頭浸浴 リトリートスパ クイック60分【長さが肩上までの方】',
   '短めのコースとなりますが頭浸浴・スパや超高濃度水素ケア込みで癒しやヘアケアも充実。ご来店から退店まで60分。髪の長さが肩上までの方限定メニュー。
【利用条件】全員※女性の方のみ※長さ肩上まで／提示条件：予約時＆入店時／有効期限：なし',
   'fixed', 9900, array['a5a20001-0b5a-4c05-8000-000000000001']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 8, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000002', '《平日専用/ギフト付》【女性用】頭浸浴リトリートスパ 髪質改善ケア90分',
   '施術内容は通常の髪質改善ケア90分メニューと変わりません。「おつかれさまギフト」をプレゼント。※シャンプー台での施術時間は40分。
【利用条件】平日限定※女性のみ／提示条件：予約時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000002']::uuid[], 'repeat', null, array[1,2,3,4,5], null, null, null, null, null, null, null, true, 9, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000002', '《平日専用/ギフト付》【女性用】頭浸浴リトリートスパ リラク集中90分',
   '施術内容は通常のリラクゼーション集中メニューと変わりません。「おつかれさまギフト」をプレゼント。※シャンプー台での施術時間は40分。
【利用条件】平日限定※女性のみ／提示条件：予約時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000003']::uuid[], 'repeat', null, array[1,2,3,4,5], null, null, null, null, null, null, null, true, 10, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000002', '《平日専用/ギフト付》【女性用】頭浸浴リトリートスパ 育毛促進90分',
   '施術内容は通常の育毛促進・ヘッドスキンケアメニューと変わりません。「おつかれさまギフト」をプレゼント。※シャンプー台での施術時間は40分。
【利用条件】平日限定※女性のみ／提示条件：予約時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000004']::uuid[], 'repeat', null, array[1,2,3,4,5], null, null, null, null, null, null, null, true, 11, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000002', '人気No.1【女性用】頭浸浴 リトリートスパ 髪質改善ケアコース 90分',
   '【オープン特別価格】【サブリミック使用・素髪のような柔らかい艶髪へ】水素シャンプー・頭浸浴スパ・リンパケア・超高濃度水素ケア＆酸熱トリートメント・※シャンプー台での施術時間は40分。
【利用条件】全員※女性の方のみ※／提示条件：予約時＆入店時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000002']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 12, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000002', '人気No.2【女性用】頭浸浴 リトリートスパ リラクゼーション集中コース 90分',
   '【オープン特別価格】【クイックトリートメント込み】水素シャンプー・頭浸浴スパ ロング・頭皮リンパケア・超高濃度水素ケア・クイックトリートメント※シャンプー台での施術時間は40分。
【利用条件】全員ご利用可能／提示条件：予約時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000003']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 13, true, '{}'::uuid[]),
  ('a5a20003-0b5a-4c05-8000-000000000014', 'aaaaaaaa-0000-0000-0000-000000000002', '【女性用】頭浸浴 リトリートスパ 育毛促進・ヘッドスキンケアコース90分',
   '30代からの頭皮悩み（抜け毛・分け目・ボリューム）に。頭浸浴×資生堂アデノバイタル(医薬部外品)で育む頭皮環境へ。男性にもおすすめ、お二人でのご予約もお待ちしています。
【利用条件】全員可（男性は女性同伴のみ）／提示条件：予約時＆入店時／有効期限：なし',
   'fixed', 14300, array['a5a20001-0b5a-4c05-8000-000000000004']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 14, true, '{}'::uuid[]),
  -- No.15「※ご案内用※お二人でのご予約は公式ラインか公式サイトからのネット予約可能」（0円・案内）は作らない
  ('a5a20003-0b5a-4c05-8000-000000000016', 'aaaaaaaa-0000-0000-0000-000000000002', '【For Foreign Visitors】Premium Head Spa 90min (Spa time 40min)',
   '40min bowl-spa with warm head soak, head massage & hair treatment. No body/face. 10min late = cancel. Total 90min including prep time. Price includes 12% service charge and 10% tax
【利用条件】For travelers only. Select at booking.／提示条件：予約時／有効期限：なし',
   'fixed', 22000, array['a5a20001-0b5a-4c05-8000-000000000005']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 16, true, '{}'::uuid[])
on conflict (id) do update set name = excluded.name, description = excluded.description, kind = excluded.kind, value = excluded.value,
  menu_ids = excluded.menu_ids, target = excluded.target, within_days = null, weekdays = excluded.weekdays, time_from = null, time_to = null,
  first_n = null, per_customer_limit = null, code = null, publish_from = null, publish_to = null, web_visible = excluded.web_visible,
  sort_order = excluded.sort_order, active = excluded.active, option_group_ids = excluded.option_group_ids
  where coupons.store_id = excluded.store_id;

-- 3) HPB 予約メール取り込みの対応表（上から順に、最初に当てはまったもの。クーポン名そのまま9行 → 短い言葉6行）
insert into hpb_mappings (id, store_id, kind, pattern, menu_id, people, sort_order, active) values
  ('a5a20004-0b5a-4c05-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '【女性用】頭浸浴 リトリートスパ クイック60分【髪の長さが肩上までの方】', 'a5a20001-0b5a-4c05-8000-000000000001', null, 1, true),
  ('a5a20004-0b5a-4c05-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '【女性用】頭浸浴 リトリートスパ クイック60分【長さが肩上までの方】', 'a5a20001-0b5a-4c05-8000-000000000001', null, 2, true),
  ('a5a20004-0b5a-4c05-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '《平日専用/ギフト付》【女性用】頭浸浴リトリートスパ 髪質改善ケア90分', 'a5a20001-0b5a-4c05-8000-000000000002', null, 3, true),
  ('a5a20004-0b5a-4c05-8000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '《平日専用/ギフト付》【女性用】頭浸浴リトリートスパ リラク集中90分', 'a5a20001-0b5a-4c05-8000-000000000003', null, 4, true),
  ('a5a20004-0b5a-4c05-8000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '《平日専用/ギフト付》【女性用】頭浸浴リトリートスパ 育毛促進90分', 'a5a20001-0b5a-4c05-8000-000000000004', null, 5, true),
  ('a5a20004-0b5a-4c05-8000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '人気No.1【女性用】頭浸浴 リトリートスパ 髪質改善ケアコース 90分', 'a5a20001-0b5a-4c05-8000-000000000002', null, 6, true),
  ('a5a20004-0b5a-4c05-8000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '人気No.2【女性用】頭浸浴 リトリートスパ リラクゼーション集中コース 90分', 'a5a20001-0b5a-4c05-8000-000000000003', null, 7, true),
  ('a5a20004-0b5a-4c05-8000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '【女性用】頭浸浴 リトリートスパ 育毛促進・ヘッドスキンケアコース90分', 'a5a20001-0b5a-4c05-8000-000000000004', null, 8, true),
  ('a5a20004-0b5a-4c05-8000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '【For Foreign Visitors】Premium Head Spa 90min (Spa time 40min)', 'a5a20001-0b5a-4c05-8000-000000000005', null, 9, true),
  ('a5a20004-0b5a-4c05-8000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '髪質改善', 'a5a20001-0b5a-4c05-8000-000000000002', null, 10, true),
  ('a5a20004-0b5a-4c05-8000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', 'リラク集中', 'a5a20001-0b5a-4c05-8000-000000000003', null, 11, true),
  ('a5a20004-0b5a-4c05-8000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', 'リラクゼーション集中', 'a5a20001-0b5a-4c05-8000-000000000003', null, 12, true),
  ('a5a20004-0b5a-4c05-8000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', '育毛促進', 'a5a20001-0b5a-4c05-8000-000000000004', null, 13, true),
  ('a5a20004-0b5a-4c05-8000-000000000014', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', 'クイック60分', 'a5a20001-0b5a-4c05-8000-000000000001', null, 14, true),
  ('a5a20004-0b5a-4c05-8000-000000000015', 'aaaaaaaa-0000-0000-0000-000000000002', 'menu', 'For Foreign Visitors', 'a5a20001-0b5a-4c05-8000-000000000005', null, 15, true)
on conflict (id) do update set kind = 'menu', pattern = excluded.pattern, menu_id = excluded.menu_id, people = null,
  sort_order = excluded.sort_order, active = true
  where hpb_mappings.store_id = excluded.store_id;

-- 4) HPB に無い古い行は止める（消さない：テスト予約・売上から参照されていても安全）
--    seed_gotanda.sql の仮メニュー6件（90分サブリミックヘッドスパ／90分リラクゼーションヘッドスパ／90分育毛ヘッドスパ／クイックヘッドスパ 60分／平日90分ヘッドスパ／ヘッドスキンケア追加）もここで止まる
update menus set active = false, web_visible = false
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and id <> all(array['a5a20001-0b5a-4c05-8000-000000000001','a5a20001-0b5a-4c05-8000-000000000002','a5a20001-0b5a-4c05-8000-000000000003','a5a20001-0b5a-4c05-8000-000000000004','a5a20001-0b5a-4c05-8000-000000000005','a5a20001-0b5a-4c05-8000-000000000006']::uuid[]) and (coalesce(active, true) or web_visible);
update coupons set active = false, web_visible = false
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and id <> all(array['a5a20003-0b5a-4c05-8000-000000000001','a5a20003-0b5a-4c05-8000-000000000002','a5a20003-0b5a-4c05-8000-000000000003','a5a20003-0b5a-4c05-8000-000000000004','a5a20003-0b5a-4c05-8000-000000000005','a5a20003-0b5a-4c05-8000-000000000006','a5a20003-0b5a-4c05-8000-000000000007','a5a20003-0b5a-4c05-8000-000000000008','a5a20003-0b5a-4c05-8000-000000000009','a5a20003-0b5a-4c05-8000-000000000010','a5a20003-0b5a-4c05-8000-000000000011','a5a20003-0b5a-4c05-8000-000000000012','a5a20003-0b5a-4c05-8000-000000000013','a5a20003-0b5a-4c05-8000-000000000014','a5a20003-0b5a-4c05-8000-000000000016']::uuid[]) and (active or web_visible);
-- HPB の西五反田にオプションは無い：画面で作られた古いオプショングループがあれば止める
update option_groups set active = false
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and active;
update hpb_mappings set active = false
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and kind = 'menu' and id <> all(array['a5a20004-0b5a-4c05-8000-000000000001','a5a20004-0b5a-4c05-8000-000000000002','a5a20004-0b5a-4c05-8000-000000000003','a5a20004-0b5a-4c05-8000-000000000004','a5a20004-0b5a-4c05-8000-000000000005','a5a20004-0b5a-4c05-8000-000000000006','a5a20004-0b5a-4c05-8000-000000000007','a5a20004-0b5a-4c05-8000-000000000008','a5a20004-0b5a-4c05-8000-000000000009','a5a20004-0b5a-4c05-8000-000000000010','a5a20004-0b5a-4c05-8000-000000000011','a5a20004-0b5a-4c05-8000-000000000012','a5a20004-0b5a-4c05-8000-000000000013','a5a20004-0b5a-4c05-8000-000000000014','a5a20004-0b5a-4c05-8000-000000000015']::uuid[]) and active;
-- いつものメニュー（対応が無いとき）が止めたメニューなら外す
update hpb_settings set default_menu_id = null
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and default_menu_id is not null and default_menu_id <> all(array['a5a20001-0b5a-4c05-8000-000000000001','a5a20001-0b5a-4c05-8000-000000000002','a5a20001-0b5a-4c05-8000-000000000003','a5a20001-0b5a-4c05-8000-000000000004','a5a20001-0b5a-4c05-8000-000000000005','a5a20001-0b5a-4c05-8000-000000000006']::uuid[]);
-- 予約台帳の上のチップ：クイック・髪質改善・リラク・育毛・Foreign・ペア
update stores set ledger_menu_ids = array['a5a20001-0b5a-4c05-8000-000000000001','a5a20001-0b5a-4c05-8000-000000000002','a5a20001-0b5a-4c05-8000-000000000003','a5a20001-0b5a-4c05-8000-000000000004','a5a20001-0b5a-4c05-8000-000000000005','a5a20001-0b5a-4c05-8000-000000000006']::uuid[]
 where id = 'aaaaaaaa-0000-0000-0000-000000000002'
   and ledger_menu_ids is distinct from array['a5a20001-0b5a-4c05-8000-000000000001','a5a20001-0b5a-4c05-8000-000000000002','a5a20001-0b5a-4c05-8000-000000000003','a5a20001-0b5a-4c05-8000-000000000004','a5a20001-0b5a-4c05-8000-000000000005','a5a20001-0b5a-4c05-8000-000000000006']::uuid[];

-- 5) 確認（足りなければ全部取り消し）
do $$
declare n_m int; n_c int; n_h int; n_pair int;
begin
  select count(*) into n_m from menus where store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and id = any(array['a5a20001-0b5a-4c05-8000-000000000001','a5a20001-0b5a-4c05-8000-000000000002','a5a20001-0b5a-4c05-8000-000000000003','a5a20001-0b5a-4c05-8000-000000000004','a5a20001-0b5a-4c05-8000-000000000005','a5a20001-0b5a-4c05-8000-000000000006']::uuid[]) and active and web_visible and category = 'technical';
  select count(*) into n_c from coupons where store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and id = any(array['a5a20003-0b5a-4c05-8000-000000000001','a5a20003-0b5a-4c05-8000-000000000002','a5a20003-0b5a-4c05-8000-000000000003','a5a20003-0b5a-4c05-8000-000000000004','a5a20003-0b5a-4c05-8000-000000000005','a5a20003-0b5a-4c05-8000-000000000006','a5a20003-0b5a-4c05-8000-000000000007','a5a20003-0b5a-4c05-8000-000000000008','a5a20003-0b5a-4c05-8000-000000000009','a5a20003-0b5a-4c05-8000-000000000010','a5a20003-0b5a-4c05-8000-000000000011','a5a20003-0b5a-4c05-8000-000000000012','a5a20003-0b5a-4c05-8000-000000000013','a5a20003-0b5a-4c05-8000-000000000014','a5a20003-0b5a-4c05-8000-000000000016']::uuid[]) and active and web_visible;
  select count(*) into n_h from hpb_mappings where store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and id = any(array['a5a20004-0b5a-4c05-8000-000000000001','a5a20004-0b5a-4c05-8000-000000000002','a5a20004-0b5a-4c05-8000-000000000003','a5a20004-0b5a-4c05-8000-000000000004','a5a20004-0b5a-4c05-8000-000000000005','a5a20004-0b5a-4c05-8000-000000000006','a5a20004-0b5a-4c05-8000-000000000007','a5a20004-0b5a-4c05-8000-000000000008','a5a20004-0b5a-4c05-8000-000000000009','a5a20004-0b5a-4c05-8000-000000000010','a5a20004-0b5a-4c05-8000-000000000011','a5a20004-0b5a-4c05-8000-000000000012','a5a20004-0b5a-4c05-8000-000000000013','a5a20004-0b5a-4c05-8000-000000000014','a5a20004-0b5a-4c05-8000-000000000015']::uuid[]) and active;
  select count(*) into n_pair from menus where id = 'a5a20001-0b5a-4c05-8000-000000000006' and store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and people = 2 and not coupon_only;
  if n_m <> 6 or n_c <> 15 or n_h <> 15 or n_pair <> 1 then
    raise exception '同期が不完全です（menus %/6, coupons %/15, mappings %/15, pair %/1）。ID が他の店舗と重なっていないか確認してください', n_m, n_c, n_h, n_pair;
  end if;
  -- ネット掲載クーポンの対象メニューは、予約できる技術メニューか
  if exists (select 1 from coupons c join menus m on m.id = c.menu_ids[1] where c.store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and c.web_visible and c.active
              and (m.category <> 'technical' or not m.web_visible or not coalesce(m.active, true) or m.store_id <> c.store_id)) then
    raise exception 'ネット掲載のクーポンの対象メニューが予約できない状態です';
  end if;
  -- クーポン専用のメニュー（育毛・Foreign）は、必ずどれかのネット掲載クーポンの対象になっているか（なっていないとネットから一切予約できない）
  if exists (select 1 from menus m where m.store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and m.coupon_only and coalesce(m.active, true)
              and not exists (select 1 from coupons c where c.store_id = m.store_id and c.active and c.web_visible and m.id = any(c.menu_ids))) then
    raise exception 'クーポン専用のメニューに、対象にしているネット掲載クーポンがありません';
  end if;
  -- ネットの「メニュー」タブに出るのは3件（クイック・髪質改善・リラク）＋ペア1件＝4件
  if (select count(*) from menus m where m.store_id = 'aaaaaaaa-0000-0000-0000-000000000002' and coalesce(m.active, true) and m.web_visible and m.category = 'technical' and not m.coupon_only) <> 4 then
    raise exception 'ネットのメニュータブに出るメニューが4件（HPB の3件＋ペア）になっていません';
  end if;
end $$;

commit;

-- 6) 結果の一覧（section ごと：件数 → ネットに出るクーポン → 技術メニュー → 止めた行）
with st as (select 'aaaaaaaa-0000-0000-0000-000000000002'::uuid as id),
cp as (
  select c.sort_order, c.name, c.value as price, m.duration_min as minutes, c.target, c.weekdays, c.web_visible, c.active, m.name as menu_name
    from coupons c join st on c.store_id = st.id left join menus m on m.id = c.menu_ids[1]
)
select * from (
  select 0 as sec, 0 as ord, '件数' as section,
         format('ネット掲載クーポン %s／技術メニュー(掲載) %s（うちメニュータブに出る %s・クーポン専用 %s）／HPB対応表 %s／止めたメニュー %s／止めたクーポン %s／台帳チップ %s',
           (select count(*) from coupons c, st where c.store_id = st.id and c.active and c.web_visible),
           (select count(*) from menus m, st where m.store_id = st.id and coalesce(m.active, true) and m.web_visible and m.category = 'technical'),
           (select count(*) from menus m, st where m.store_id = st.id and coalesce(m.active, true) and m.web_visible and m.category = 'technical' and not m.coupon_only),
           (select count(*) from menus m, st where m.store_id = st.id and coalesce(m.active, true) and m.web_visible and m.category = 'technical' and m.coupon_only),
           (select count(*) from hpb_mappings h, st where h.store_id = st.id and h.kind = 'menu' and h.active),
           (select count(*) from menus m, st where m.store_id = st.id and not coalesce(m.active, true)),
           (select count(*) from coupons c, st where c.store_id = st.id and not c.active),
           (select cardinality(s.ledger_menu_ids) from stores s, st where s.id = st.id)) as name,
         null::int as price, null::int as minutes, null::text as target, null::text as note
  union all
  select 1, sort_order, case when active and web_visible then 'クーポン' else 'クーポン（止めた）' end, name, price, minutes,
         case target when 'new' then '新規' when 'repeat' then '再来' else '全員' end,
         '対象：' || coalesce(menu_name, '—') || case when coalesce(cardinality(weekdays), 0) > 0 then '／平日のみ' else '' end
    from cp
  union all
  select 2, m.sort_order, case when m.coupon_only then 'メニュー（クーポン専用）' when m.people >= 2 then 'メニュー（ペア）' else 'メニュー' end, m.name, m.price, m.duration_min, null,
         coalesce('略：' || m.short_name, '') || '／' || m.people || '名' || coalesce('／枠：' || l.name, '／枠：標準')
    from menus m join st on m.store_id = st.id left join lanes l on l.id = m.lane_id
   where coalesce(m.active, true) and m.web_visible
  union all
  select 3, m.sort_order, '止めたメニュー', m.name, m.price, m.duration_min, null, null
    from menus m join st on m.store_id = st.id where not coalesce(m.active, true)
) z order by sec, ord, name;
