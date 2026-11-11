#!/usr/bin/env bash
# ローカルの PostgreSQL（16 以上）で、マイグレーション 0001→最新 を流し、0024・0025 をもう一度流し（何度流しても同じ）、
# 同意書（0025）とカルテ画像（0024）の権限・書き換え不可・統合のテストを実行する。検証専用（本番には一切つながない）。
#   使い方： PSQL="psql -h /path/to/socket -p 5432 -U postgres" tools/dbtest/run.sh
#   作業用のデータベース salon_dbtest を作り直す（毎回、消して作る）
set -euo pipefail
cd "$(dirname "$0")/../.."
PSQL=${PSQL:-psql -U postgres}
DB=salon_dbtest
$PSQL -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
P="$PSQL -q -v ON_ERROR_STOP=1 -d $DB"
$P -f tools/dbtest/stub.sql >/dev/null
for f in supabase/migrations/*.sql; do $P -f "$f" >/dev/null 2>&1 || { echo "NG: $f"; $P -f "$f" 2>&1 | tail -5; exit 1; }; done
echo "OK: 0001→$(ls supabase/migrations | tail -1 | cut -c1-4) を順に流しました"
snap() { $P -At -f tools/dbtest/snapshot.sql; }
snap > /tmp/salon_dbtest_snap1.txt
for i in 2 3; do for f in supabase/migrations/0024_*.sql supabase/migrations/0025_*.sql; do $P -f "$f" >/dev/null 2>&1 || { echo "NG（流し直し $i 回目）: $f"; exit 1; }; done; done
snap > /tmp/salon_dbtest_snap3.txt
if diff -q /tmp/salon_dbtest_snap1.txt /tmp/salon_dbtest_snap3.txt >/dev/null; then echo "OK: 0024・0025 を合計3回流しても、方針・権限・関数・トリガー・制約・バケットは同じ"; else echo "NG: 流し直しで状態が変わりました"; diff /tmp/salon_dbtest_snap1.txt /tmp/salon_dbtest_snap3.txt | head -20; exit 1; fi
$P -f tools/dbtest/consent.test.sql
