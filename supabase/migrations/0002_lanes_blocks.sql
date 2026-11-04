-- v0.3：受付枠（lanes）とブロック種別、メニューの略名・色（カミングスーン型の日表示のため）
create table if not exists lanes (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  name text not null,                  -- 1名様でのご予約 / 2名様でのご予約（ペア予約）
  capacity int not null default 1,     -- 同時に受けられる人数
  sort_order int default 0,
  active boolean default true
);
alter table lanes enable row level security;
create policy lanes_rw on lanes for all using (store_id in (select id from stores where company_id in (select my_company_ids())));

alter table bookings add column if not exists lane_id uuid references lanes(id);
alter table bookings add column if not exists block_kind text check (block_kind in ('idle','break','close','guarantee'));
create index if not exists bookings_lane_idx on bookings(lane_id, start_at);

alter table menus add column if not exists short_name text;
alter table menus add column if not exists color text;


-- 予約を削除したときに履歴トリガーが外部キーで失敗しないようにする（履歴は削除後も残す）
alter table booking_history drop constraint if exists booking_history_booking_id_fkey;
