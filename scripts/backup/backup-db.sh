#!/usr/bin/env bash
# DB（Supabase の PostgreSQL）を1つのファイルに書き出す。読むだけ（本番DBには何も書かない）。
#   使い方： SUPABASE_DB_URL='（接続文字列。値はここに書かない）' scripts/backup/backup-db.sh [出力フォルダ]
#   出力：   <出力フォルダ>/db_<日時>.dump（pg_dump のカスタム形式。pg_restore で戻す）と、行数の一覧 db_<日時>.counts.txt
# 接続文字列：Supabase ＞ Project Settings ＞ Database ＞ Connection string（Session pooler か Direct。パスワード入り＝秘密）
# 必要なもの：pg_dump（サーバと同じか新しい版。Supabase の版は Project Settings ＞ Infrastructure で分かる）
# 書き出す範囲：public（アプリの表）・auth（ログイン）・storage（ファイルの一覧。ファイルの中身は backup-storage.mjs）
set -euo pipefail
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL（DBの接続文字列）を環境変数で渡してください（ファイルには書かない）}"
OUT=${1:-./backup}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$OUT"
umask 077
pg_dump "$SUPABASE_DB_URL" --format=custom --no-owner \
  --schema=public --schema=auth --schema=storage \
  --file "$OUT/db_$STAMP.dump"
# 中身が読めるか（壊れていれば、ここで止まる）
pg_restore --list "$OUT/db_$STAMP.dump" > /dev/null
# 復元のあとで見比べる用：おもな表の行数（お客様の名前などは出さない。数だけ）
psql "$SUPABASE_DB_URL" -At -v ON_ERROR_STOP=1 > "$OUT/db_$STAMP.counts.txt" <<'SQL'
select t || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text
from unnest(array['stores','staff','customers','bookings','sales','sale_lines','payments','karte_entries','karte_pages','consent_documents','line_links','line_messages','notifications','audit_logs']) t
where to_regclass('public.' || t) is not null order by 1;
SQL
echo "OK: $OUT/db_$STAMP.dump（$(du -h "$OUT/db_$STAMP.dump" | cut -f1)）"
cat "$OUT/db_$STAMP.counts.txt"
