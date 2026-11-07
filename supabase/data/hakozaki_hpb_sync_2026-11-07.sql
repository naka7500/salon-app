-- ラシエル箱崎：HPB（ホットペッパービューティー）掲載中のクーポン14件・メニュー8件に、salon-app のメニュー・クーポン・オプションを合わせる。
-- 出典：/home/claude/kokage_rep/hpb/hakozaki_hpb_2026-11-07.md（2026-11-07 23:10 取得。名前は全角・空白も含めてそのまま）
-- ※マイグレーションではありません（データの同期）。0001〜0017 が流れている DB に、Supabase の SQL Editor で1回流してください。
-- ※触るのは店舗 aaaaaaaa-0000-0000-0000-000000000001（ラシエル箱崎）だけ。他の店舗の行は1行も変えません。
-- ※何度流しても同じ結果（固定の ID で upsert）。行は消さない：HPB に無い古いメニュー・クーポン・オプショングループ・対応表は「止める」だけ。
-- 作り（要点）
--  ・HPB のクーポンは「技術メニュー1つ＋特別価格（fixed）」。所要時間はアプリでは対象メニューの時間（クーポンに時間の欄は無い）
--  ・HPB のメニュー8件：似合わせアイブロー・ホリスティックラッシュリフト＝技術メニュー、オフ4種＝オプション「オフ」（必須・1つ）、
--    アイシャンプー・眉カラー＝オプション「追加メニュー（単品不可）」（任意・複数可）＝単品では予約できない
--  ・クーポンの対象にするため、HPB にメニューとしては出ていない技術メニューを4つ作る（フラットマットラッシュ100本／120本、2つのセット）
--  ・クーポン9・10（アイシャンプー・眉カラー＝単品不可）は名前どおりの行を残すが、止めた状態（ネットにもレジにも出さない）。
--    実際の予約・会計はオプションのアイシャンプー・眉カラーで行う
--  ・準備・インターバルは0分（HPB の所要目安時間＝台帳でふさぐ時間）

begin;

do $$ begin
  if not exists (select 1 from stores where id = 'aaaaaaaa-0000-0000-0000-000000000001') then raise exception '店舗 aaaaaaaa-0000-0000-0000-000000000001（ラシエル箱崎）がありません'; end if;
  if to_regclass('public.option_groups') is null or to_regclass('public.hpb_mappings') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stores' and column_name = 'ledger_menu_ids') then
    raise exception '0009・0011・0014 が流れていません。先にマイグレーションを流してください';
  end if;
end $$;

-- 1) オプショングループ
insert into option_groups (id, store_id, name, description, required, multi, sort_order, active) values
  ('a5a10002-0b5a-4c05-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'オフ', '付替オフメニューはまつげメニューとセットで予約してください。', true, false, 1, true),
  ('a5a10002-0b5a-4c05-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', '追加メニュー（単品不可）', 'まつ毛・アイブロウメニューと一緒にご予約ください（単品でのご予約はできません）。', false, true, 2, true)
on conflict (id) do update set name = excluded.name, description = excluded.description, required = excluded.required, multi = excluded.multi,
  sort_order = excluded.sort_order, active = true
  where option_groups.store_id = excluded.store_id;

-- 2) メニュー（技術6・オプション6）
insert into menus (id, store_id, name, short_name, color, category, price, tax_rate, duration_min, interval_min, needs_resource, sort_order, active,
                   description, target, publish_from, publish_to, weekdays, time_from, time_to, lane_id, nominatable, web_visible,
                   people, option_group_id, option_group_ids) values
  ('a5a10001-0b5a-4c05-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '似合わせアイブロー☆ワックス脱毛１回※眉毛エクステとは異なります', '眉Wax', '#b57edc', 'technical', 6600, 0.10, 60, 0, true, 10, true,
   'ある日突然就活が上手くいきだした♪ある日突然周りから「最近可愛くなったね」と言われるようになった☆※眉毛エクステとは異なります', 'all', null, null, null, null, null, null, true, true, 1, null, array['a5a10002-0b5a-4c05-8000-000000000002']::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'ホリスティックラッシュリフト【オリジナルまつ毛パーマ】', 'パーマ', '#e8547a', 'technical', 6600, 0.10, 60, 0, true, 20, true,
   '化粧品登録の商材使用でダメージ軽減☆まつ毛に嬉しいケラチントリートメント付き！こだわりを持って施術致します。', 'all', null, null, null, null, null, null, true, true, 1, null, array['a5a10002-0b5a-4c05-8000-000000000002']::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'フラットマットラッシュ100本', '100本', '#2bb3a3', 'technical', 6600, 0.10, 50, 0, true, 30, true,
   'フラットでくぼみのある独特な形状により接着面が広く倒れにくいため持続性◎従来のエクステより1/3の重さで超軽量♪大人気ブラウンカラーも無料☆', 'all', null, null, null, null, null, null, true, true, 1, null, array['a5a10002-0b5a-4c05-8000-000000000001','a5a10002-0b5a-4c05-8000-000000000002']::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'フラットマットラッシュ120本', '120本', '#1f7f9a', 'technical', 7700, 0.10, 80, 0, true, 40, true,
   'フラットでくぼみのある独特な形状により接着面が広く倒れにくいため持続性◎従来のエクステより1/3の重さで超軽量♪大人気ブラウンカラーも無料☆', 'all', null, null, null, null, null, null, true, true, 1, null, array['a5a10002-0b5a-4c05-8000-000000000001','a5a10002-0b5a-4c05-8000-000000000002']::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'まつエク100本＋垢抜けアイブロウWax', 'エク100＋眉', '#c5d94b', 'technical', 12100, 0.10, 90, 0, true, 50, true,
   'フラットマットラッシュ100本と垢抜けアイブロウWaxのセットメニュー。単品でお受けいただくより￥1,100おトクです。3～4週間ごとのお手入れで、いつでも整った目元をキープ♪', 'all', null, null, null, null, null, null, true, true, 1, null, array['a5a10002-0b5a-4c05-8000-000000000001','a5a10002-0b5a-4c05-8000-000000000002']::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'アイブロウWax＋まつげパーマ', '眉＋パーマ', '#d9534f', 'technical', 13200, 0.10, 90, 0, true, 60, true,
   '垢抜けアイブロウWaxとまつげパーマのセットメニュー♪ナチュラルに垢抜けたい方・自然な仕上がりをご希望の方に大人気のメニューです☆', 'all', null, null, null, null, null, null, true, true, 1, null, array['a5a10002-0b5a-4c05-8000-000000000002']::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', 'オフ無し', 'オフ無し', '#bbbbbb', 'option', 0, 0.10, 10, 0, true, 101, true,
   null, 'all', null, null, null, null, null, null, true, true, 1, 'a5a10002-0b5a-4c05-8000-000000000001', '{}'::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', '【初回限定】他店オフ（３D・バインド・LEDは別途1100円）', '他店オフ(初回)', '#bbbbbb', 'option', 0, 0.10, 10, 0, true, 102, true,
   null, 'all', null, null, null, null, null, null, true, true, 1, 'a5a10002-0b5a-4c05-8000-000000000001', '{}'::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000001', '【２回目以降】当店オフ【オープン記念無料キャンペーン】', '当店オフ', '#bbbbbb', 'option', 0, 0.10, 10, 0, true, 103, true,
   null, 'all', null, null, null, null, null, null, true, true, 1, 'a5a10002-0b5a-4c05-8000-000000000001', '{}'::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000014', 'aaaaaaaa-0000-0000-0000-000000000001', '【２回目以降】他店オフ', '他店オフ', '#bbbbbb', 'option', 1100, 0.10, 10, 0, true, 104, true,
   null, 'all', null, null, null, null, null, null, true, true, 1, 'a5a10002-0b5a-4c05-8000-000000000001', '{}'::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000021', 'aaaaaaaa-0000-0000-0000-000000000001', '大人気！健康なまつ毛を保つ★【アイシャンプー】', 'アイシャン', '#bbbbbb', 'option', 1100, 0.10, 10, 0, true, 111, true,
   'まつ毛ダニの原因に！根元の落ちきれないメイク汚れと皮脂はエクステの持続力や自まつ毛の健康に影響します。汚れをすっきり落として美しさを★', 'all', null, null, null, null, null, null, true, true, 1, 'a5a10002-0b5a-4c05-8000-000000000002', '{}'::uuid[]),
  ('a5a10001-0b5a-4c05-8000-000000000022', 'aaaaaaaa-0000-0000-0000-000000000001', '眉カラー', '眉カラー', '#bbbbbb', 'option', 1100, 0.10, 10, 0, true, 112, true,
   '眉カラーのみのご予約不可。アイブロウデザインメニューと併用することで更に垢抜け感や、明るい髪色に合わせることもできます。', 'all', null, null, null, null, null, null, true, true, 1, 'a5a10002-0b5a-4c05-8000-000000000002', '{}'::uuid[])
on conflict (id) do update set name = excluded.name, short_name = excluded.short_name, color = excluded.color, category = excluded.category,
  price = excluded.price, tax_rate = excluded.tax_rate, duration_min = excluded.duration_min, interval_min = excluded.interval_min,
  needs_resource = excluded.needs_resource, sort_order = excluded.sort_order, active = true, description = excluded.description,
  target = excluded.target, publish_from = null, publish_to = null, weekdays = null, time_from = null, time_to = null, lane_id = null,
  nominatable = excluded.nominatable, web_visible = true, people = 1, option_group_id = excluded.option_group_id, option_group_ids = excluded.option_group_ids
  where menus.store_id = excluded.store_id;

-- 3) クーポン14件（HPB の掲載順・特別価格）
insert into coupons (id, store_id, name, description, kind, value, menu_ids, target, within_days, weekdays, time_from, time_to,
                     first_n, per_customer_limit, code, publish_from, publish_to, web_visible, sort_order, active, option_group_ids) values
  ('a5a10003-0b5a-4c05-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '【初回】まつエク100本＋垢抜け眉Wax　￥12,100→￥9,350',
   '軽くて自まつ毛に優しいフラットマットラッシュ100本と、骨格に合わせて整える垢抜けアイブロウWaxのセット。まつ毛と眉をまとめて整えると、朝のメイク時間がぐっと短くなります☆
【利用条件】初めてご来店される方・16歳以上の方／提示条件：予約時／有効期限：なし',
   'fixed', 9350, array['a5a10001-0b5a-4c05-8000-000000000005']::uuid[], 'new', null, null, null, null, null, null, null, null, null, true, 1, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', '人気NO.1♪アイブロウWax＋まつげパーマ　￥13,200→￥8,800',
   '垢抜けアイブロウWaxとまつげパーマのセットメニュー♪ナチュラルに垢抜けたい方・自然な仕上がりをご希望の方に大人気のメニューです☆
【利用条件】ご新規の方・16歳以上の方／提示条件：予約時／有効期限：なし',
   'fixed', 8800, array['a5a10001-0b5a-4c05-8000-000000000006']::uuid[], 'new', null, null, null, null, null, null, null, null, null, true, 2, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', '【束感まつげで可愛い目元】まつ毛パーマ　￥6,600→￥4,400',
   'お客様のお目元・瞼の形・ご希望に合わせて、厳選してデザインをご提案いたします。根元から立ち上げ～ナチュラルなカールまで目元のコンプレックスしてナチュラルで可愛い目元に♪
【利用条件】初回の方のみ／提示条件：予約時／有効期限：なし',
   'fixed', 4400, array['a5a10001-0b5a-4c05-8000-000000000002']::uuid[], 'new', null, null, null, null, null, null, null, null, null, true, 3, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', '【ナチュラル垢抜け♪】垢抜けアイブロウWax　￥6,600→￥4,400',
   '黄金比率を元にお客様のイメージや好みをカウンセリングしてデザインを決定し、WAXで不要な毛を除去します。毛量調節、メイクレクチャー付き♪ ※３～４週間は自己処理せずにご来店ください。
【利用条件】ご新規の方・16歳以上の方／提示条件：予約時／有効期限：なし',
   'fixed', 4400, array['a5a10001-0b5a-4c05-8000-000000000001']::uuid[], 'new', null, null, null, null, null, null, null, null, null, true, 4, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', '【目元まるごと垢抜け】まつエク100本＋アイブロウWax',
   'フラットマットラッシュ100本と垢抜けアイブロウWaxのセットメニュー。単品でお受けいただくより￥1,100おトクです。3～4週間ごとのお手入れで、いつでも整った目元をキープ♪
【利用条件】全員ご利用可能・16歳以上の方／提示条件：予約時／有効期限：なし',
   'fixed', 11000, array['a5a10001-0b5a-4c05-8000-000000000005']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 5, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', '人気NO.1♪アイブロウWax＋まつげパーマ',
   '垢抜けアイブロウWaxとをまつげパーマのセットメニュー♪メイクが苦手な方・ナチュラルに垢抜けたい方に大人気のメニューです☆今ならオープン価格でお得にご利用可能◎
【利用条件】全員ご利用可能（16歳以上の方）／提示条件：予約時／有効期限：なし',
   'fixed', 9900, array['a5a10001-0b5a-4c05-8000-000000000006']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 6, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', '【束感まつげで可愛い目元】まつ毛パーマ　￥6,600→￥5,500',
   'お客様のお目元・瞼の形・ご希望に合わせて、厳選してデザインをご提案いたします♪根元から立ち上げ～ナチュラルなカールまで目元のコンプレックスしてナチュラルで可愛い目元に♪
【利用条件】全員ご利用可能／提示条件：予約時／有効期限：なし',
   'fixed', 5500, array['a5a10001-0b5a-4c05-8000-000000000002']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 7, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001', '【ナチュラル垢抜け♪】垢抜けアイブロウWax　￥6,600→￥5,500',
   '黄金比率を元にお客様のイメージや好みをカウンセリングしてデザインを決定し、WAXで不要な毛を除去します。毛量調節、メイクレクチャー付き♪ ※３～４週間は自己処理せずにご来店ください
【利用条件】全員ご利用可能（16歳以上の方）／提示条件：予約時／有効期限：なし',
   'fixed', 5500, array['a5a10001-0b5a-4c05-8000-000000000001']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 8, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', '【単品不可】　目元の汚れもスッキリ☆アイシャンプー',
   '【まつ毛・アイブロウメニューとの併用クーポン】まつ毛ダニの原因に！根元の落ちきれないメイク汚れと皮脂はエクステの持続力や自まつ毛の健康に影響します。汚れをすっきり落として美しさを★
【利用条件】全員（まつ毛・アイブロウメニューとの併用）／提示条件：予約時／有効期限：なし',
   'fixed', 1100, array['a5a10001-0b5a-4c05-8000-000000000021']::uuid[], 'all', null, null, null, null, null, null, null, null, null, false, 9, false, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', '眉カラー☆  他、まつ毛メニュー・アイブロウメニューとの併用クーポン',
   '眉カラーのみのご予約不可。まつ毛メニューやアイブロウメニューと同時にお使い下さい。眉毛の色を少し明るくすることで、透明感が出たり垢抜け顔に☆
【利用条件】全員（眉カラーのみの予約不可）／提示条件：予約時／有効期限：なし',
   'fixed', 1100, array['a5a10001-0b5a-4c05-8000-000000000022']::uuid[], 'all', null, null, null, null, null, null, null, null, null, false, 10, false, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', '【フラットマットラッシュ100本】☆ブラウン無料',
   'フラットでくぼみのある独特な形状により接着面が広く倒れにくいため持続性◎従来のエクステより1/3の重さで超軽量♪大人気ブラウンカラーも無料☆
【利用条件】初めてご来店される方／提示条件：予約時／有効期限：なし',
   'fixed', 5500, array['a5a10001-0b5a-4c05-8000-000000000003']::uuid[], 'new', null, null, null, null, null, null, null, null, null, true, 11, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', '【フラットマットラッシュ120本】☆ブラウン無料',
   'フラットでくぼみのある独特な形状により接着面が広く倒れにくいため持続性◎従来のエクステより1/3の重さで超軽量♪大人気ブラウンカラーも無料☆
【利用条件】初めてご来店される方／提示条件：予約時／有効期限：なし',
   'fixed', 6600, array['a5a10001-0b5a-4c05-8000-000000000004']::uuid[], 'new', null, null, null, null, null, null, null, null, null, true, 12, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000001', '【フラットマットラッシュ100本】☆ブラウン無料',
   'フラットでくぼみのある独特な形状により接着面が広く倒れにくいため持続性◎従来のエクステより1/3の重さで超軽量♪大人気ブラウンカラーも無料☆
【利用条件】全員／提示条件：予約時／有効期限：なし',
   'fixed', 6600, array['a5a10001-0b5a-4c05-8000-000000000003']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 13, true, '{}'::uuid[]),
  ('a5a10003-0b5a-4c05-8000-000000000014', 'aaaaaaaa-0000-0000-0000-000000000001', '【フラットマットラッシュ120本】☆ブラウン無料',
   'フラットでくぼみのある独特な形状により接着面が広く倒れにくいため持続性◎従来のエクステより1/3の重さで超軽量♪大人気ブラウンカラーも無料☆
【利用条件】全員／提示条件：予約時／有効期限：なし',
   'fixed', 7700, array['a5a10001-0b5a-4c05-8000-000000000004']::uuid[], 'all', null, null, null, null, null, null, null, null, null, true, 14, true, '{}'::uuid[])
on conflict (id) do update set name = excluded.name, description = excluded.description, kind = excluded.kind, value = excluded.value,
  menu_ids = excluded.menu_ids, target = excluded.target, within_days = null, weekdays = null, time_from = null, time_to = null,
  first_n = null, per_customer_limit = null, code = null, publish_from = null, publish_to = null, web_visible = excluded.web_visible,
  sort_order = excluded.sort_order, active = excluded.active, option_group_ids = excluded.option_group_ids
  where coupons.store_id = excluded.store_id;

-- 4) HPB 予約メール取り込みの対応表（上から順に、最初に当てはまったもの。セット → 単品の順）
insert into hpb_mappings (id, store_id, kind, pattern, menu_id, people, sort_order, active) values
  ('a5a10004-0b5a-4c05-8000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '【初回】まつエク100本＋垢抜け眉Wax　￥12,100→￥9,350', 'a5a10001-0b5a-4c05-8000-000000000005', null, 1, true),
  ('a5a10004-0b5a-4c05-8000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '【目元まるごと垢抜け】まつエク100本＋アイブロウWax', 'a5a10001-0b5a-4c05-8000-000000000005', null, 2, true),
  ('a5a10004-0b5a-4c05-8000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '人気NO.1♪アイブロウWax＋まつげパーマ　￥13,200→￥8,800', 'a5a10001-0b5a-4c05-8000-000000000006', null, 3, true),
  ('a5a10004-0b5a-4c05-8000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '人気NO.1♪アイブロウWax＋まつげパーマ', 'a5a10001-0b5a-4c05-8000-000000000006', null, 4, true),
  ('a5a10004-0b5a-4c05-8000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '【フラットマットラッシュ120本】☆ブラウン無料', 'a5a10001-0b5a-4c05-8000-000000000004', null, 5, true),
  ('a5a10004-0b5a-4c05-8000-000000000006', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '【フラットマットラッシュ100本】☆ブラウン無料', 'a5a10001-0b5a-4c05-8000-000000000003', null, 6, true),
  ('a5a10004-0b5a-4c05-8000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '【束感まつげで可愛い目元】まつ毛パーマ　￥6,600→￥4,400', 'a5a10001-0b5a-4c05-8000-000000000002', null, 7, true),
  ('a5a10004-0b5a-4c05-8000-000000000008', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '【束間まつげで可愛い目元】まつ毛パーマ　￥6,600→￥4,400', 'a5a10001-0b5a-4c05-8000-000000000002', null, 8, true),
  ('a5a10004-0b5a-4c05-8000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '【束感まつげで可愛い目元】まつ毛パーマ　￥6,600→￥5,500', 'a5a10001-0b5a-4c05-8000-000000000002', null, 9, true),
  ('a5a10004-0b5a-4c05-8000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '【束間まつげで可愛い目元】まつ毛パーマ　￥6,600→￥5,500', 'a5a10001-0b5a-4c05-8000-000000000002', null, 10, true),
  ('a5a10004-0b5a-4c05-8000-000000000011', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '【ナチュラル垢抜け♪】垢抜けアイブロウWax　￥6,600→￥4,400', 'a5a10001-0b5a-4c05-8000-000000000001', null, 11, true),
  ('a5a10004-0b5a-4c05-8000-000000000012', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '【ナチュラル垢抜け♪】垢抜けアイブロウWax　￥6,600→￥5,500', 'a5a10001-0b5a-4c05-8000-000000000001', null, 12, true),
  ('a5a10004-0b5a-4c05-8000-000000000013', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '似合わせアイブロー☆ワックス脱毛１回※眉毛エクステとは異なります', 'a5a10001-0b5a-4c05-8000-000000000001', null, 13, true),
  ('a5a10004-0b5a-4c05-8000-000000000014', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', 'ホリスティックラッシュリフト【オリジナルまつ毛パーマ】', 'a5a10001-0b5a-4c05-8000-000000000002', null, 14, true),
  ('a5a10004-0b5a-4c05-8000-000000000015', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', 'まつエク100本', 'a5a10001-0b5a-4c05-8000-000000000005', null, 15, true),
  ('a5a10004-0b5a-4c05-8000-000000000016', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', 'アイブロウWax＋まつげパーマ', 'a5a10001-0b5a-4c05-8000-000000000006', null, 16, true),
  ('a5a10004-0b5a-4c05-8000-000000000017', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', 'フラットマットラッシュ120本', 'a5a10001-0b5a-4c05-8000-000000000004', null, 17, true),
  ('a5a10004-0b5a-4c05-8000-000000000018', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', 'フラットマットラッシュ100本', 'a5a10001-0b5a-4c05-8000-000000000003', null, 18, true),
  ('a5a10004-0b5a-4c05-8000-000000000019', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', 'ホリスティックラッシュリフト', 'a5a10001-0b5a-4c05-8000-000000000002', null, 19, true),
  ('a5a10004-0b5a-4c05-8000-000000000020', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', 'まつ毛パーマ', 'a5a10001-0b5a-4c05-8000-000000000002', null, 20, true),
  ('a5a10004-0b5a-4c05-8000-000000000021', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '似合わせアイブロー', 'a5a10001-0b5a-4c05-8000-000000000001', null, 21, true),
  ('a5a10004-0b5a-4c05-8000-000000000022', 'aaaaaaaa-0000-0000-0000-000000000001', 'menu', '垢抜けアイブロウWax', 'a5a10001-0b5a-4c05-8000-000000000001', null, 22, true)
on conflict (id) do update set kind = 'menu', pattern = excluded.pattern, menu_id = excluded.menu_id, people = null,
  sort_order = excluded.sort_order, active = true
  where hpb_mappings.store_id = excluded.store_id;

-- 5) HPB に無い古い行は止める（消さない：テスト予約・売上から参照されていても安全）
update menus set active = false, web_visible = false
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000001' and id <> all(array['a5a10001-0b5a-4c05-8000-000000000001','a5a10001-0b5a-4c05-8000-000000000002','a5a10001-0b5a-4c05-8000-000000000003','a5a10001-0b5a-4c05-8000-000000000004','a5a10001-0b5a-4c05-8000-000000000005','a5a10001-0b5a-4c05-8000-000000000006','a5a10001-0b5a-4c05-8000-000000000011','a5a10001-0b5a-4c05-8000-000000000012','a5a10001-0b5a-4c05-8000-000000000013','a5a10001-0b5a-4c05-8000-000000000014','a5a10001-0b5a-4c05-8000-000000000021','a5a10001-0b5a-4c05-8000-000000000022']::uuid[]) and (coalesce(active, true) or web_visible);
update coupons set active = false, web_visible = false
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000001' and id <> all(array['a5a10003-0b5a-4c05-8000-000000000001','a5a10003-0b5a-4c05-8000-000000000002','a5a10003-0b5a-4c05-8000-000000000003','a5a10003-0b5a-4c05-8000-000000000004','a5a10003-0b5a-4c05-8000-000000000005','a5a10003-0b5a-4c05-8000-000000000006','a5a10003-0b5a-4c05-8000-000000000007','a5a10003-0b5a-4c05-8000-000000000008','a5a10003-0b5a-4c05-8000-000000000009','a5a10003-0b5a-4c05-8000-000000000010','a5a10003-0b5a-4c05-8000-000000000011','a5a10003-0b5a-4c05-8000-000000000012','a5a10003-0b5a-4c05-8000-000000000013','a5a10003-0b5a-4c05-8000-000000000014']::uuid[]) and (active or web_visible);
update option_groups set active = false
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000001' and id <> all(array['a5a10002-0b5a-4c05-8000-000000000001','a5a10002-0b5a-4c05-8000-000000000002']::uuid[]) and active;
update hpb_mappings set active = false
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000001' and kind = 'menu' and id <> all(array['a5a10004-0b5a-4c05-8000-000000000001','a5a10004-0b5a-4c05-8000-000000000002','a5a10004-0b5a-4c05-8000-000000000003','a5a10004-0b5a-4c05-8000-000000000004','a5a10004-0b5a-4c05-8000-000000000005','a5a10004-0b5a-4c05-8000-000000000006','a5a10004-0b5a-4c05-8000-000000000007','a5a10004-0b5a-4c05-8000-000000000008','a5a10004-0b5a-4c05-8000-000000000009','a5a10004-0b5a-4c05-8000-000000000010','a5a10004-0b5a-4c05-8000-000000000011','a5a10004-0b5a-4c05-8000-000000000012','a5a10004-0b5a-4c05-8000-000000000013','a5a10004-0b5a-4c05-8000-000000000014','a5a10004-0b5a-4c05-8000-000000000015','a5a10004-0b5a-4c05-8000-000000000016','a5a10004-0b5a-4c05-8000-000000000017','a5a10004-0b5a-4c05-8000-000000000018','a5a10004-0b5a-4c05-8000-000000000019','a5a10004-0b5a-4c05-8000-000000000020','a5a10004-0b5a-4c05-8000-000000000021','a5a10004-0b5a-4c05-8000-000000000022']::uuid[]) and active;
-- いつものメニュー（対応が無いとき）が止めたメニューなら外す
update hpb_settings set default_menu_id = null
 where store_id = 'aaaaaaaa-0000-0000-0000-000000000001' and default_menu_id is not null and default_menu_id <> all(array['a5a10001-0b5a-4c05-8000-000000000001','a5a10001-0b5a-4c05-8000-000000000002','a5a10001-0b5a-4c05-8000-000000000003','a5a10001-0b5a-4c05-8000-000000000004','a5a10001-0b5a-4c05-8000-000000000005','a5a10001-0b5a-4c05-8000-000000000006','a5a10001-0b5a-4c05-8000-000000000011','a5a10001-0b5a-4c05-8000-000000000012','a5a10001-0b5a-4c05-8000-000000000013','a5a10001-0b5a-4c05-8000-000000000014','a5a10001-0b5a-4c05-8000-000000000021','a5a10001-0b5a-4c05-8000-000000000022']::uuid[]);
-- 予約台帳の上のチップ：100本・120本・眉Wax・パーマ・眉＋パーマ・エク100＋眉
update stores set ledger_menu_ids = array['a5a10001-0b5a-4c05-8000-000000000003','a5a10001-0b5a-4c05-8000-000000000004','a5a10001-0b5a-4c05-8000-000000000001','a5a10001-0b5a-4c05-8000-000000000002','a5a10001-0b5a-4c05-8000-000000000006','a5a10001-0b5a-4c05-8000-000000000005']::uuid[]
 where id = 'aaaaaaaa-0000-0000-0000-000000000001';

-- 6) 確認（足りなければ全部取り消し）
do $$
declare n_m int; n_c int; n_g int; n_h int;
begin
  select count(*) into n_m from menus where store_id = 'aaaaaaaa-0000-0000-0000-000000000001' and id = any(array['a5a10001-0b5a-4c05-8000-000000000001','a5a10001-0b5a-4c05-8000-000000000002','a5a10001-0b5a-4c05-8000-000000000003','a5a10001-0b5a-4c05-8000-000000000004','a5a10001-0b5a-4c05-8000-000000000005','a5a10001-0b5a-4c05-8000-000000000006','a5a10001-0b5a-4c05-8000-000000000011','a5a10001-0b5a-4c05-8000-000000000012','a5a10001-0b5a-4c05-8000-000000000013','a5a10001-0b5a-4c05-8000-000000000014','a5a10001-0b5a-4c05-8000-000000000021','a5a10001-0b5a-4c05-8000-000000000022']::uuid[]) and active and web_visible;
  select count(*) into n_c from coupons where store_id = 'aaaaaaaa-0000-0000-0000-000000000001' and id = any(array['a5a10003-0b5a-4c05-8000-000000000001','a5a10003-0b5a-4c05-8000-000000000002','a5a10003-0b5a-4c05-8000-000000000003','a5a10003-0b5a-4c05-8000-000000000004','a5a10003-0b5a-4c05-8000-000000000005','a5a10003-0b5a-4c05-8000-000000000006','a5a10003-0b5a-4c05-8000-000000000007','a5a10003-0b5a-4c05-8000-000000000008','a5a10003-0b5a-4c05-8000-000000000009','a5a10003-0b5a-4c05-8000-000000000010','a5a10003-0b5a-4c05-8000-000000000011','a5a10003-0b5a-4c05-8000-000000000012','a5a10003-0b5a-4c05-8000-000000000013','a5a10003-0b5a-4c05-8000-000000000014']::uuid[]);
  select count(*) into n_g from option_groups where store_id = 'aaaaaaaa-0000-0000-0000-000000000001' and id in ('a5a10002-0b5a-4c05-8000-000000000001', 'a5a10002-0b5a-4c05-8000-000000000002') and active;
  select count(*) into n_h from hpb_mappings where store_id = 'aaaaaaaa-0000-0000-0000-000000000001' and id = any(array['a5a10004-0b5a-4c05-8000-000000000001','a5a10004-0b5a-4c05-8000-000000000002','a5a10004-0b5a-4c05-8000-000000000003','a5a10004-0b5a-4c05-8000-000000000004','a5a10004-0b5a-4c05-8000-000000000005','a5a10004-0b5a-4c05-8000-000000000006','a5a10004-0b5a-4c05-8000-000000000007','a5a10004-0b5a-4c05-8000-000000000008','a5a10004-0b5a-4c05-8000-000000000009','a5a10004-0b5a-4c05-8000-000000000010','a5a10004-0b5a-4c05-8000-000000000011','a5a10004-0b5a-4c05-8000-000000000012','a5a10004-0b5a-4c05-8000-000000000013','a5a10004-0b5a-4c05-8000-000000000014','a5a10004-0b5a-4c05-8000-000000000015','a5a10004-0b5a-4c05-8000-000000000016','a5a10004-0b5a-4c05-8000-000000000017','a5a10004-0b5a-4c05-8000-000000000018','a5a10004-0b5a-4c05-8000-000000000019','a5a10004-0b5a-4c05-8000-000000000020','a5a10004-0b5a-4c05-8000-000000000021','a5a10004-0b5a-4c05-8000-000000000022']::uuid[]) and active;
  if n_m <> 12 or n_c <> 14 or n_g <> 2 or n_h <> 22 then
    raise exception '同期が不完全です（menus %/12, coupons %/14, groups %/2, mappings %/22）。ID が他の店舗と重なっていないか確認してください', n_m, n_c, n_g, n_h;
  end if;
  if exists (select 1 from coupons c join menus m on m.id = c.menu_ids[1] where c.store_id = 'aaaaaaaa-0000-0000-0000-000000000001' and c.web_visible and c.active
              and (m.category <> 'technical' or not m.web_visible or not coalesce(m.active, true))) then
    raise exception 'ネット掲載のクーポンの対象メニューが予約できない状態です';
  end if;
end $$;

-- 6b) 0018（メニューの「クーポン専用」）が流れていれば、クーポン対象として作った4つ（100本・120本・2つのセット）をクーポン専用にする。
--     0018 の前に流したときは、0018 の最後で同じことをするので、どちらの順でも同じ結果になります。
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'menus' and column_name = 'coupon_only') then
    execute $q$update menus set coupon_only = true
      where store_id = 'aaaaaaaa-0000-0000-0000-000000000001'
        and id in ('a5a10001-0b5a-4c05-8000-000000000003', 'a5a10001-0b5a-4c05-8000-000000000004', 'a5a10001-0b5a-4c05-8000-000000000005', 'a5a10001-0b5a-4c05-8000-000000000006')
        and not coupon_only$q$;
  end if;
end $$;

commit;

-- 7) 結果の一覧（section ごと：件数 → ネットに出るクーポン → 技術メニュー → オプション → 止めた行）
with st as (select 'aaaaaaaa-0000-0000-0000-000000000001'::uuid as id),
cp as (
  select c.sort_order, c.name, c.value as price, m.duration_min as minutes, c.target, c.web_visible, c.active, m.name as menu_name
    from coupons c join st on c.store_id = st.id left join menus m on m.id = c.menu_ids[1]
)
select * from (
  select 0 as sec, 0 as ord, '件数' as section,
         format('ネット掲載クーポン %s／技術メニュー(掲載) %s／オプション(掲載) %s／オプショングループ %s／HPB対応表 %s／止めたメニュー %s',
           (select count(*) from coupons c, st where c.store_id = st.id and c.active and c.web_visible),
           (select count(*) from menus m, st where m.store_id = st.id and coalesce(m.active, true) and m.web_visible and m.category = 'technical'),
           (select count(*) from menus m, st where m.store_id = st.id and coalesce(m.active, true) and m.web_visible and m.category = 'option'),
           (select count(*) from option_groups g, st where g.store_id = st.id and g.active),
           (select count(*) from hpb_mappings h, st where h.store_id = st.id and h.kind = 'menu' and h.active),
           (select count(*) from menus m, st where m.store_id = st.id and not coalesce(m.active, true))) as name,
         null::int as price, null::int as minutes, null::text as target, null::text as note
  union all
  select 1, sort_order, case when active and web_visible then 'クーポン' else 'クーポン（止めた）' end, name, price, minutes,
         case target when 'new' then '新規' when 'repeat' then '再来' else '全員' end, '対象：' || coalesce(menu_name, '—')
    from cp
  union all
  select 2, m.sort_order, case when m.category = 'technical' then 'メニュー' else 'オプション' end, m.name, m.price, m.duration_min, null,
         coalesce('略：' || m.short_name, '') || coalesce('／' || g.name, '')
           || coalesce('／付けられる：' || (select string_agg(x.name, '・' order by x.sort_order) from option_groups x where x.id = any(m.option_group_ids)), '')
    from menus m join st on m.store_id = st.id left join option_groups g on g.id = m.option_group_id
   where coalesce(m.active, true) and m.web_visible
  union all
  select 3, m.sort_order, '止めたメニュー', m.name, m.price, m.duration_min, null, null
    from menus m join st on m.store_id = st.id where not coalesce(m.active, true)
) z order by sec, ord, name;
