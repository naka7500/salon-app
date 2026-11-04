-- v0.4：ログイン（メール＋パスワード）。staff にメールを持たせ、初回ログイン時に auth_user_id を紐づける。
alter table staff add column if not exists email text;
create unique index if not exists staff_company_email_idx on staff (company_id, lower(email));

-- ログインユーザー自身の staff 行（同じメール・未紐づけ）に auth.uid() を入れる。何度呼んでも安全。
create or replace function claim_staff() returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if auth.uid() is null then return 0; end if;
  update staff set auth_user_id = auth.uid()
   where auth_user_id is null
     and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function claim_staff() from public, anon;
grant execute on function claim_staff() to authenticated;

-- 未ログイン（anon）からは一切読めないことを明示（RLSは0001で有効化済み）
revoke all on all tables in schema public from anon;

-- 管理者（増美さん）のメール。両社の owner 行に入れる
update staff set email = 'kokage.corp@gmail.com' where id in ('bbbbbbbb-0000-0000-0000-000000000090','bbbbbbbb-0000-0000-0000-000000000091');

-- 0001でRLSが漏れていた2表を保護
alter table staff_stores enable row level security;
create policy staff_stores_rw on staff_stores for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
alter table booking_history enable row level security;
create policy booking_history_ins on booking_history for insert with check (true);
create policy booking_history_sel on booking_history for select using (booking_id in (select id from bookings));
