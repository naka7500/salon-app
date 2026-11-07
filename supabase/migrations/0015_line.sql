-- フェーズD：LINE連携（方式A：店舗ごとの LINE公式アカウント＋Messaging API＋LIFF）。
-- ※必ず 0014_security_checkout.sql の後に流すこと（0014 が無いと最初で止まります。DBは何も変わりません）。
-- 何度流しても安全（if not exists / create or replace / drop ... if exists）。
-- 0015 が未適用でもアプリは落ちない（設定＞LINE連携 が「準備中」、台帳・会計・顧客の LINE の表示が出ないだけ）。
--
-- 安全のための決まり
--  ・全部オフで始まる（店舗ごとの「LINE連携を使う」・前日確認・再来案内・自動のお礼返信、どれも既定はオフ）
--  ・チャネルシークレット・チャネルアクセストークンは line_channel_secrets に置き、サーバ（サービスキー）しか読めない。
--    画面からは line_set_credentials() で「書くだけ」（読み返せない）。送信ログ（line_messages）に秘密は入れない
--
-- やること
--  1) line_channels：店舗ごとの設定（秘密以外）。見る＝同じ会社のスタッフ、書く＝owner・manager
--  2) line_channel_secrets：秘密（サーバだけ）
--  3) line_links：お客様 ⇔ LINE のユーザーID（友だち追加・ブロック・お知らせ停止）
--  4) line_link_tokens：会計のQRの合言葉（30分・1回だけ。ハッシュだけ保存）
--  5) line_messages：受信・送信の記録（受信箱）。line_send_queue：送信待ち（同じ内容は1回だけ＝dedupe_key）
--  6) bookings.line_confirm：前日確認の返事（ok＝予定どおり／change＝変更したい）。menus.revisit_days：再来案内の日数
--  7) 関数：秘密を書く・QRの合言葉を作る・お知らせ停止・受信箱の対応済み・テスト送信先・ネット予約ページ用の LIFF ID
--  8) 未ログイン（anon）からは表を触れない（public_line_info だけ呼べる）

do $$ begin
  if to_regprocedure('public.create_sale(uuid,jsonb,uuid)') is null or to_regprocedure('public.can_write_store(uuid)') is null then
    raise exception '0014 がまだ流れていません。先に 0014_security_checkout.sql を流してから、この 0015 を流してください';
  end if;
end $$;

-- =========================================================
-- 1) 店舗ごとの設定（秘密は入れない）
-- =========================================================
create table if not exists line_channels (
  store_id uuid primary key references stores(id) on delete cascade,
  enabled boolean not null default false,                 -- LINE連携を使う（オフの間は何も送らない）
  channel_id text,                                         -- Messaging API のチャネルID
  login_channel_id text,                                   -- LINEログインのチャネルID（LIFF のIDトークンの確認に使う）
  liff_id text,
  bot_basic_id text, bot_name text,                        -- 接続テストで取った表示名・@ID
  secret_set_at timestamptz, token_set_at timestamptz,     -- 秘密を保存した日時（中身は line_channel_secrets）
  confirm_enabled boolean not null default false, confirm_time time not null default '18:00',
  revisit_enabled boolean not null default false, revisit_time time not null default '11:00',
  revisit_vacancy_only boolean not null default false, vacancy_threshold int not null default 50,
  ack_enabled boolean not null default false,
  templates jsonb not null default '{}',
  plan_limit int not null default 200,                     -- 月の無料メッセージ数（プランに合わせて変える。要確認）
  test_line_user_id text,                                  -- 「自分に試し送信」の送り先（オーナーのLINE）
  quota_value int, quota_usage int, quota_checked_at timestamptz,
  last_test_at timestamptz, last_test_result text,
  updated_at timestamptz not null default now()
);
alter table line_channels drop constraint if exists line_channels_vals_check;
alter table line_channels add constraint line_channels_vals_check check (
  plan_limit between 0 and 10000000 and vacancy_threshold between 0 and 100 and length(templates::text) <= 20000
  and (channel_id is null or channel_id ~ '^[0-9]{5,20}$') and (login_channel_id is null or login_channel_id ~ '^[0-9]{5,20}$')
  and (liff_id is null or liff_id ~ '^[0-9]{5,20}-[A-Za-z0-9]{4,20}$'));

-- =========================================================
-- 2) 秘密（サーバ＝サービスキーだけが読む。方針なし＝ログインした人も読めない）
-- =========================================================
create table if not exists line_channel_secrets (
  store_id uuid primary key references stores(id) on delete cascade,
  channel_secret text, access_token text,
  updated_at timestamptz not null default now()
);
alter table line_channel_secrets enable row level security;
revoke all on line_channel_secrets from anon, authenticated;

-- =========================================================
-- 3) お客様 ⇔ LINE
-- =========================================================
create table if not exists line_links (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  line_user_id text not null,
  display_name text,
  followed boolean not null default true,
  opted_out boolean not null default false,
  opt_out_reason text check (opt_out_reason is null or opt_out_reason in ('unfollow', 'customer', 'staff')),
  opted_out_at timestamptz, linked_at timestamptz, followed_at timestamptz, unfollowed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (store_id, line_user_id)
);
create unique index if not exists line_links_customer_key on line_links (store_id, customer_id) where customer_id is not null;

-- =========================================================
-- 4) 会計のQRの合言葉（30分・1回だけ。合言葉そのものは保存しない）
-- =========================================================
create table if not exists line_link_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  store_id uuid not null references stores(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  created_by uuid references staff(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  used_at timestamptz, used_line_user_id text
);
create index if not exists line_link_tokens_store_idx on line_link_tokens (store_id, created_at desc);

-- =========================================================
-- 5) 受信・送信の記録／送信待ち
-- =========================================================
create table if not exists line_messages (
  id bigserial primary key,
  store_id uuid not null references stores(id) on delete cascade,
  line_user_id text, customer_id uuid references customers(id) on delete set null, booking_id uuid references bookings(id) on delete set null,
  direction text not null check (direction in ('in', 'out')),
  kind text not null,                                       -- message / follow / unfollow / postback / confirm / revisit / reply / ack / test / optout
  text text,
  status text not null default 'received' check (status in ('received', 'sent', 'failed', 'demo', 'skipped')),
  counted boolean not null default false,                   -- 月の通数に数える送信（push）
  error text, event_id text,
  handled_at timestamptz, handled_by uuid references staff(id) on delete set null, handled_by_name text,
  created_at timestamptz not null default now()
);
create unique index if not exists line_messages_event_key on line_messages (store_id, event_id) where event_id is not null;
create index if not exists line_messages_store_idx on line_messages (store_id, created_at desc);

create table if not exists line_send_queue (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id) on delete cascade,
  kind text not null check (kind in ('confirm', 'revisit', 'test')),
  dedupe_key text not null unique,                          -- 同じ予約の前日確認・同じ回の再来案内は1回だけ
  booking_id uuid references bookings(id) on delete set null, customer_id uuid references customers(id) on delete set null,
  line_user_id text not null,
  payload jsonb not null,                                   -- 送るメッセージ（秘密は入れない）
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts int not null default 0, error text,
  scheduled_at timestamptz not null default now(), sent_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists line_send_queue_q_idx on line_send_queue (status, scheduled_at) where status in ('queued', 'sending');
create index if not exists line_send_queue_store_idx on line_send_queue (store_id, created_at desc);

-- =========================================================
-- 6) 予約の前日確認の返事・メニューの再来案内の日数・通知の種類
-- =========================================================
alter table bookings add column if not exists line_confirm text;
alter table bookings add column if not exists line_confirm_at timestamptz;
alter table bookings drop constraint if exists bookings_line_confirm_check;
alter table bookings add constraint bookings_line_confirm_check check (line_confirm is null or line_confirm in ('ok', 'change'));
alter table menus add column if not exists revisit_days int;
alter table menus drop constraint if exists menus_revisit_days_check;
alter table menus add constraint menus_revisit_days_check check (revisit_days is null or revisit_days between 1 and 365);
alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check check (kind in ('new_booking', 'cancel_booking', 'booking_confirmation', 'cancel_confirmation', 'hpb_booking', 'hpb_change', 'hpb_cancel', 'hpb_attention', 'line_change', 'line_message'));

-- =========================================================
-- 7) RLS
-- =========================================================
alter table line_channels enable row level security;
alter table line_links enable row level security;
alter table line_link_tokens enable row level security;
alter table line_messages enable row level security;
alter table line_send_queue enable row level security;
drop policy if exists line_channels_sel on line_channels;
drop policy if exists line_channels_ins on line_channels;
drop policy if exists line_channels_upd on line_channels;
drop policy if exists line_channels_del on line_channels;
drop policy if exists line_links_sel on line_links;
drop policy if exists line_messages_sel on line_messages;
drop policy if exists line_send_queue_sel on line_send_queue;
create policy line_channels_sel on line_channels for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy line_channels_ins on line_channels for insert with check (is_store_admin(store_id));
create policy line_channels_upd on line_channels for update using (is_store_admin(store_id)) with check (is_store_admin(store_id));
create policy line_channels_del on line_channels for delete using (is_store_admin(store_id));
create policy line_links_sel on line_links for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy line_messages_sel on line_messages for select using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy line_send_queue_sel on line_send_queue for select using (is_store_admin(store_id));
revoke all on line_channels, line_links, line_link_tokens, line_messages, line_send_queue from anon;
revoke all on line_link_tokens from authenticated;
revoke insert, update, delete, truncate on line_links, line_messages, line_send_queue from authenticated;
grant select on line_links, line_messages, line_send_queue to authenticated;
-- 画面から書けるのは設定の列だけ（秘密の保存日時・接続テストの結果・テスト送信先は関数・サーバだけが書く）
revoke insert, update on line_channels from authenticated;
grant select, delete on line_channels to authenticated;
grant insert (store_id, enabled, channel_id, login_channel_id, liff_id, confirm_enabled, confirm_time, revisit_enabled, revisit_time, revisit_vacancy_only, vacancy_threshold, ack_enabled, templates, plan_limit, updated_at) on line_channels to authenticated;
grant update (enabled, channel_id, login_channel_id, liff_id, confirm_enabled, confirm_time, revisit_enabled, revisit_time, revisit_vacancy_only, vacancy_threshold, ack_enabled, templates, plan_limit, updated_at) on line_channels to authenticated;

-- =========================================================
-- 8) 関数
-- =========================================================
-- 秘密を書く（owner・manager）。null＝変えない、''＝消す。読み返す関数は作らない
create or replace function line_set_credentials(p_store uuid, p_secret text, p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r line_channels;
begin
  if not is_store_admin(p_store) then raise exception 'forbidden'; end if;
  if p_secret is not null and p_secret <> '' and p_secret !~ '^[0-9a-f]{32}$' then raise exception 'invalid_secret'; end if;
  if p_token is not null and p_token <> '' and (length(p_token) < 40 or length(p_token) > 400 or p_token ~ '\s') then raise exception 'invalid_token'; end if;
  insert into line_channels (store_id) values (p_store) on conflict (store_id) do nothing;
  insert into line_channel_secrets (store_id) values (p_store) on conflict (store_id) do nothing;
  if p_secret is not null then update line_channel_secrets set channel_secret = nullif(p_secret, ''), updated_at = now() where store_id = p_store; end if;
  if p_token is not null then update line_channel_secrets set access_token = nullif(p_token, ''), updated_at = now() where store_id = p_store; end if;
  update line_channels set
    secret_set_at = case when p_secret is null then secret_set_at when p_secret = '' then null else now() end,
    token_set_at = case when p_token is null then token_set_at when p_token = '' then null else now() end,
    enabled = case when (p_secret = '' or p_token = '') then false else enabled end,      -- 消したら自動でオフ
    updated_at = now()
  where store_id = p_store returning * into r;
  return jsonb_build_object('secret_set_at', r.secret_set_at, 'token_set_at', r.token_set_at, 'enabled', r.enabled);
end $$;

-- 会計のQRの合言葉（viewer 以外。30分・1回だけ）。合言葉はここで1回だけ返す（DBにはハッシュだけ）
create or replace function line_create_link_token(p_store uuid, p_customer uuid) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare tok text; me uuid;
begin
  if not can_write_store(p_store) then raise exception 'forbidden'; end if;
  if not exists (select 1 from customers c join stores s on s.company_id = c.company_id where c.id = p_customer and s.id = p_store) then raise exception 'customer_not_found'; end if;
  if (select count(*) from line_link_tokens where store_id = p_store and created_at > now() - interval '10 minutes') >= 60 then raise exception 'too_many'; end if;
  select s.id into me from staff s join stores st on st.company_id = s.company_id where st.id = p_store and s.auth_user_id = auth.uid() limit 1;
  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into line_link_tokens (token_hash, store_id, customer_id, created_by) values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), p_store, p_customer, me);
  delete from line_link_tokens where expires_at < now() - interval '7 days';
  return tok;
end $$;

-- お知らせ停止（止めるのは viewer 以外、再開は owner・manager）
create or replace function line_set_opt_out(p_link uuid, p_opt boolean) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare l line_links;
begin
  select * into l from line_links where id = p_link;
  if l.id is null then raise exception 'not_found'; end if;
  if p_opt and not can_write_store(l.store_id) then raise exception 'forbidden'; end if;
  if not p_opt and not is_store_admin(l.store_id) then raise exception 'forbidden'; end if;
  update line_links set opted_out = p_opt, opt_out_reason = case when p_opt then 'staff' else null end, opted_out_at = case when p_opt then now() else null end, updated_at = now() where id = p_link;
end $$;

-- 受信箱：対応済み（viewer 以外）
create or replace function line_mark_handled(p_ids bigint[]) returns int
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int;
begin
  update line_messages m set handled_at = now(),
         handled_by = (select s.id from staff s join stores st on st.company_id = s.company_id where st.id = m.store_id and s.auth_user_id = auth.uid() limit 1),
         handled_by_name = (select s.name from staff s join stores st on st.company_id = s.company_id where st.id = m.store_id and s.auth_user_id = auth.uid() limit 1)
   where m.id = any(p_ids) and m.handled_at is null and can_write_store(m.store_id);
  get diagnostics n = row_count;
  return n;
end $$;

-- 「自分に試し送信」の送り先にする（オーナーだけ。受信箱で自分のLINEを選ぶ）
create or replace function line_set_test_target(p_store uuid, p_line_user_id text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if coalesce(my_role_in_company((select company_id from stores where id = p_store)), '') <> 'owner' then raise exception 'forbidden'; end if;
  if p_line_user_id is not null and not exists (select 1 from line_links where store_id = p_store and line_user_id = p_line_user_id) then raise exception 'not_found'; end if;
  insert into line_channels (store_id) values (p_store) on conflict (store_id) do nothing;
  update line_channels set test_line_user_id = p_line_user_id, updated_at = now() where store_id = p_store;
end $$;

-- ネット予約ページ（ログイン不要）用：LIFF ID だけ（LINE連携がオンの店だけ）
create or replace function public_line_info(p_slug text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('liff_id', c.liff_id, 'basic_id', c.bot_basic_id)
    from stores s join line_channels c on c.store_id = s.id
   where s.slug = lower(btrim(p_slug)) and s.web_booking_enabled and c.enabled and c.liff_id is not null
$$;

revoke all on function line_set_credentials(uuid, text, text) from public, anon;
revoke all on function line_create_link_token(uuid, uuid) from public, anon;
revoke all on function line_set_opt_out(uuid, boolean) from public, anon;
revoke all on function line_mark_handled(bigint[]) from public, anon;
revoke all on function line_set_test_target(uuid, text) from public, anon;
revoke all on function public_line_info(text) from public;
grant execute on function line_set_credentials(uuid, text, text) to authenticated;
grant execute on function line_create_link_token(uuid, uuid) to authenticated;
grant execute on function line_set_opt_out(uuid, boolean) to authenticated;
grant execute on function line_mark_handled(bigint[]) to authenticated;
grant execute on function line_set_test_target(uuid, text) to authenticated;
grant execute on function public_line_info(text) to anon, authenticated;

-- 未ログイン（anon）からは表を一切触れないように（新しい表にも付け直す）
revoke all on all tables in schema public from anon;

notify pgrst, 'reload schema';

select '0015 OK：LINE連携の表を用意しました（全部オフ。設定＞LINE連携 で店舗ごとに入れてからオンにしてください）' as result,
       (select count(*) from line_channels where enabled) as enabled_stores;
