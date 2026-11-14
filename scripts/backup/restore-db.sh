#!/usr/bin/env bash
# backup-db.sh のファイル（db_….dump）を、「新しい空の Supabase プロジェクト」か「手元の確認用DB」に戻す。
#   使い方： RESTORE_DB_URL='（戻し先の接続文字列）' scripts/backup/restore-db.sh <db_….dump> --yes
# ★本番に向けて流さない（変数の名前を本番用の SUPABASE_DB_URL と分けてあるのはそのため）。戻し先の public に表が1つでもあれば止まる。
# 戻す順番：
#   1) public（アプリの表・関数・権限・行の守り＝RLS・データ）
#   2) auth・storage のデータ（ログイン・バケットとファイルの一覧）。表そのものは Supabase が最初から持っている
#   3) storage.objects の守り（カルテ画像・同意書の方針）
# ファイルの中身（画像・PDF）は restore-storage.mjs で戻す。
set -euo pipefail
: "${RESTORE_DB_URL:?RESTORE_DB_URL（戻し先の接続文字列）を環境変数で渡してください}"
DUMP=${1:?使い方：restore-db.sh <db_….dump> --yes}
[ "${2:-}" = "--yes" ] || { echo "戻し先を確かめてから、最後に --yes を付けて実行してください"; exit 2; }
[ "${RESTORE_DB_URL}" != "${SUPABASE_DB_URL:-}" ] || { echo "戻し先が本番（SUPABASE_DB_URL）と同じです。止めます"; exit 2; }
N=$(psql "$RESTORE_DB_URL" -At -c "select count(*) from pg_tables where schemaname = 'public'")
[ "$N" = "0" ] || { echo "戻し先の public に表が ${N} 個あります。空のプロジェクトに戻してください（止めました）"; exit 2; }
L=$(mktemp); trap 'rm -f "$L" "$L".*' EXIT
pg_restore --list "$DUMP" > "$L"
# 1) public（「SCHEMA public」はもうあるので外す）
grep -E '^[0-9]+; [0-9]+ [0-9]+ .* public ' "$L" | grep -vE ' SCHEMA - public ' > "$L.public" || true
grep -E ' (ACL|COMMENT|DEFAULT ACL) .*public' "$L" | grep -vE ' SCHEMA public| - SCHEMA ' >> "$L.public" || true
sort -u -t';' -k1,1n "$L.public" -o "$L.public"
# ★大事：Supabase の新しいプロジェクトは「public に作った表・関数は、未ログイン（anon）にも全部許す」が既定になっている。
#   そのまま戻すと、元のDBで外してあった権限（anon からは表に触れない・列ごとの許可 など）が付いた状態で表ができてしまう。
#   先にこの既定を外してから戻す（権限はバックアップに入っている GRANT だけになる＝元と同じ）。既定そのものは最後にバックアップの内容で戻る
psql "$RESTORE_DB_URL" -q -v ON_ERROR_STOP=1 <<'SQL'
alter default privileges in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges in schema public revoke all on functions from anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from anon, authenticated, service_role;
SQL
# データを入れるあいだは、トリガー（予約の履歴づくり・書き換え禁止など）を止める（Supabase 公式の手順と同じ session_replication_role=replica）
REPLICA="-c session_replication_role=replica"
pg_restore --no-owner --exit-on-error --section=pre-data --use-list "$L.public" --dbname "$RESTORE_DB_URL" "$DUMP"
PGOPTIONS="$REPLICA" pg_restore --no-owner --exit-on-error --section=data --use-list "$L.public" --dbname "$RESTORE_DB_URL" "$DUMP"
pg_restore --no-owner --exit-on-error --section=post-data --use-list "$L.public" --dbname "$RESTORE_DB_URL" "$DUMP"
# 2) auth・storage のデータだけ（Supabase の管理用の表は除く）
grep -E ' TABLE DATA (auth|storage) ' "$L" | grep -vE ' (schema_migrations|migrations) ' > "$L.data" || true
PGOPTIONS="$REPLICA" pg_restore --no-owner --data-only --exit-on-error --use-list "$L.data" --dbname "$RESTORE_DB_URL" "$DUMP"
# 3) storage の守り（方針）
grep -E ' POLICY storage ' "$L" > "$L.pol" || true
[ -s "$L.pol" ] && pg_restore --no-owner --exit-on-error --use-list "$L.pol" --dbname "$RESTORE_DB_URL" "$DUMP"
# 念のため：未ログイン（anon）が public の表に直接さわれないこと（1つでもあれば止まる）
BAD=$(psql "$RESTORE_DB_URL" -At -c "select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'")
[ "$BAD" = "0" ] || { echo "★未ログイン（anon）に表の権限が ${BAD} 件付いています。このDBは公開しないでください（権限の戻しに失敗）"; exit 1; }
echo "OK: 戻しました。行数（backup のときの counts.txt と見比べる）"
psql "$RESTORE_DB_URL" -At <<'SQL'
select t || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text
from unnest(array['stores','staff','customers','bookings','sales','sale_lines','payments','karte_entries','karte_pages','consent_documents','line_links','line_messages','notifications','audit_logs']) t
where to_regclass('public.' || t) is not null order by 1;
SQL
