-- 0017：LINE連携のスイッチがオフの間も、LINEの中の予約ページでログイン＝お客様とLINEをつなぐ（何も送らない）
-- 増美さん 2026-11-07：オフのあいだに予約した人も、オンにした日から前日確認などが届くように
create or replace function public_line_info(p_slug text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('liff_id', c.liff_id, 'basic_id', c.bot_basic_id)
    from stores s join line_channels c on c.store_id = s.id
   where s.slug = lower(btrim(p_slug)) and s.web_booking_enabled and c.liff_id is not null
$$;
grant execute on function public_line_info(text) to anon, authenticated;
select '0017 OK：LINE連携オフの間もLINEログインでつなぎます（送信はしません）' as result;
