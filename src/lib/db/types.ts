export type ID = string;

export interface Store { id: ID; company_id: ID; name: string; business_type: 'eyelash'|'headspa'|'hair'; open_time: string; close_time: string; slot_minutes: number; hpb_salon_id?: string|null;
  /** 最終受付：シフト終了の何分前で受付枠IDLEを閉じるか（0006）。null/未定義＝最短メニューの所要時間で自動 */
  last_order_offset_min?: number|null;
  /** 一覧表示用（stores と companies を結合して入れる） */
  company_name?: string|null }
/** テスト店舗（練習用）か */
export const isTestStore = (s?: Pick<Store,'name'|'company_name'>|null) => !!s && (s.name.includes('テスト') || s.name.includes('練習') || !!s.company_name?.includes('練習'));
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

// シフト：勤務の種類。work=出勤／off=休み／paid=有給／closed=店休
export type ShiftKind = 'work'|'off'|'paid'|'closed';
// 勤務パターン（店舗ごと）：早番・遅番・通し・休・有給・店休 など
export interface ShiftPattern { id: ID; store_id: ID; name: string; kind: ShiftKind; start_time?: string|null; end_time?: string|null; color: string; sort_order: number; active: boolean }
// 1人1日1行。start_time/end_time は 'HH:MM'
export interface Shift { id: ID; store_id: ID; staff_id: ID|null; date: string; kind: ShiftKind; pattern_id?: ID|null; start_time?: string|null; end_time?: string|null; is_store_closed: boolean; break_missed: boolean;
  /** 休憩（0006）。'HH:MM'。この時間は受付枠IDLEを閉じる */
  break_start?: string|null; break_end?: string|null }
export type ShiftInput = Omit<Shift, 'id'|'store_id'> & { staff_id: ID };
// シフト確定の記録（月単位）
export interface ShiftMonth { store_id: ID; ym: string; confirmed_at: string }
// 自動生成した受付枠IDLEの印（bookings.note）
export const AUTO_IDLE_NOTE = 'auto-idle';

/** 店舗×月の目標売上（0006 store_goals） */
export interface StoreGoal { store_id: ID; ym: string; target_sales: number }
/** DB変更（0006）が入っているか。未適用なら該当機能だけ「準備中」にする */
export interface Capabilities { goals: boolean; shiftBreaks: boolean; lastOrder: boolean }
/** 集計用にまとめて取った材料（複数店舗可） */
export interface ReportBundle {
  stores: Store[]; sales: Sale[]; bookings: Booking[]; shifts: Shift[]; menus: Menu[]; staff: Staff[]; customers: Customer[];
  /** 店舗ID → お客様ID → その店舗での初来店日時 */
  firstVisits: Record<ID, Record<ID, string>>;
}

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
  /** from〜to の前日まで（to は含まない）。日付は 'YYYY-MM-DD' */
  bookingsBetween(from: string, to: string): Promise<Booking[]>;
  createBookings(list: Omit<Booking,'id'|'created_at'|'updated_at'>[]): Promise<number>;
  deleteBookings(ids: ID[]): Promise<void>;
  bookingsOfCustomer(id: ID): Promise<Booking[]>;
  booking(id: ID): Promise<Booking|undefined>;
  createBooking(b: Omit<Booking,'id'|'created_at'|'updated_at'>): Promise<Booking>;
  updateBooking(id: ID, patch: Partial<Booking>): Promise<Booking>;
  deleteBooking(id: ID): Promise<void>;
  salesOn(date: string): Promise<Sale[]>;
  salesOfCustomer(id: ID): Promise<Sale[]>;
  /** from〜to の前日まで（to は含まない） */
  salesBetween(from: string, to: string): Promise<Sale[]>;
  /** 各お客様のこの店舗での初来店日時（会計済みの予約・確定伝票の全期間から一番古いもの） */
  firstVisits(customerIds: ID[]): Promise<Record<ID, string>>;
  createSale(s: NewSaleInput): Promise<Sale>;
  reverseSale(id: ID, reason: string): Promise<Sale>;
  closing(date: string): Promise<RegisterClosing|undefined>;
  saveClosing(c: Omit<RegisterClosing,'id'|'store_id'>): Promise<RegisterClosing>;
  adjustStock(product_id: ID, qty: number, reason: InventoryMove['reason']): Promise<Product>;
  inventoryMoves(product_id: ID): Promise<InventoryMove[]>;
  kartes(customer_id: ID): Promise<KarteEntry[]>;
  addKarte(k: Omit<KarteEntry,'id'|'created_at'>): Promise<KarteEntry>;
  // ---- シフト ----
  shiftPatterns(): Promise<ShiftPattern[]>;
  saveShiftPattern(p: Partial<ShiftPattern> & { name: string; kind: ShiftKind }): Promise<ShiftPattern>;
  deleteShiftPattern(id: ID): Promise<void>;
  shiftsBetween(from: string, to: string): Promise<Shift[]>;
  /** スタッフ×日で上書き保存 */
  saveShifts(rows: ShiftInput[]): Promise<void>;
  deleteShifts(keys: { staff_id: ID; date: string }[]): Promise<void>;
  shiftMonth(ym: string): Promise<ShiftMonth|undefined>;
  markShiftMonth(ym: string): Promise<ShiftMonth>;
  // ---- フェーズB：集計・売上台帳・設定 ----
  capabilities(): Promise<Capabilities>;
  /** 最終受付の上書き値など（0006 が無いとエラー） */
  updateStoreSettings(patch: { last_order_offset_min: number|null }): Promise<Store>;
  /** 期間の材料をまとめて取る。sales は salesTo まで、bookings は bookingsTo まで（再来率・次回予約の判定用に期間の後ろも取る） */
  reportBundle(storeIds: ID[], from: string, salesTo: string, bookingsTo: string): Promise<ReportBundle>;
  customersByIds(ids: ID[]): Promise<Customer[]>;
  /** 目標売上。null＝0006未適用（準備中） */
  goals(storeIds: ID[], fromYm: string, toYm: string): Promise<StoreGoal[]|null>;
  saveGoal(store_id: ID, ym: string, target_sales: number|null): Promise<void>;
}
