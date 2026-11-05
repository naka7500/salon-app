export type ID = string;

export interface Store { id: ID; company_id: ID; name: string; business_type: 'eyelash'|'headspa'|'hair'; open_time: string; close_time: string; slot_minutes: number; hpb_salon_id?: string|null;
  /** 最終受付：シフト終了の何分前で受付枠IDLEを閉じるか（0006）。null/未定義＝最短メニューの所要時間で自動 */
  last_order_offset_min?: number|null;
  /** 一覧表示用（stores と companies を結合して入れる） */
  company_name?: string|null;
  // ---- フェーズC（0007）：公式ネット予約 ----
  slug?: string|null; name_en?: string|null; phone?: string|null; address?: string|null; logo_url?: string|null; photo_url?: string|null;
  web_message?: string|null; notify_email?: string|null; cancel_policy?: string|null;
  /** キャンセル期限：予約日の何日前の何時まで（例 1日前の18:00） */
  cancel_deadline_days?: number; cancel_deadline_time?: string;
  booking_horizon_days?: number; booking_lead_min?: number; web_booking_enabled?: boolean;
  /** 事前問診の質問（null＝業態別の標準テンプレ） */
  intake_questions?: IntakeQuestion[]|null; timezone?: string }
/** テスト店舗（練習用）か */
export const isTestStore = (s?: Pick<Store,'name'|'company_name'>|null) => !!s && (s.name.includes('テスト') || s.name.includes('練習') || !!s.company_name?.includes('練習'));
export type StaffRole = 'owner'|'manager'|'staff'|'viewer';
/** スタッフ。active＝在籍（false＝退職：今後は出さないが、過去の予約・売上・カルテには名前が残る） */
export interface Staff { id: ID; company_id: ID; name: string; role: StaffRole; active: boolean;
  // ---- 0008（設定＞スタッフ）。未適用のDBでは undefined ----
  /** 予約ページに出す名前（空＝name） */ display_name?: string|null; name_en?: string|null; color?: string|null; sort_order?: number;
  /** 予約台帳・シフト・会計の担当に出す */ show_on_ledger?: boolean;
  /** ネット予約で指名できる */ web_nominatable?: boolean;
  /** 指名料（円・税込） */ nomination_fee?: number|null;
  /** 所属店舗（ヘルプ先は store_ids に入る） */ home_store_id?: ID|null;
  /** ログインのメール（表示だけ） */ email?: string|null; auth_user_id?: string|null;
  /** 所属＋ヘルプ可能な店舗（staff_stores） */ store_ids?: ID[] }
/** 設定画面から保存する形 */
export type StaffInput = Partial<Omit<Staff, 'email'|'auth_user_id'|'company_id'>> & { name: string; role: StaffRole; store_ids: ID[] };
/** 予約台帳・シフト・会計に出す人か（在籍＋台帳に表示） */
export const onLedger = (s: Staff) => s.active !== false && s.show_on_ledger !== false;
/** 表示順（sort_order → 名前） */
export const byStaffOrder = (a: Staff, b: Staff) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name, 'ja');
/** 一覧で使う名前。退職者は「（退職）」をつける */
export const staffLabel = (s: Staff|undefined|null) => (s ? s.name + (s.active === false ? '（退職）' : '') : '—');
export interface Resource { id: ID; store_id: ID; name: string; kind: string; sort_order: number; active: boolean }
/** 対象：全員／新規のみ／再来のみ */
export type Target = 'all'|'new'|'repeat';
export interface Menu { id: ID; store_id: ID; name: string; short_name?: string|null; color?: string|null; category: 'technical'|'option'; price: number; tax_rate: number; duration_min: number; interval_min: number; sort_order: number; active: boolean;
  // ---- フェーズC（0007） ----
  name_en?: string|null; description?: string|null; description_en?: string|null; image_url?: string|null; target?: Target;
  /** 掲載期間（表示する期間。今日で判定） */
  publish_from?: string|null; publish_to?: string|null;
  /** 受付曜日（0=日〜6=土）。null/空＝毎日 */
  weekdays?: number[]|null;
  /** 受付時間帯（開始時刻の範囲 'HH:MM'） */
  time_from?: string|null; time_to?: string|null;
  /** 使う受付枠。null＝1名様枠 */
  lane_id?: ID|null; nominatable?: boolean; web_visible?: boolean }
export type CouponKind = 'amount'|'percent'|'fixed';
/** クーポン（0007）。kind：金額値引／率値引／特別価格 */
export interface Coupon { id: ID; store_id: ID; name: string; name_en?: string|null; description?: string|null; description_en?: string|null;
  kind: CouponKind; value: number; /** 空＝技術メニュー全部 */ menu_ids: ID[]; target: Target;
  /** 前回来店から○日以内 */ within_days?: number|null; weekdays?: number[]|null; time_from?: string|null; time_to?: string|null;
  /** 先着○名 */ first_n?: number|null; /** 1人○回まで */ per_customer_limit?: number|null; code?: string|null;
  publish_from?: string|null; publish_to?: string|null; web_visible: boolean; sort_order: number; active: boolean }
/** 事前問診の質問 */
export interface IntakeQuestion { id: string; label: string; label_en?: string; type: 'text'|'textarea'|'choice'|'multi'; options?: string[]; options_en?: string[]; required?: boolean }
/** 事前問診の回答（予約に保存。質問文ごと持つので、後で質問を変えても読める） */
export interface IntakeAnswer { label: string; answer: string }
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
  // ---- フェーズC（0007）：ネット予約 ----
  coupon_id?: ID|null; intake?: IntakeAnswer[]|null; cancel_token?: string|null; booking_no?: string|null; price_quote?: number|null; lang?: string|null;
}

export type PayMethod = 'cash'|'card'|'emoney'|'qr'|'gift'|'voucher'|'ota_prepaid'|'other';
export interface SaleLine { id: ID; sale_id: ID; kind: 'menu'|'product'|'option'|'fee'; menu_id?: ID|null; product_id?: ID|null; name: string; unit_price: number; qty: number; tax_rate: number; staff_id?: ID|null; amount: number }
export interface Payment { id: ID; sale_id: ID; method: PayMethod; amount: number; provider_ref?: string|null }
export interface Sale {
  id: ID; store_id: ID; booking_id?: ID|null; customer_id?: ID|null; main_staff_id?: ID|null; sale_no: string; sold_at: string;
  status: 'confirmed'|'voided'|'reversal'; reverses_sale_id?: ID|null; subtotal: number; discount: number; tax: number; total: number;
  discount_reason?: string|null; closed_on?: string|null; note?: string|null; lines: SaleLine[]; payments: Payment[]; coupon_id?: ID|null;
}
export interface RegisterClosing { id: ID; store_id: ID; date: string; opening_float: number; counted_cash?: number|null; expected_cash?: number|null; difference?: number|null; closed_at?: string|null; note?: string|null }
export interface InventoryMove { id: ID; product_id: ID; store_id: ID; qty: number; reason: 'sale'|'purchase'|'adjust'|'return'|'stocktake'; moved_at: string }
export interface KarteEntry { id: ID; customer_id: ID; store_id: ID; booking_id?: ID|null; staff_id?: ID|null; visited_on: string; template: string; record: Record<string, string>; memo?: string|null; next_proposal?: string|null; handwriting: string[]; created_at: string;
  /** 写真URL（'before|URL' / 'after|URL'） */
  photos?: string[]|null;
  /** 事前問診（ネット予約の回答を貼ったもの） */
  health?: { intake?: IntakeAnswer[]; booking_no?: string|null }|null }

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
export interface Capabilities { goals: boolean; shiftBreaks: boolean; lastOrder: boolean;
  /** 0007（メニュー詳細・クーポン・ネット予約・通知・修正履歴） */
  phaseC: boolean;
  /** 0008（スタッフ設定の項目・書き込み権限のDB側チェック） */
  staffSettings: boolean }
/** 通知キュー（0007） */
export interface AppNotification { id: ID; store_id: ID; booking_id?: ID|null; kind: 'new_booking'|'cancel_booking'|'booking_confirmation'|'cancel_confirmation'; channel?: string; to_address?: string|null; subject?: string|null; body?: string|null; status: 'queued'|'sent'|'failed'|'skipped'; error?: string|null; created_at: string; sent_at?: string|null; read_at?: string|null }
/** 修正履歴（audit_logs） */
export interface AuditLog { id: string|number; at: string; store_id?: ID|null; actor_name?: string|null; table_name: string; row_id?: string|null; action: string; reason?: string|null; before?: Record<string, unknown>|null; after?: Record<string, unknown>|null }
/** 店舗設定で変えられる項目 */
export type StoreSettingsPatch = Partial<Pick<Store, 'last_order_offset_min'|'slug'|'name_en'|'phone'|'address'|'logo_url'|'photo_url'|'web_message'|'notify_email'|'cancel_policy'|'cancel_deadline_days'|'cancel_deadline_time'|'booking_horizon_days'|'booking_lead_min'|'web_booking_enabled'|'intake_questions'>>;
/** 集計用にまとめて取った材料（複数店舗可） */
export interface ReportBundle {
  stores: Store[]; sales: Sale[]; bookings: Booking[]; shifts: Shift[]; menus: Menu[]; staff: Staff[]; customers: Customer[];
  /** 店舗ID → お客様ID → その店舗での初来店日時 */
  firstVisits: Record<ID, Record<ID, string>>;
}

export interface NewSaleInput {
  booking_id?: ID|null; customer_id?: ID|null; main_staff_id?: ID|null; discount: number; discount_reason?: string;
  lines: Omit<SaleLine,'id'|'sale_id'|'amount'>[]; payments: Omit<Payment,'id'|'sale_id'>[]; note?: string; coupon_id?: ID|null;
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
  updateStoreSettings(patch: StoreSettingsPatch): Promise<Store>;
  /** 期間の材料をまとめて取る。sales は salesTo まで、bookings は bookingsTo まで（再来率・次回予約の判定用に期間の後ろも取る） */
  reportBundle(storeIds: ID[], from: string, salesTo: string, bookingsTo: string): Promise<ReportBundle>;
  customersByIds(ids: ID[]): Promise<Customer[]>;
  /** 目標売上。null＝0006未適用（準備中） */
  goals(storeIds: ID[], fromYm: string, toYm: string): Promise<StoreGoal[]|null>;
  saveGoal(store_id: ID, ym: string, target_sales: number|null): Promise<void>;
  // ---- フェーズC ----
  /** ログイン中のスタッフ（役割つき）。デモは画面右上で切り替え */
  me(): Promise<Staff|null>;
  /** 非表示も含めた全メニュー（設定画面用） */
  allMenus(): Promise<Menu[]>;
  saveMenu(m: Partial<Menu> & { name: string }): Promise<Menu>;
  reorderMenus(ids: ID[]): Promise<void>;
  /** null＝0007未適用（準備中） */
  coupons(): Promise<Coupon[]|null>;
  saveCoupon(c: Partial<Coupon> & { name: string }): Promise<Coupon>;
  reorderCoupons(ids: ID[]): Promise<void>;
  /** クーポンごとの利用件数（キャンセル以外の予約＋予約なしの会計） */
  couponUsage(): Promise<Record<ID, number>>;
  /** 店舗側の通知（新しいネット予約など）。null＝0007未適用 */
  notifications(onlyUnread?: boolean): Promise<AppNotification[]|null>;
  markNotificationsRead(ids: ID[]): Promise<void>;
  /** 修正履歴。null＝0007未適用 */
  auditLogs(from: string, to: string): Promise<AuditLog[]|null>;
  // ---- 設定＞スタッフ（0008） ----
  /** 会社の全スタッフ（退職・台帳非表示も含む。名前の表示と設定画面用）。store_ids つき */
  allStaff(): Promise<Staff[]>;
  saveStaff(s: StaffInput): Promise<Staff>;
  reorderStaff(ids: ID[]): Promise<void>;
  /** 履歴（予約・売上・シフト・カルテ）がある人は消せない（エラー）→ 退職にする */
  deleteStaff(id: ID): Promise<void>;
}
