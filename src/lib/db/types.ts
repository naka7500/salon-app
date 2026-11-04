export type ID = string;

export interface Store { id: ID; company_id: ID; name: string; business_type: 'eyelash'|'headspa'|'hair'; open_time: string; close_time: string; slot_minutes: number; hpb_salon_id?: string|null }
export interface Staff { id: ID; company_id: ID; name: string; role: 'owner'|'manager'|'staff'|'viewer'; active: boolean }
export interface Resource { id: ID; store_id: ID; name: string; kind: string; sort_order: number; active: boolean }
export interface Menu { id: ID; store_id: ID; name: string; short_name?: string|null; color?: string|null; category: 'technical'|'option'; price: number; tax_rate: number; duration_min: number; interval_min: number; sort_order: number; active: boolean }
// 受付枠（ネット予約の受け皿）。カミングスーンの「1名様でのご予約」「2名様でのご予約（ペア予約）」に相当
export interface Lane { id: ID; store_id: ID; name: string; capacity: number; sort_order: number; active: boolean }
// ブロックの種類：idle=受付枠を開ける／break=休憩／close=×（受付停止）／guarantee=保証（再施術）
export type BlockKind = 'idle'|'break'|'close'|'guarantee';
export interface Product { id: ID; store_id: ID; name: string; sku?: string|null; price: number; cost: number; tax_rate: number; stock: number; reorder_point: number; active: boolean }
export interface Customer { id: ID; company_id: ID; name: string; kana?: string|null; phone?: string|null; email?: string|null; line_user_id?: string|null; birth_month?: string|null; gender?: string|null; source?: string|null; note?: string|null; created_at: string }

export type BookingStatus = 'booked'|'arrived'|'done'|'cancelled'|'noshow'|'block';
export type Channel = 'own'|'hpb'|'phone'|'walkin'|'viator'|'klook'|'ikyu'|'line'|'block';
export interface Booking {
  id: ID; store_id: ID; customer_id?: ID|null; customer_name?: string|null; staff_id?: ID|null; resource_id?: ID|null;
  lane_id?: ID|null; block_kind?: BlockKind|null;
  start_at: string; end_at: string; status: BookingStatus; channel: Channel; external_ref?: string|null;
  menu_ids: ID[]; nominated: boolean; pair_group?: ID|null; note?: string|null; created_at: string; updated_at: string;
}

export type PayMethod = 'cash'|'card'|'emoney'|'qr'|'gift'|'voucher'|'ota_prepaid'|'other';
export interface SaleLine { id: ID; sale_id: ID; kind: 'menu'|'product'|'option'|'fee'; menu_id?: ID|null; product_id?: ID|null; name: string; unit_price: number; qty: number; tax_rate: number; staff_id?: ID|null; amount: number }
export interface Payment { id: ID; sale_id: ID; method: PayMethod; amount: number; provider_ref?: string|null }
export interface Sale {
  id: ID; store_id: ID; booking_id?: ID|null; customer_id?: ID|null; main_staff_id?: ID|null; sale_no: string; sold_at: string;
  status: 'confirmed'|'voided'|'reversal'; reverses_sale_id?: ID|null; subtotal: number; discount: number; tax: number; total: number;
  discount_reason?: string|null; closed_on?: string|null; note?: string|null; lines: SaleLine[]; payments: Payment[];
}
export interface RegisterClosing { id: ID; store_id: ID; date: string; opening_float: number; counted_cash?: number|null; expected_cash?: number|null; difference?: number|null; closed_at?: string|null; note?: string|null }
export interface InventoryMove { id: ID; product_id: ID; store_id: ID; qty: number; reason: 'sale'|'purchase'|'adjust'|'return'|'stocktake'; moved_at: string }
export interface KarteEntry { id: ID; customer_id: ID; store_id: ID; booking_id?: ID|null; staff_id?: ID|null; visited_on: string; template: string; record: Record<string, string>; memo?: string|null; next_proposal?: string|null; handwriting: string[]; created_at: string }

export interface NewSaleInput {
  booking_id?: ID|null; customer_id?: ID|null; main_staff_id?: ID|null; discount: number; discount_reason?: string;
  lines: Omit<SaleLine,'id'|'sale_id'|'amount'>[]; payments: Omit<Payment,'id'|'sale_id'>[]; note?: string;
}

export interface Repo {
  mode: 'memory'|'supabase';
  store(): Promise<Store>;
  stores(): Promise<Store[]>;
  switchStore(id: ID): void;
  lanes(): Promise<Lane[]>;
  staff(): Promise<Staff[]>;
  resources(): Promise<Resource[]>;
  menus(): Promise<Menu[]>;
  products(): Promise<Product[]>;
  customers(q?: string): Promise<Customer[]>;
  customer(id: ID): Promise<Customer|undefined>;
  upsertCustomer(c: Partial<Customer> & { name: string }): Promise<Customer>;
  bookingsOn(date: string): Promise<Booking[]>;
  bookingsOfCustomer(id: ID): Promise<Booking[]>;
  booking(id: ID): Promise<Booking|undefined>;
  createBooking(b: Omit<Booking,'id'|'created_at'|'updated_at'>): Promise<Booking>;
  updateBooking(id: ID, patch: Partial<Booking>): Promise<Booking>;
  deleteBooking(id: ID): Promise<void>;
  salesOn(date: string): Promise<Sale[]>;
  salesOfCustomer(id: ID): Promise<Sale[]>;
  createSale(s: NewSaleInput): Promise<Sale>;
  reverseSale(id: ID, reason: string): Promise<Sale>;
  closing(date: string): Promise<RegisterClosing|undefined>;
  saveClosing(c: Omit<RegisterClosing,'id'|'store_id'>): Promise<RegisterClosing>;
  adjustStock(product_id: ID, qty: number, reason: InventoryMove['reason']): Promise<Product>;
  inventoryMoves(product_id: ID): Promise<InventoryMove[]>;
  kartes(customer_id: ID): Promise<KarteEntry[]>;
  addKarte(k: Omit<KarteEntry,'id'|'created_at'>): Promise<KarteEntry>;
}
