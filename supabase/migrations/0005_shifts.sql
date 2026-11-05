-- v0.6（フェーズA）：シフト入力。勤務パターン（店舗ごと）・シフトの種類・休憩未取得・月の確定記録。
-- 既存の shifts（0001）を活かして列を足す。何度流しても安全（if not exists / on conflict）。

-- 勤務パターン：早番／遅番／通し／休／有給／店休 など（店舗ごとに登録）
create table if not exists shift_patterns (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  name text not null,
  kind text not null default 'work' check (kind in ('work','off','paid','closed')),  -- 出勤／休み／有給／店休
  start_time time,
  end_time time,
  color text not null default '#888888',
  sort_order int default 0,
  active boolean default true
);
alter table shift_patterns enable row level security;
drop policy if exists shift_patterns_rw on shift_patterns;
create policy shift_patterns_rw on shift_patterns for all using (store_id in (select id from stores where company_id in (select my_company_ids())));

-- shifts に種類・パターン・休憩未取得を追加
alter table shifts add column if not exists kind text not null default 'work';
alter table shifts drop constraint if exists shifts_kind_check;
alter table shifts add constraint shifts_kind_check check (kind in ('work','off','paid','closed'));
alter table shifts add column if not exists pattern_id uuid references shift_patterns(id);
alter table shifts add column if not exists break_missed boolean not null default false;   -- 休憩未取得（給与の休憩手当に連動）
update shifts set kind = 'closed' where is_store_closed and kind = 'work';
create index if not exists shifts_store_date_idx on shifts (store_id, date);

-- 月ごとの確定記録（確定ボタンで受付枠IDLEを自動生成した日時）
create table if not exists shift_months (
  store_id uuid not null references stores(id),
  ym text not null,                       -- 'YYYY-MM'
  confirmed_at timestamptz not null default now(),
  confirmed_by uuid,
  primary key (store_id, ym)
);
alter table shift_months enable row level security;
drop policy if exists shift_months_rw on shift_months;
create policy shift_months_rw on shift_months for all using (store_id in (select id from stores where company_id in (select my_company_ids())));

-- 新規判定（初来店の検索）を速くする
create index if not exists sales_customer_idx on sales (customer_id, sold_at);
create index if not exists bookings_customer_idx on bookings (customer_id, start_at);

-- 標準の勤務パターンを店舗に入れる（まだ1件も無い店舗だけ）。開店・閉店時刻から作る
create or replace function ensure_default_shift_patterns(p_store uuid) returns int language plpgsql as $$
declare o time; c time; n int;
begin
  select count(*) into n from shift_patterns where store_id = p_store;
  if n > 0 then return 0; end if;
  select open_time, close_time into o, c from stores where id = p_store;
  if o is null then return 0; end if;
  insert into shift_patterns (store_id, name, kind, start_time, end_time, color, sort_order) values
    (p_store, '通し', 'work',   o, c, '#2f6b4f', 1),
    (p_store, '早番', 'work',   o, o + interval '6 hours', '#d9a441', 2),
    (p_store, '遅番', 'work',   c - interval '6 hours', c, '#7a9cd9', 3),
    (p_store, '休',   'off',    null, null, '#d6d3d1', 4),
    (p_store, '有給', 'paid',   null, null, '#f9a8d4', 5),
    (p_store, '店休', 'closed', null, null, '#78716c', 6);
  return 6;
end $$;

select ensure_default_shift_patterns(id) from stores;
revoke all on function ensure_default_shift_patterns(uuid) from public, anon;
grant execute on function ensure_default_shift_patterns(uuid) to authenticated;
-- 未ログイン（anon）からは触れないように（0003 と同じ方針）
revoke all on shift_patterns, shift_months from anon;
