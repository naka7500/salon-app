-- 0021：セキュリティの強化（監査 2026-11-08 の S2・C4・C5・L2・L3 ほか）
-- ※必ず 0019 の後に流すこと（0020 を使う場合は 0019 → 0020 → 0021 の順）。0019 が無いと最初で止まります（DBは何も変わりません）。
-- ※何度流しても同じ（if not exists / create or replace / drop ... if exists）。
-- ※public_create_booking・public_booking_by_token は変えません（0020 の担当）。
--
-- やること
--  1) HPB取り込み（S2）：hpb_settings に「送り主の許可リスト」「認証結果の無いメールは受け付けない（既定オン）」を足す。
--     受信ログ（inbound_mails）の状態に rejected（拒否：送り主を確認できない。本文は保存しない）を足す
--  2) claim_staff（C4）：初回ログインの自動の紐づけは「そのログインがまだどの会社のスタッフ行にもつながっていない」ときだけ。
--     しかも当てはまる行が1つの会社だけのとき。2社目以降はオーナーが 設定＞スタッフ の「ログインの発行」でつなぐ（確認つき）
--  3) 通知キュー（C5）：画面（authenticated）からは積めない・消せない・既読（read_at）以外は変えられない。
--     メールの宛先は「その会社のお客様のメール／その予約で入力されたメール／店舗の通知先」だけ。HTML を消す・長さを切る。
--     会社ごと1時間120通・同じ宛先1時間5通まで（超えたら積まずに skipped）。送る種類はお客様・お店への予約の通知だけ
--  4) カルテの画像（L2）：閲覧のみ（viewer）は上げる・消すができない。手書きページ（karte_pages）も viewer は書けない
--  5) 会社またぎ（L3）：予約・カルテ・旧POSの来店に、ほかの会社のお客様をつなげない（誰が書いても）

begin;

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bookings' and column_name = 'customer_created')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'line_links' and column_name = 'linked_via') then
    raise exception '0019 が流れていません。先に 0019_line_link_guard.sql を流してから（0020 も使うなら 0020 の後に）、もう一度 0021 を流してください（DBは何も変わっていません）';
  end if;
  if to_regclass('public.hpb_settings') is null or to_regclass('public.inbound_mails') is null then
    raise exception '0011 が流れていません。0011 → … → 0019 の順に流してから、もう一度 0021 を流してください（DBは何も変わっていません）';
  end if;
end $$;

-- =========================================================
-- 1) HPB取り込み：送り主の確認
-- =========================================================
alter table hpb_settings add column if not exists allowed_from_domains text[];
alter table hpb_settings add column if not exists require_auth boolean not null default true;
comment on column hpb_settings.allowed_from_domains is '0021：HPBの通知メールの送り主のドメイン（空・null＝アプリの既定 salonboard.com・beauty.hotpepper.jp）';
comment on column hpb_settings.require_auth is '0021：Gmail の認証結果（DKIM/SPF）が無いメールは受け付けない（既定 true）';
alter table hpb_settings drop constraint if exists hpb_settings_domains_check;
alter table hpb_settings add constraint hpb_settings_domains_check check (
  allowed_from_domains is null
  or (cardinality(allowed_from_domains) <= 10 and array_to_string(allowed_from_domains, ',') ~ '^[a-z0-9.-]{3,253}(,[a-z0-9.-]{3,253})*$'));

alter table inbound_mails drop constraint if exists inbound_mails_status_check;
alter table inbound_mails add constraint inbound_mails_status_check check (status in ('received', 'done', 'warn', 'review', 'error', 'ignored', 'duplicate', 'rejected'));
comment on column inbound_mails.status is '0021：rejected＝送り主を確認できず拒否（件名・本文・名前・電話は保存しない。from_address はドメインだけ）';

-- =========================================================
-- 2) 初回ログインの紐づけ（claim_staff）
-- =========================================================
create or replace function claim_staff() returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; v_email text := lower(btrim(coalesce(auth.jwt() ->> 'email', ''))); v_companies int;
begin
  if auth.uid() is null or v_email = '' then return 0; end if;
  begin
    if not exists (select 1 from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null) then return 0; end if;
  exception when insufficient_privilege or undefined_column then
    null;  -- 確認できない環境では 0016 と同じ動き
  end;
  -- ★0021：すでにどこかの会社のスタッフ行につながっているログインは、自動ではつながない（ほかの会社のオーナーが勝手につなげないように）
  if exists (select 1 from staff where auth_user_id = auth.uid()) then return 0; end if;
  -- ★0021：当てはまる行が2つ以上の会社にあるときは、どれにもつながない（オーナーが「ログインの発行」でつなぐ）
  select count(distinct company_id) into v_companies from staff
   where auth_user_id is null and coalesce(active, true) and lower(btrim(email)) = v_email;
  if v_companies <> 1 then return 0; end if;
  update staff set auth_user_id = auth.uid()
   where auth_user_id is null
     and coalesce(active, true)
     and lower(btrim(email)) = v_email;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function claim_staff() from public, anon;
grant execute on function claim_staff() to authenticated;

-- =========================================================
-- 3) 通知キュー：踏み台にしない
-- =========================================================
-- 画面からは「既読にする」だけ（積む・消すのは関数・サーバ＝サービスキーだけ）
drop policy if exists notifications_rw on notifications;
drop policy if exists notifications_ins on notifications;
drop policy if exists notifications_del on notifications;
drop policy if exists notifications_upd on notifications;
create policy notifications_upd on notifications for update using (can_write_store(store_id)) with check (can_write_store(store_id));
revoke insert, update, delete, truncate on notifications from authenticated;
grant select on notifications to authenticated;
grant update (read_at) on notifications to authenticated;
revoke all on notifications from anon;

-- 予約で入力されたメール（0020 で足す列。0020 より先に流しても動くように、ここでも足しておく）
alter table bookings add column if not exists web_email text;

create or replace function guard_notification_mail() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_company uuid; v_to text; n int;
begin
  -- 文字だけ（タグを消す）・長さを切る（誰が積んでも）
  if new.subject is not null then new.subject := left(regexp_replace(new.subject, '<[^>]*>', '', 'g'), 300); end if;
  if new.body is not null then new.body := left(regexp_replace(new.body, '<[^>]*>', '', 'g'), 4000); end if;
  if coalesce(new.channel, 'email') <> 'email' or new.status <> 'queued' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'queued' and new.to_address is not distinct from old.to_address then return new; end if;
  v_to := lower(btrim(coalesce(new.to_address, '')));
  if v_to = '' then return new; end if;   -- 宛先なしは送信のときに skipped になる
  new.to_address := v_to;
  if new.kind not in ('booking_confirmation', 'cancel_confirmation', 'new_booking', 'cancel_booking') then
    new.status := 'skipped'; new.error := '0021：メールで送らない種類の通知です'; return new;
  end if;
  if v_to !~ '^[^@\s<>",;'']+@[^@\s<>",;'']+\.[^@\s<>",;'']+$' or length(v_to) > 254 then
    new.status := 'skipped'; new.error := '0021：宛先の形が正しくありません'; return new;
  end if;
  select company_id into v_company from stores where id = new.store_id;
  if not (
       exists (select 1 from stores s where s.id = new.store_id and lower(btrim(coalesce(s.notify_email, ''))) = v_to)
    or exists (select 1 from customers c where c.company_id = v_company and lower(btrim(coalesce(c.email, ''))) = v_to)
    or (new.booking_id is not null and exists (select 1 from bookings b where b.id = new.booking_id and b.store_id = new.store_id and lower(btrim(coalesce(b.web_email, ''))) = v_to))
  ) then
    new.status := 'skipped'; new.error := '0021：宛先がこの会社のお客様・店舗の通知先ではありません'; return new;
  end if;
  -- 1時間の上限（会社ごと120通・同じ宛先5通）
  select count(*) into n from notifications x join stores s on s.id = x.store_id
   where s.company_id = v_company and x.channel = 'email' and x.status in ('queued', 'sent') and x.created_at > now() - interval '1 hour' and x.id <> new.id;
  if n >= 120 then new.status := 'skipped'; new.error := '0021：この会社のメールが1時間の上限（120通）に達しました'; return new; end if;
  select count(*) into n from notifications x
   where lower(x.to_address) = v_to and x.channel = 'email' and x.status in ('queued', 'sent') and x.created_at > now() - interval '1 hour' and x.id <> new.id;
  if n >= 5 then new.status := 'skipped'; new.error := '0021：同じ宛先へのメールが1時間の上限（5通）に達しました'; return new; end if;
  return new;
end $$;
revoke all on function guard_notification_mail() from public, anon, authenticated;
drop trigger if exists t_notifications_guard_mail on notifications;
create trigger t_notifications_guard_mail before insert or update of to_address, status, subject, body on notifications
  for each row execute function guard_notification_mail();
create index if not exists notifications_mail_rate_idx on notifications (created_at) where channel = 'email' and status in ('queued', 'sent');

-- =========================================================
-- 4) カルテの画像・手書きページ：viewer は書けない
-- =========================================================
create or replace function karte_file_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare cid text := split_part(coalesce(p_name, ''), '/', 1); seg text := split_part(coalesce(p_name, ''), '/', 2);
begin
  if cid !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  if seg not in ('karte', 'templates') then return false; end if;
  if not exists (select 1 from my_company_ids() c where c = cid::uuid) then return false; end if;
  if p_write and seg = 'templates' then return coalesce(my_role_in_company(cid::uuid) in ('owner', 'manager'), false); end if;
  -- ★0021：書く（上げる・差し替える・消す）のは viewer 以外
  if p_write then return coalesce(my_role_in_company(cid::uuid) in ('owner', 'manager', 'staff'), false); end if;
  return true;
end $$;
revoke all on function karte_file_ok(text, boolean) from public, anon;
grant execute on function karte_file_ok(text, boolean) to authenticated;

drop policy if exists karte_pages_rw on karte_pages;
drop policy if exists karte_pages_sel on karte_pages;
drop policy if exists karte_pages_ins on karte_pages;
drop policy if exists karte_pages_upd on karte_pages;
drop policy if exists karte_pages_del on karte_pages;
create policy karte_pages_sel on karte_pages for select
  using (karte_entry_id in (select k.id from karte_entries k where k.store_id in (select st.id from stores st where st.company_id in (select my_company_ids()))));
create policy karte_pages_ins on karte_pages for insert
  with check (karte_entry_id in (select k.id from karte_entries k where can_write_store(k.store_id)));
create policy karte_pages_upd on karte_pages for update
  using (karte_entry_id in (select k.id from karte_entries k where can_write_store(k.store_id)))
  with check (karte_entry_id in (select k.id from karte_entries k where can_write_store(k.store_id)));
create policy karte_pages_del on karte_pages for delete
  using (karte_entry_id in (select k.id from karte_entries k where can_write_store(k.store_id)));

-- =========================================================
-- 5) ほかの会社のお客様をつなげない（予約・カルテ・旧POSの来店）
-- =========================================================
create or replace function guard_customer_company() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.customer_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.customer_id is not distinct from old.customer_id and new.store_id is not distinct from old.store_id then return new; end if;
  if not exists (select 1 from customers c join stores s on s.company_id = c.company_id where c.id = new.customer_id and s.id = new.store_id) then
    raise exception 'customer_company_mismatch' using hint = '0021：ほかの会社のお客様はつなげません';
  end if;
  return new;
end $$;
revoke all on function guard_customer_company() from public, anon, authenticated;
drop trigger if exists t_bookings_customer_company on bookings;
create trigger t_bookings_customer_company before insert or update of customer_id, store_id on bookings for each row execute function guard_customer_company();
drop trigger if exists t_karte_entries_customer_company on karte_entries;
create trigger t_karte_entries_customer_company before insert or update of customer_id, store_id on karte_entries for each row execute function guard_customer_company();
do $$ begin
  if to_regclass('public.historical_visits') is not null then
    execute 'drop trigger if exists t_historical_visits_customer_company on historical_visits';
    execute 'create trigger t_historical_visits_customer_company before insert or update of customer_id, store_id on historical_visits for each row execute function guard_customer_company()';
  end if;
end $$;

-- 未ログイン（anon）からは表を一切触れないように（念のため付け直す）
revoke all on all tables in schema public from anon;

notify pgrst, 'reload schema';

commit;

select '0021 OK：HPBの送り主の確認（許可リスト・拒否の記録）・claim_staff の制限・通知メールの宛先と上限・カルテ画像の viewer 制限・会社またぎの防止を入れました' as result,
       (select count(*) from hpb_settings) as hpb_settings,
       (select count(*) from staff where auth_user_id is not null) as linked_staff;
