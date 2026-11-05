-- v0.7（フェーズB）：集計の目標売上・最終受付の上書き・シフトの休憩時間。
-- 何度流しても安全（if not exists / drop policy if exists）。
-- 0006 が未適用でもアプリは落ちない（目標入力・最終受付の上書き・休憩入力だけ「準備中」になる）。

-- 1) 店舗×月の目標売上（集計画面の「目標比」「達成率」に使う）
create table if not exists store_goals (
  store_id uuid not null references stores(id) on delete cascade,
  ym text not null check (ym ~ '^[0-9]{4}-[0-9]{2}$'),     -- 'YYYY-MM'
  target_sales int not null check (target_sales >= 0),     -- 税込の目標売上（円）
  updated_at timestamptz not null default now(),
  primary key (store_id, ym)
);
alter table store_goals enable row level security;
drop policy if exists store_goals_rw on store_goals;
create policy store_goals_rw on store_goals for all using (store_id in (select id from stores where company_id in (select my_company_ids())));

-- 2) 最終受付：シフト終了の何分前で受付枠IDLEを閉じるか（null＝最短メニューの所要時間で自動）
alter table stores add column if not exists last_order_offset_min int;
alter table stores drop constraint if exists stores_last_order_offset_check;
alter table stores add constraint stores_last_order_offset_check check (last_order_offset_min is null or last_order_offset_min between 0 and 600);

-- 3) シフトの休憩（この時間は受付枠IDLEを閉じる。稼働率の出勤時間からも引く）
alter table shifts add column if not exists break_start time;
alter table shifts add column if not exists break_end time;
alter table shifts drop constraint if exists shifts_break_check;
alter table shifts add constraint shifts_break_check check (
  (break_start is null and break_end is null) or (break_start is not null and break_end is not null and break_start < break_end)
);

-- 集計（次回予約率＝予約を入れた日時で判定）を速くする
create index if not exists bookings_store_created_idx on bookings (store_id, created_at);

-- 未ログイン（anon）からは触れないように（0003 と同じ方針）
revoke all on store_goals from anon;

-- API（PostgREST）に新しい列・表をすぐ見せる
notify pgrst, 'reload schema';
