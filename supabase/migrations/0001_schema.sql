-- 自社予約・POS統合アプリ  スキーマ v0.2（仕様書9章）
-- 全テーブルに company_id / store_id を持たせ、複数会社・複数店舗に対応する。
create extension if not exists "pgcrypto";

-- ---------- マスタ ----------
create table companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invoice_number text,            -- インボイス登録番号 T...
  created_at timestamptz default now()
);

create table stores (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  business_type text not null check (business_type in ('eyelash','headspa','hair')),
  open_time time not null default '10:00',
  close_time time not null default '19:00',
  slot_minutes int not null default 15,
  timezone text not null default 'Asia/Tokyo',
  hpb_salon_id text,              -- H000805291 など
  cancel_policy text,
  created_at timestamptz default now()
);

create table staff (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  role text not null default 'staff' check (role in ('owner','manager','staff','viewer')),
  auth_user_id uuid,              -- Supabase auth.users.id
  nomination_fee int default 0,
  active boolean default true,
  created_at timestamptz default now()
);
create table staff_stores (        -- 複数店在籍（ヘルプ）
  staff_id uuid references staff(id) on delete cascade,
  store_id uuid references stores(id) on delete cascade,
  primary key (staff_id, store_id)
);

create table resources (           -- 部屋・ベッド・シャンプー台
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  name text not null,
  kind text not null default 'bed',
  sort_order int default 0,
  active boolean default true
);

create table shifts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  staff_id uuid references staff(id),   -- null = 店休日
  date date not null,
  start_time time,
  end_time time,
  is_store_closed boolean default false,
  unique (store_id, staff_id, date)
);

create table menus (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  name text not null,
  name_en text,
  category text not null default 'technical',   -- technical / option
  price int not null,                            -- 税込
  tax_rate numeric(4,3) not null default 0.10,
  duration_min int not null,                     -- 施術時間
  interval_min int not null default 0,           -- 準備・インターバル
  needs_resource boolean default true,
  sort_order int default 0,
  active boolean default true
);

create table products (            -- 店販
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  name text not null,
  sku text,
  price int not null,
  cost int default 0,
  tax_rate numeric(4,3) not null default 0.10,
  stock int not null default 0,
  reorder_point int default 0,
  active boolean default true
);

-- ---------- 顧客・カルテ ----------
create table customers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null,
  kana text,
  phone text,
  email text,
  line_user_id text,
  birth_month text,              -- 'YYYY-MM' 生年月
  gender text,
  language text default 'ja',
  source text,                   -- 流入経路
  merged_into uuid references customers(id),
  consent_privacy_at timestamptz,
  consent_health_at timestamptz,
  note text,
  created_at timestamptz default now()
);
create index on customers (company_id, phone);

create table karte_entries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id),
  store_id uuid not null references stores(id),
  booking_id uuid,
  staff_id uuid references staff(id),
  visited_on date not null,
  template text not null default 'eyelash',    -- eyelash / headspa / hair
  record jsonb not null default '{}',          -- デザイン・本数・毛質…（業態別）
  health jsonb,                                -- 問診（要配慮：アプリ側で暗号化予定）
  memo text,                                   -- 接客メモ
  next_proposal text,                          -- 次回提案
  photos text[] default '{}',                  -- storage path
  handwriting text[] default '{}',             -- 手書き（SVG/PNG の storage path）
  created_at timestamptz default now()
);

-- ---------- 予約 ----------
create table bookings (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  customer_id uuid references customers(id),
  customer_name text,            -- 顧客未登録・外部予約用
  staff_id uuid references staff(id),
  resource_id uuid references resources(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  status text not null default 'booked' check (status in ('booked','arrived','done','cancelled','noshow','block')),
  channel text not null default 'own' check (channel in ('own','hpb','phone','walkin','viator','klook','ikyu','line','block')),
  external_ref text,             -- HPB予約番号 YH…, Bokun ID など
  menu_ids uuid[] default '{}',
  nominated boolean default false,
  pair_group uuid,               -- ペア予約の束
  note text,
  created_by uuid references staff(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index on bookings (store_id, start_at);
create index on bookings (external_ref);

create table booking_history (
  id bigserial primary key,
  booking_id uuid not null references bookings(id),
  changed_at timestamptz default now(),
  changed_by uuid,
  before jsonb,
  after jsonb
);

create table channel_blocks (      -- 外部へ出した枠閉じの台帳（ledger）
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  channel text not null,          -- hpb / ikyu / bokun
  booking_id uuid references bookings(id),
  external_block_id text,         -- サロンボード側の予約ID
  start_at timestamptz not null,
  end_at timestamptz not null,
  lane text,                      -- 1名様 / 2名様 / スタッフ名 など
  status text not null default 'open' check (status in ('open','closed','failed','released')),
  last_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------- 会計 ----------
create table sales (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  booking_id uuid references bookings(id),
  customer_id uuid references customers(id),
  main_staff_id uuid references staff(id),
  sale_no text not null,                  -- 伝票番号（店舗ごと連番）
  sold_at timestamptz not null default now(),
  status text not null default 'confirmed' check (status in ('confirmed','voided','reversal')),
  reverses_sale_id uuid references sales(id),   -- 赤伝の元伝票
  subtotal int not null default 0,
  discount int not null default 0,
  tax int not null default 0,
  total int not null default 0,
  discount_reason text,
  closed_on date,                         -- 日次締めで埋まる
  note text,
  created_by uuid references staff(id),
  created_at timestamptz default now()
);
create index on sales (store_id, sold_at);

create table sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  kind text not null check (kind in ('menu','product','option','fee')),
  menu_id uuid references menus(id),
  product_id uuid references products(id),
  name text not null,
  unit_price int not null,
  qty int not null default 1,
  tax_rate numeric(4,3) not null default 0.10,
  staff_id uuid references staff(id),      -- 明細担当
  amount int not null
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id) on delete cascade,
  method text not null check (method in ('cash','card','emoney','qr','gift','voucher','ota_prepaid','other')),
  amount int not null,
  provider_ref text                        -- 決済サービスの取引ID（カード番号は持たない）
);

create table register_closings (          -- レジ締め
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references stores(id),
  date date not null,
  opening_float int not null default 0,
  counted_cash int,
  expected_cash int,
  difference int,
  closed_by uuid references staff(id),
  closed_at timestamptz,
  note text,
  unique (store_id, date)
);

create table inventory_moves (            -- 在庫の増減履歴
  id bigserial primary key,
  product_id uuid not null references products(id),
  store_id uuid not null references stores(id),
  qty int not null,                       -- +入荷 / -販売 / 棚卸調整
  reason text not null check (reason in ('sale','purchase','adjust','return','stocktake')),
  sale_line_id uuid references sale_lines(id),
  moved_at timestamptz default now(),
  created_by uuid references staff(id)
);

create table audit_logs (
  id bigserial primary key,
  at timestamptz default now(),
  actor uuid,
  table_name text not null,
  row_id text,
  action text not null,
  before jsonb,
  after jsonb
);

-- ---------- 共通トリガ ----------
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger t_bookings_touch before update on bookings for each row execute function touch_updated_at();
create trigger t_blocks_touch before update on channel_blocks for each row execute function touch_updated_at();

create or replace function log_booking_history() returns trigger language plpgsql as $$
begin
  insert into booking_history (booking_id, before, after)
  values (coalesce(new.id, old.id), to_jsonb(old), to_jsonb(new));
  return new;
end $$;
create trigger t_bookings_hist after update or delete on bookings for each row execute function log_booking_history();

-- 伝票確定時に在庫を減らす
create or replace function apply_inventory_on_sale_line() returns trigger language plpgsql as $$
begin
  if new.kind = 'product' and new.product_id is not null then
    insert into inventory_moves (product_id, store_id, qty, reason, sale_line_id)
    select new.product_id, s.store_id, -new.qty, 'sale', new.id from sales s where s.id = new.sale_id;
    update products set stock = stock - new.qty where id = new.product_id;
  end if;
  return new;
end $$;
create trigger t_sale_lines_inventory after insert on sale_lines for each row execute function apply_inventory_on_sale_line();

-- 伝票番号の採番（店舗ごと YYYYMMDD-NNN）
create sequence sale_no_seq;
create or replace function next_sale_no(p_store uuid) returns text language sql as $$
  select to_char(now() at time zone 'Asia/Tokyo','YYYYMMDD') || '-' ||
         lpad((count(*) + 1)::text, 3, '0')
  from sales where store_id = p_store and (sold_at at time zone 'Asia/Tokyo')::date = (now() at time zone 'Asia/Tokyo')::date;
$$;

-- ---------- RLS（スタッフは所属会社のデータだけ） ----------
create or replace function my_company_ids() returns setof uuid language sql stable security definer as $$
  select company_id from staff where auth_user_id = auth.uid();
$$;

do $$ declare t text; begin
  foreach t in array array['companies','stores','staff','resources','shifts','menus','products','customers','karte_entries','bookings','channel_blocks','sales','sale_lines','payments','register_closings','inventory_moves']
  loop execute format('alter table %I enable row level security', t); end loop;
end $$;

create policy companies_rw on companies for all using (id in (select my_company_ids()));
create policy stores_rw on stores for all using (company_id in (select my_company_ids()));
create policy staff_rw on staff for all using (company_id in (select my_company_ids()));
create policy customers_rw on customers for all using (company_id in (select my_company_ids()));
create policy resources_rw on resources for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy shifts_rw on shifts for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy menus_rw on menus for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy products_rw on products for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy karte_rw on karte_entries for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy bookings_rw on bookings for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy blocks_rw on channel_blocks for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy sales_rw on sales for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy sale_lines_rw on sale_lines for all using (sale_id in (select id from sales where store_id in (select id from stores where company_id in (select my_company_ids()))));
create policy payments_rw on payments for all using (sale_id in (select id from sales where store_id in (select id from stores where company_id in (select my_company_ids()))));
create policy closings_rw on register_closings for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
create policy inv_rw on inventory_moves for all using (store_id in (select id from stores where company_id in (select my_company_ids())));
