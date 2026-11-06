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
  intake_questions?: IntakeQuestion[]|null; timezone?: string;
  // ---- v1.1（0009）：人数×部屋で空きを数える ----
  /** 部屋（ベッド）の数。null＝数えない（無制限） */
  room_count?: number|null;
  /** ネット予約・電話予約の開始時刻の刻み（分）。既定30 */
  start_step_min?: number }
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
  lane_id?: ID|null; nominatable?: boolean; web_visible?: boolean;
  // ---- v1.1（0009） ----
  /** 1件で何名分か（1＝1名様／2＝ペア）。ペアの料金は「1組」の料金。未適用DBでは undefined（受付枠から判定） */
  people?: number;
  /** オプション（category='option'）が属するグループ */
  option_group_id?: ID|null;
  /** 技術メニューに付けられるオプショングループ */
  option_group_ids?: ID[]|null }
/** オプショングループ（0009）。例：「オフ」＝必須・1つだけ */
export interface OptionGroup { id: ID; store_id: ID; name: string; name_en?: string|null; description?: string|null; required: boolean; multi: boolean; sort_order: number; active: boolean }
export type CouponKind = 'amount'|'percent'|'fixed';
/** クーポン（0007）。kind：金額値引／率値引／特別価格 */
export interface Coupon { id: ID; store_id: ID; name: string; name_en?: string|null; description?: string|null; description_en?: string|null;
  kind: CouponKind; value: number; /** 空＝技術メニュー全部 */ menu_ids: ID[]; target: Target;
  /** 前回来店から○日以内 */ within_days?: number|null; weekdays?: number[]|null; time_from?: string|null; time_to?: string|null;
  /** 先着○名 */ first_n?: number|null; /** 1人○回まで */ per_customer_limit?: number|null; code?: string|null;
  publish_from?: string|null; publish_to?: string|null; web_visible: boolean; sort_order: number; active: boolean;
  /** このクーポンで付けられるオプショングループ（0009。メニュー側のグループと合わせて出す） */
  option_group_ids?: ID[]|null }
/** 事前問診の質問 */
export interface IntakeQuestion { id: string; label: string; label_en?: string; type: 'text'|'textarea'|'choice'|'multi'; options?: string[]; options_en?: string[]; required?: boolean }
/** 事前問診の回答（予約に保存。質問文ごと持つので、後で質問を変えても読める） */
export interface IntakeAnswer { label: string; answer: string }
// 受付枠（ネット予約の受け皿）。カミングスーンの「1名様でのご予約」「2名様でのご予約（ペア予約）」に相当
export interface Lane { id: ID; store_id: ID; name: string; capacity: number; sort_order: number; active: boolean }
// ブロックの種類：idle=受付枠を開ける／break=休憩／close=×（受付停止）／guarantee=保証（再施術）
export type BlockKind = 'idle'|'break'|'close'|'guarantee';
export interface Product { id: ID; store_id: ID; name: string; sku?: string|null; price: number; cost: number; tax_rate: number; stock: number; reorder_point: number; active: boolean }
export interface Customer { id: ID; company_id: ID; name: string; kana?: string|null; phone?: string|null; email?: string|null; line_user_id?: string|null; birth_month?: string|null; gender?: string|null; source?: string|null; note?: string|null; created_at: string;
  // ---- 顧客CSV取り込み（0012）。未適用のDBでは undefined ----
  /** 生年月日 'YYYY-MM-DD' */ birthday?: string|null; postal_code?: string|null; address?: string|null;
  /** どのPOSから取り込んだか（salonanswer／comingsoon／other）と、そのPOSでの顧客番号 */
  import_source?: ImportSource|null; external_id?: string|null;
  /** この人を作った取り込み（取り消し用） */ import_id?: ID|null;
  /** 統合先（統合済みの人） */ merged_into?: ID|null }

// ---- 顧客CSV取り込み（0012） ----
export type ImportSource = 'salonanswer'|'comingsoon'|'other';
export const IMPORT_SOURCE_LABEL: Record<ImportSource, string> = { salonanswer: 'サロンアンサー', comingsoon: 'カミングスーン', other: 'その他' };
export type ImportKind = 'customers'|'visits';
/** 取り込みの記録（誰が・いつ・どのファイル・何件） */
export interface ImportLog { id: ID; company_id: ID; store_id: ID; kind: ImportKind; source: ImportSource; file_name: string; mode: 'fill'|'overwrite';
  actor_name?: string|null; created_at: string;
  counts: { created: number; updated: number; same: number; skipped: number; errors: number; visits?: number };
  undone_at?: string|null; undo_result?: { removed: number; kept: number; visits: number }|null }
/** 列の対応（見出しの文字 → 項目）の保存（取り込み元×種類ごと） */
export interface ImportPreset { source: ImportSource; kind: ImportKind; mapping: Record<string, string>; updated_at?: string }
/** 旧POSの来店（売上台帳・経理には入れない。新規/再来・前回来店の判定にだけ使う）
 *  kind：visit＝1回の来店（来店履歴CSV）／summary＝顧客CSVの「初回来店日・最終来店日・来店回数」 */
export interface HistVisit { id: ID; company_id: ID; store_id: ID; customer_id: ID; kind: 'visit'|'summary'; visited_on?: string|null;
  first_visit_on?: string|null; last_visit_on?: string|null; visit_count?: number|null;
  staff_name?: string|null; menu_text?: string|null; amount?: number|null; slip_no?: string|null;
  source: ImportSource; dedupe_key: string; import_id?: ID|null; created_at?: string }
/** 取り込みで書く顧客の項目 */
export type CustomerImportFields = Pick<Customer, 'name'|'kana'|'phone'|'email'|'birthday'|'birth_month'|'gender'|'postal_code'|'address'|'note'|'external_id'>;
export interface CustomerImportRequest {
  source: ImportSource; file_name: string; mode: 'fill'|'overwrite';
  creates: { data: CustomerImportFields; summary?: HistSummaryInput|null }[];
  updates: { id: ID; patch: Partial<CustomerImportFields>; summary?: HistSummaryInput|null }[];
  /** 変更なし（来店のまとめだけ書く） */
  sames: { id: ID; summary?: HistSummaryInput|null }[];
  /** 変更なしの件数（来店のまとめが無い人も含む）・重複でスキップ・エラー */
  same: number; skipped: number; errors: number;
}
export interface HistSummaryInput { first_visit_on?: string|null; last_visit_on?: string|null; visit_count?: number|null; staff_name?: string|null }
export interface VisitImportRequest {
  source: ImportSource; file_name: string;
  rows: { customer_id: ID; visited_on: string; staff_name?: string|null; menu_text?: string|null; amount?: number|null; slip_no?: string|null; dedupe_key: string }[];
  skipped: number; errors: number;
}
export type ImportProgress = (done: number, total: number) => void;

export type BookingStatus = 'booked'|'arrived'|'done'|'cancelled'|'noshow'|'block';
export type Channel = 'own'|'hpb'|'phone'|'walkin'|'viator'|'klook'|'ikyu'|'line'|'block';
export interface Booking {
  id: ID; store_id: ID; customer_id?: ID|null; customer_name?: string|null; staff_id?: ID|null; resource_id?: ID|null;
  lane_id?: ID|null; block_kind?: BlockKind|null;
  start_at: string; end_at: string; status: BookingStatus; channel: Channel; external_ref?: string|null;
  menu_ids: ID[]; nominated: boolean; pair_group?: ID|null; note?: string|null; created_at: string; updated_at: string;
  // ---- フェーズC（0007）：ネット予約 ----
  coupon_id?: ID|null; intake?: IntakeAnswer[]|null; cancel_token?: string|null; booking_no?: string|null; price_quote?: number|null; lang?: string|null;
  // ---- フェーズE-1（0011）：予約の印。'double_booking'＝HPB取り込みでダブルブッキングの可能性 ----
  alert?: string|null;
}

export type PayMethod = 'cash'|'card'|'emoney'|'qr'|'gift'|'voucher'|'ota_prepaid'|'other';
export interface SaleLine { id: ID; sale_id: ID; kind: 'menu'|'product'|'option'|'fee'; menu_id?: ID|null; product_id?: ID|null; name: string; unit_price: number; qty: number; tax_rate: number; staff_id?: ID|null; amount: number }
export interface Payment { id: ID; sale_id: ID; method: PayMethod; amount: number; provider_ref?: string|null }
export interface Sale {
  id: ID; store_id: ID; booking_id?: ID|null; customer_id?: ID|null; main_staff_id?: ID|null; sale_no: string; sold_at: string;
  status: 'confirmed'|'voided'|'reversal'; reverses_sale_id?: ID|null; subtotal: number; discount: number; tax: number; total: number;
  discount_reason?: string|null; closed_on?: string|null; note?: string|null; lines: SaleLine[]; payments: Payment[]; coupon_id?: ID|null;
  // ---- 0013：主担当がスタッフでないとき（「1名様でのご予約」などの受付枠・「フリー」）。売上の担当は明細担当（lines.staff_id）で数える ----
  main_label?: string|null; main_lane_id?: ID|null;
}
export interface RegisterClosing { id: ID; store_id: ID; date: string; opening_float: number; counted_cash?: number|null; expected_cash?: number|null; difference?: number|null; closed_at?: string|null; note?: string|null }
export interface InventoryMove { id: ID; product_id: ID; store_id: ID; qty: number; reason: 'sale'|'purchase'|'adjust'|'return'|'stocktake'; moved_at: string }
export interface KarteEntry { id: ID; customer_id: ID; store_id: ID; booking_id?: ID|null; staff_id?: ID|null; visited_on: string; template: string; record: Record<string, string>; memo?: string|null; next_proposal?: string|null; handwriting: string[]; created_at: string;
  /** 写真URL（'before|URL' / 'after|URL'） */
  photos?: string[]|null;
  /** 事前問診（ネット予約の回答を貼ったもの） */
  health?: { intake?: IntakeAnswer[]; booking_no?: string|null }|null }

// ---- カルテの手書き（0010）----
/** 手書きの1本の線。t：pen＝ペン／hl＝蛍光ペン。c：色、w：太さ（ページ座標）、p：[x, y, 筆圧(0〜1), x, y, 筆圧, …] */
export interface KarteStroke { t: 'pen'|'hl'; c: string; w: number; p: number[] }
/** 1ページ分の線（あとから書き直せるようにベクターで持つ）。w・h はページの大きさ（座標の基準） */
export interface KarteInk { v: 1; w: number; h: number; items: KarteStroke[] }
/** カルテの手書きページ（karte_pages）。背景は「店の背景テンプレ（template_id）」「標準の背景（builtin）」「写真（background_path）」のどれか1つ */
export interface KartePage { id: ID; karte_entry_id: ID; page_no: number; strokes: KarteInk;
  /** 表示・印刷用の画像（背景＋手書きを1枚にしたもの）のパス */
  png_path: string|null;
  background_path?: string|null; background_template_id?: ID|null; background_builtin?: string|null;
  /** 背景の濃さ（0.1〜1） */ background_opacity: number; created_at?: string; updated_at?: string }
/** カルテの背景テンプレ（karte_backgrounds）。image_path＝店がアップロードした画像／builtin_key＝標準の背景の表示・非表示の設定 */
export interface KarteBackground { id: ID; company_id: ID; store_id: ID|null; name: string; image_path: string|null; builtin_key: string|null; sort_order: number; active: boolean; created_at?: string }
/** 手書きページの背景（編集中） */
export type KartePageBg = { kind: 'none' } | { kind: 'builtin'; key: string } | { kind: 'template'; id: ID } | { kind: 'photo'; path?: string|null; blob?: Blob|null };
/** 手書き画面で作ったページ（保存前）。image＝背景＋手書きを1枚にした画像 */
export interface KartePageDraft { id: ID; strokes: KarteInk; bg: KartePageBg; opacity: number; image: Blob }

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
  staffSettings: boolean;
  /** 0009（オプション選択・人数×部屋の空き計算・ペア） */
  v11: boolean;
  /** 0010（カルテの手書きページ・背景テンプレ・写真の保存先） */
  karte10?: boolean;
  /** 0011（HPBの予約メール取り込み） */
  hpb11?: boolean;
  /** 0012（顧客CSV取り込み・旧POSの来店履歴） */
  import12?: boolean;
  /** 0013（予約トラッキング・主担当の受付枠・リピート率の区分の設定） */
  v13?: boolean }

// ---- 0013：予約トラッキング（booking_history） ----
/** 何をしたか：登録・変更・キャンセル・削除 */
export type HistoryOp = 'insert'|'update'|'cancel'|'delete';
/** どこからの操作か：web＝ネット予約（お客様）／ledger＝予約台帳（スタッフ）／hpb＝HPBの予約メール取り込み／system＝自動処理・記録前 */
export type HistorySource = 'web'|'ledger'|'hpb'|'system';
/** 予約1件の変更の記録。snapshot＝その操作の後の予約（削除は削除前） */
export interface BookingHistoryEntry { id: string|number; booking_id: ID; at: string; op: HistoryOp; source: HistorySource;
  actor_name?: string|null; snapshot: Partial<Booking>; before?: Partial<Booking>|null }

// ---- 0013：リピート率推移表 ----
/** 新規・再来・準固定・固定の決め方（その店舗での来店回数）。1回目＝新規、2〜repeat_max回目＝再来、〜semi_max回目＝準固定、それより多い＝固定 */
export interface RepeatRules { repeat_max: number; semi_max: number }
export const DEFAULT_REPEAT_RULES: RepeatRules = { repeat_max: 2, semi_max: 2 };
/** 1回の来店（同じ日・同じお客様は1回） */
export interface RepeatVisit { store_id: ID; customer_id: ID; date: string;
  /** 技術の明細担当（無ければ主担当）。旧POSの来店は担当名がスタッフと一致したときだけ */ staff_ids: ID[];
  /** 指名の予約か（予約が無い・旧POSは null＝不明） */ nominated: boolean|null; src: 'sale'|'hist' }
/** 顧客CSVの「来店回数・最終来店日」（前のPOSでの回数） */
export interface RepeatSummary { store_id: ID; customer_id: ID; visit_count: number|null; first_visit_on: string|null; last_visit_on: string|null }
export interface RepeatSource { stores: Store[]; staff: Staff[]; visits: RepeatVisit[]; summaries: RepeatSummary[];
  /** お客様ID → 性別 */ genders: Record<ID, string|null>;
  /** 店舗ID → 区分の決め方。rulesReady=false は 0013 未適用（既定値で計算・保存はできない） */ rules: Record<ID, RepeatRules>; rulesReady: boolean }
/** 通知キュー（0007） */
export interface AppNotification { id: ID; store_id: ID; booking_id?: ID|null; kind: 'new_booking'|'cancel_booking'|'booking_confirmation'|'cancel_confirmation'|'hpb_booking'|'hpb_change'|'hpb_cancel'|'hpb_attention'; channel?: string; to_address?: string|null; subject?: string|null; body?: string|null; status: 'queued'|'sent'|'failed'|'skipped'; error?: string|null; created_at: string; sent_at?: string|null; read_at?: string|null }
/** 修正履歴（audit_logs） */
export interface AuditLog { id: string|number; at: string; store_id?: ID|null; actor_name?: string|null; table_name: string; row_id?: string|null; action: string; reason?: string|null; before?: Record<string, unknown>|null; after?: Record<string, unknown>|null }
/** 店舗設定で変えられる項目 */
export type StoreSettingsPatch = Partial<Pick<Store, 'last_order_offset_min'|'room_count'|'start_step_min'|'slug'|'name_en'|'phone'|'address'|'logo_url'|'photo_url'|'web_message'|'notify_email'|'cancel_policy'|'cancel_deadline_days'|'cancel_deadline_time'|'booking_horizon_days'|'booking_lead_min'|'web_booking_enabled'|'intake_questions'>>;
/** 集計用にまとめて取った材料（複数店舗可） */
export interface ReportBundle {
  stores: Store[]; sales: Sale[]; bookings: Booking[]; shifts: Shift[]; menus: Menu[]; staff: Staff[]; customers: Customer[];
  /** 店舗ID → お客様ID → その店舗での初来店日時 */
  firstVisits: Record<ID, Record<ID, string>>;
}

export interface NewSaleInput {
  booking_id?: ID|null; customer_id?: ID|null; main_staff_id?: ID|null; discount: number; discount_reason?: string;
  /** 主担当が受付枠・フリーのとき（0013） */ main_label?: string|null; main_lane_id?: ID|null;
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
  // ---- v1.1（0009）：オプショングループ ----
  /** null＝0009未適用（準備中）。非表示も含む */
  optionGroups(): Promise<OptionGroup[]|null>;
  saveOptionGroup(g: Partial<OptionGroup> & { name: string }): Promise<OptionGroup>;
  /** グループを消す（中のオプションはグループなしに戻る） */
  deleteOptionGroup(id: ID): Promise<void>;
  // ---- カルテの手書き（0010） ----
  /** カルテ（複数）の手書きページ。null＝0010未適用（準備中） */
  kartePages(entryIds: ID[]): Promise<KartePage[]|null>;
  /** そのカルテの手書きページをまとめて保存（無くなったページは消す）。画像と写真もここでアップロード */
  saveKartePages(entryId: ID, pages: KartePageDraft[]): Promise<KartePage[]>;
  /** 背景テンプレ。all＝設定画面用（非表示・他店舗のものも）。null＝0010未適用 */
  karteBackgrounds(all?: boolean): Promise<KarteBackground[]|null>;
  /** 背景テンプレを保存（owner・manager）。image を渡すと画像を差し替える */
  saveKarteBackground(b: Partial<KarteBackground> & { name: string }, image?: Blob|null): Promise<KarteBackground>;
  /** 保存した画像・写真を表示できるURLにする（本番は期限つきURL） */
  karteFileUrls(paths: string[]): Promise<Record<string, string>>;
  /** 画像そのもの（手書き画面の背景に描くため） */
  karteFileBlob(path: string): Promise<Blob>;
  // ---- HPBの予約メール取り込み（0011） ----
  /** null＝0011未適用（準備中）。まだ保存していない店は既定値 */
  hpbSettings(): Promise<HpbSettings|null>;
  saveHpbSettings(patch: Partial<Omit<HpbSettings, 'store_id'>>): Promise<HpbSettings>;
  /** null＝0011未適用 */
  hpbMappings(): Promise<HpbMapping[]|null>;
  saveHpbMapping(m: Partial<HpbMapping> & { kind: HpbMapping['kind']; pattern: string }): Promise<HpbMapping>;
  deleteHpbMapping(id: ID): Promise<void>;
  /** 受信ログ（新しい順）。null＝0011未適用 */
  inboundMails(limit?: number): Promise<InboundMail[]|null>;
  /** 再処理・手で直す・無視・テストメール（本番はサーバの /api/inbound/hpb/admin を通す） */
  hpbAction(a: HpbAction): Promise<HpbActionResult>;
  // ---- 顧客CSV取り込み（0012） ----
  /** 会社のお客様（突き合わせ用。統合済みは除く） */
  importIndex(): Promise<Customer[]>;
  /** この店舗の旧POSの来店の重複チェック用キー（取り込み元ごと） */
  histKeys(source: ImportSource): Promise<Set<string>>;
  runCustomerImport(req: CustomerImportRequest, onProgress?: ImportProgress): Promise<ImportLog>;
  runVisitImport(req: VisitImportRequest, onProgress?: ImportProgress): Promise<ImportLog>;
  /** 取り込みの記録（新しい順）。null＝0012未適用 */
  importLogs(): Promise<ImportLog[]|null>;
  /** 取り込みの取り消し：その取り込みで作ったお客様（予約・会計・カルテが無い人だけ）と来店履歴を消す */
  undoImport(id: ID): Promise<{ removed: number; kept: number; visits: number }>;
  /** null＝0012未適用 */
  importPresets(): Promise<ImportPreset[]|null>;
  saveImportPreset(p: ImportPreset): Promise<void>;
  /** そのお客様の旧POSの来店（全店舗）。null＝0012未適用 */
  historicalVisits(customerId: ID): Promise<HistVisit[]|null>;
  // ---- 0013 ----
  /** 予約の変更の記録（古い順）。null＝0013未適用（準備中） */
  bookingHistory(bookingId: ID): Promise<BookingHistoryEntry[]|null>;
  /** リピート率推移表の材料：to（含まない）までの全期間の来店。旧POSの来店も入れる */
  repeatSource(storeIds: ID[], to: string): Promise<RepeatSource>;
  /** 区分の決め方を保存（owner・manager。0013 の後） */
  saveRepeatRules(storeId: ID, rules: RepeatRules): Promise<void>;
}
export type { HpbMapping, HpbSettings, InboundMail, InboundStatus } from '../inbound/process';
import type { HpbMapping, HpbSettings, InboundMail } from '../inbound/process';
import type { HpbManualFix } from '../inbound/hpb';
import type { TestMailOptions } from '../inbound/testMail';
export type HpbAction =
  | { kind: 'reprocess'; mail_id: ID }
  | { kind: 'fix'; mail_id: ID; manual: HpbManualFix }
  | { kind: 'ignore'; mail_id: ID }
  | { kind: 'test'; test: TestMailOptions };
export interface HpbActionResult { ok: boolean; status?: string; action?: string|null; mail_id?: ID; booking_ids?: ID[]; message?: string }
