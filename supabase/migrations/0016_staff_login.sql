-- スタッフのログイン（設定＞スタッフ「ログインの発行」）の DB 側。
-- ※必ず 0015_line.sql の後に流すこと（0015 が無いと最初で止まります。DBは何も変わりません）。
-- 何度流しても安全（create or replace / if not exists）。新しい表は作りません（RLS の変更なし）。
-- 0016 が未適用でもアプリは落ちない（発行・停止はサーバが Supabase Auth の管理APIで行う。
--   0016 があると：一覧が1回で読める・止めたとき今のログインも即切れる・止めた人はトークンが残っていてもデータを見られない）。
--
-- やること
--  1) ログインを止めた人（Authentication の ban 中）は、ログインの期限（最長1時間）が残っていてもデータを一切見られない
--     （my_company_ids / my_role_in_company に「止められていない」を追加。退職＝active=false の締め出しは 0014 のまま）
--  2) claim_staff（初回ログインの紐づけ）：メール確認済みの人だけ・在籍の人だけ（総点検 M10）
--  3) サーバ（サービスキー）専用の関数：ログインの状態をまとめて読む／今のログイン（セッション）を全部切る
--     画面（authenticated）・未ログイン（anon）からは呼べない
--  4) ログインの操作の記録（audit_logs の table_name='staff_login'）を数える索引（発行は会社ごとに1時間10回まで）

do $$ begin
  if to_regclass('public.line_channels') is null or to_regprocedure('public.line_set_credentials(uuid,text,text)') is null then
    raise exception '0015 がまだ流れていません。先に 0015_line.sql を流してから、この 0016 を流してください（DBは何も変わっていません）';
  end if;
  if to_regprocedure('public.can_write_company(uuid)') is null then
    raise exception '0014 がまだ流れていません。0014 → 0015 → 0016 の順に流してください';
  end if;
end $$;

-- =========================================================
-- 1) 止められた人は見られない
-- =========================================================
-- auth.users が読めない環境（権限の変更など）では「止められていない」扱い＝0014 と同じ動き（全員が締め出されることはない）
create or replace function _auth_not_banned() returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b timestamptz; found_user boolean;
begin
  if auth.uid() is null then return false; end if;
  select true, u.banned_until into found_user, b from auth.users u where u.id = auth.uid();
  if not coalesce(found_user, false) then return false; end if;
  return b is null or b <= now();
exception when insufficient_privilege or undefined_table or undefined_column then
  return true;
end $$;
revoke all on function _auth_not_banned() from public, anon;
grant execute on function _auth_not_banned() to authenticated;

create or replace function my_company_ids() returns setof uuid
language sql stable security definer set search_path = public, pg_temp as $$
  select company_id from staff where auth_user_id = auth.uid() and coalesce(active, true) and _auth_not_banned();
$$;
revoke all on function my_company_ids() from public, anon;
grant execute on function my_company_ids() to authenticated;

create or replace function my_role_in_company(p_company uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from staff
   where auth_user_id = auth.uid() and company_id = p_company and coalesce(active, true) and _auth_not_banned()
   order by case role when 'owner' then 0 when 'manager' then 1 when 'staff' then 2 else 3 end
   limit 1
$$;
revoke all on function my_role_in_company(uuid) from public, anon;
grant execute on function my_role_in_company(uuid) to authenticated;

-- =========================================================
-- 2) 初回ログインの紐づけ：メール確認済み・在籍の人だけ
-- =========================================================
create or replace function claim_staff() returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if auth.uid() is null then return 0; end if;
  begin
    if not exists (select 1 from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null) then return 0; end if;
  exception when insufficient_privilege or undefined_column then
    null;  -- 確認できない環境では 0003 と同じ動き
  end;
  update staff set auth_user_id = auth.uid()
   where auth_user_id is null
     and coalesce(active, true)
     and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function claim_staff() from public, anon;
grant execute on function claim_staff() to authenticated;

-- =========================================================
-- 3) サーバ専用（service_role だけ）
-- =========================================================
-- ログインの状態：ID か メールで探す（パスワード等の秘密は返さない）
create or replace function staff_auth_lookup(p_ids uuid[], p_emails text[])
returns table(id uuid, email text, last_sign_in_at timestamptz, banned_until timestamptz, email_confirmed_at timestamptz, must_change boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id, u.email::text, u.last_sign_in_at, u.banned_until, u.email_confirmed_at,
         coalesce((u.raw_app_meta_data ->> 'must_change_password')::boolean, false)
    from auth.users u
   where u.id = any(coalesce(p_ids, '{}'))
      or lower(u.email) = any(select lower(x) from unnest(coalesce(p_emails, '{}')) x)
$$;
-- 今のログイン（セッション・リフレッシュトークン）を全部切る。止めた・パスワードを再設定したときに使う
create or replace function staff_auth_revoke_sessions(p_user uuid) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0;
begin
  if p_user is null then return 0; end if;
  delete from auth.refresh_tokens where user_id = p_user::text;
  delete from auth.sessions where user_id = p_user;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function staff_auth_lookup(uuid[], text[]) from public, anon, authenticated;
revoke all on function staff_auth_revoke_sessions(uuid) from public, anon, authenticated;
grant execute on function staff_auth_lookup(uuid[], text[]) to service_role;
grant execute on function staff_auth_revoke_sessions(uuid) to service_role;

-- =========================================================
-- 4) 操作の記録を数える索引
-- =========================================================
create index if not exists audit_logs_table_at_idx on audit_logs (table_name, at desc);

-- 未ログイン（anon）からは表を一切触れない（念のため付け直す）
revoke all on all tables in schema public from anon;

notify pgrst, 'reload schema';

select '0016 OK：スタッフのログインの準備ができました（止めた人はすぐデータを見られなくなります）' as result,
       (select count(*) from staff where auth_user_id is not null and coalesce(active, true)) as staff_with_login;
