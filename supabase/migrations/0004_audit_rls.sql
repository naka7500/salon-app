-- 2026-11-04 本番初回投入時に Supabase の「Run and enable RLS」で audit_logs にもRLSが付いた。リポジトリ側も揃える。
alter table audit_logs enable row level security;
