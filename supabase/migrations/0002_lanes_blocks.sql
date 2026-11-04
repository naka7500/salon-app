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

-- 既存店（箱崎）の受付枠
insert into lanes (store_id, name, capacity, sort_order)
select 'aaaaaaaa-0000-0000-0000-000000000001', 'ネット予約枠', 1, 1
where not exists (select 1 from lanes where store_id = 'aaaaaaaa-0000-0000-0000-000000000001');
