-- 0026：ネット予約の受け方（LINEの中だけ／LINEとWebの両方）と、LINEの「予約完了のお知らせ」（監査 2026-11-15 S1・S4）
-- 決まったこと：
--  1) stores.web_booking_line_only：true＝「LINEの中だけ」。LINE以外のブラウザからの予約（public_create_booking＝anon）は DB が断る（'line_only'）。
--     ・「受け付けない」＝web_booking_enabled=false（今までどおり）／「LINEとWebの両方」＝web_booking_enabled=true かつ line_only=false
--     ・いまある店舗は false のまま（＝今の動きを変えない）。ただし 店舗 aaaaaaaa-…0001（ラシエル箱崎）だけは、
--       この列を初めて作るときに true にする（12/1 は LINE だけ公開のため。あとで 設定＞店舗・ネット予約 で変えられる。流し直しても上書きしない）
--     ・これから作る店舗の既定は true（安全側）
--     ・LINEの中の予約（サーバ /api/line/book → service_create_booking。LINE が本人を確かめたあと）は今までどおり通る
--  2) public_store_info：予約ページに 'line_only' を返す（LINEの外で開いた人に「LINEからご予約ください」を出すため）
--  3) line_channels.booked_enabled：LINE予約が成立したとき、その人の LINE に「予約完了のお知らせ」を1通送るか。既定は false（オンにするのはオーナー）
--     （同じ予約に1回だけ：サーバが line_messages の記録と LINE の再送キー＝予約ID で確かめる。DB の変更はこの列だけ）
-- ※必ず 0022（0015 も）の後に流すこと（無いと最初で止まります。DBは何も変わりません）。
-- ※何度流しても同じ（if not exists / create or replace / drop ... if exists）。
-- ※0026 が未適用でもアプリは落ちない（受け方の切り替えが「準備中」になり、今までどおり LINE と Web の両方で受ける。予約完了のお知らせは送らない）。

begin;

do $$ begin
  if to_regprocedure('public.service_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[], text, text)') is null
     or to_regprocedure('public._create_booking_impl(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[], text, text)') is null then
    raise exception '0022 が流れていません。先に 0022_line_identity.sql を流してから、もう一度 0026 を流してください（DBは何も変わっていません）';
  end if;
  if to_regclass('public.line_channels') is null then
    raise exception '0015 が流れていません。先に 0015_line.sql を流してから、もう一度 0026 を流してください（DBは何も変わっていません）';
  end if;
end $$;

-- =========================================================
-- 1) 受け方：LINEの中だけ
-- =========================================================
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'stores' and column_name = 'web_booking_line_only') then
    alter table stores add column web_booking_line_only boolean not null default false;
    -- 初めて作るときだけ：ラシエル箱崎は「LINEの中だけ」（流し直しでは変えない＝設定画面で変えた内容を守る）
    update stores set web_booking_line_only = true where id = 'aaaaaaaa-0000-0000-0000-000000000001';
  end if;
end $$;
alter table stores alter column web_booking_line_only set default true;
comment on column stores.web_booking_line_only is '0026：true＝ネット予約は LINE の中（LIFF）だけ。LINE以外のブラウザからの予約は public_create_booking が断る。web_booking_enabled=false なら全部受け付けない';

-- 予約ページに返す店舗の情報（0007 と同じ内容＋line_only）
create or replace function public_store_info(p_slug text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('slug', slug, 'name', name, 'name_en', name_en, 'business_type', business_type, 'phone', phone, 'address', address,
    'logo_url', logo_url, 'photo_url', photo_url, 'web_message', web_message, 'cancel_policy', cancel_policy,
    'cancel_deadline_days', cancel_deadline_days, 'cancel_deadline_time', to_char(cancel_deadline_time, 'HH24:MI'),
    'booking_horizon_days', booking_horizon_days, 'slot_minutes', slot_minutes, 'intake_questions', intake_questions,
    'today', to_char((now() at time zone coalesce(timezone, 'Asia/Tokyo'))::date, 'YYYY-MM-DD'),
    'line_only', web_booking_line_only)   -- ★0026
  from stores where slug = lower(btrim(p_slug)) and web_booking_enabled
$$;
revoke all on function public_store_info(text) from public;
grant execute on function public_store_info(text) to anon, authenticated;

-- ブラウザのネット予約（anon）：「LINEの中だけ」の店舗では断る。それ以外は 0022 と同じ（_create_booking_impl へ）
create or replace function public_create_booking(
  p_slug text, p_menu uuid, p_start timestamptz, p_name text, p_kana text, p_phone text, p_email text,
  p_intake jsonb default '[]'::jsonb, p_coupon uuid default null, p_code text default null, p_staff uuid default null, p_lang text default 'ja',
  p_options uuid[] default null
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  -- ★0026：LINE が本人を確かめていない予約は受けない（LINEの中の予約は service_create_booking から入る）
  if exists (select 1 from stores where slug = lower(btrim(p_slug)) and web_booking_enabled and web_booking_line_only) then
    raise exception 'line_only';
  end if;
  return _create_booking_impl(p_slug, p_menu, p_start, p_name, p_kana, p_phone, p_email, p_intake, p_coupon, p_code, p_staff, p_lang, p_options, null, null);
end $$;
revoke all on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[]) from public;
grant execute on function public_create_booking(text, uuid, timestamptz, text, text, text, text, jsonb, uuid, text, uuid, text, uuid[]) to anon, authenticated;

-- =========================================================
-- 2) LINE の「予約完了のお知らせ」（既定はオフ）
-- =========================================================
alter table line_channels add column if not exists booked_enabled boolean not null default false;
comment on column line_channels.booked_enabled is '0026：LINE予約が成立したとき、その人の LINE に予約内容とキャンセルの方法を1通送る。既定は false。「LINE連携を使う」がオフなら送らない';
grant insert (booked_enabled) on line_channels to authenticated;
grant update (booked_enabled) on line_channels to authenticated;

-- 未ログイン（anon）からは表を一切触れないように（念のため付け直す）
revoke all on all tables in schema public from anon;

notify pgrst, 'reload schema';

commit;

-- 確認用（Run の結果に出る）
select '0026 OK：ネット予約の受け方（LINEの中だけ／両方）と、LINEの予約完了のお知らせ（既定オフ）を用意しました。LINEの中だけの店舗：'
       || coalesce((select string_agg(name, '・' order by name) from stores where web_booking_line_only and web_booking_enabled), '（なし）') as result,
       (select count(*) from stores where web_booking_line_only) as line_only_stores,
       (select count(*) from line_channels where booked_enabled) as booked_notice_on;
