-- DB の「形」を文字にする（流し直しの前後で比べる）
select 'policy|' || schemaname || '.' || tablename || '|' || policyname || '|' || cmd || '|' || coalesce(roles::text, '') || '|' || coalesce(qual, '') || '|' || coalesce(with_check, '') from pg_policies order by 1;
select 'grant|' || table_schema || '.' || table_name || '|' || grantee || '|' || privilege_type from information_schema.role_table_grants where table_schema in ('public', 'storage') and grantee in ('anon', 'authenticated') order by 1;
select 'colgrant|' || table_name || '|' || column_name || '|' || grantee || '|' || privilege_type from information_schema.column_privileges where table_schema = 'public' and table_name like 'consent%' and grantee in ('anon', 'authenticated') order by 1;
select 'func|' || p.oid::regprocedure || '|' || md5(pg_get_functiondef(p.oid)) || '|' || coalesce(p.proacl::text, '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' order by 1;
select 'trigger|' || c.relname || '|' || t.tgname || '|' || pg_get_triggerdef(t.oid) || '|' || t.tgenabled::text from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname = 'public' order by 1;
select 'constraint|' || conrelid::regclass || '|' || conname || '|' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace order by 1;
select 'index|' || indexdef from pg_indexes where schemaname = 'public' order by 1;
select 'column|' || table_name || '|' || column_name || '|' || data_type || '|' || is_nullable || '|' || coalesce(column_default, '') from information_schema.columns where table_schema = 'public' order by 1;
select 'rls|' || relname || '|' || relrowsecurity::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1;
select 'bucket|' || id || '|' || public::text || '|' || coalesce(file_size_limit::text, '') || '|' || coalesce(allowed_mime_types::text, '') from storage.buckets order by 1;
