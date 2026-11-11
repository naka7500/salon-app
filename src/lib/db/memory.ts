// デモ用（Supabase未設定時）。ブラウザの localStorage に保存する。本番では supabase.ts を使う。
// 店舗ごとに別のデータを持ち、ヘッダーの店舗切替で行き来できる。
import type { BookingHistoryEntry, HistorySource, RepeatRules, RepeatSource, RepeatVisit, RepeatSummary, HpbSettings, HpbMapping, InboundMail, Repo, ImportLog, ImportPreset, ImportSource, HistVisit, HistSummaryInput, Store, Staff, StaffInput, Resource, Lane, Menu, Product, Customer, Booking, Sale, SaleLine, Payment, RegisterClosing, InventoryMove, KarteEntry, NewSaleInput, ID, ShiftPattern, Shift, ShiftMonth, ShiftKind, StoreGoal, PayMethod, Channel, Coupon, AppNotification, AuditLog, OptionGroup, KartePage, KartePageImage, KarteBackground } from './types';
import { KARTE_PAGE_IMAGES_MAX } from './types';
import { AUTO_IDLE_NOTE, onLedger, byStaffOrder, isTestStore, DEFAULT_REPEAT_RULES } from './types';
import { pickHistory, worthRecording, opOf } from '../tracking';
import { normRules } from '../repeat';
import { validateSale, saleTotals } from '../pos';
import { defaultLineSettings, type LineSettings } from '../line/types';
import { memoryLineIO, emptyLineState, type LineMemState } from '../line/memoryIO';
import { canMerge, decideRequestError, isOwnerCheck, openRequests, samePhoneCustomers, type LineLinkRequest } from '../line/linkPolicy';
import { applyLink, type LinkApplyIO } from '../line/linkApply';
import { handleEvents, runCron, sampleMessages, type LineIO, type LineSender } from '../line/engine';
import { checkTemplate, previewText } from '../line/templates';
import { vacancyRateOf } from '../line/vacancy';
import { MANUAL_BATCH_MAX, MANUAL_KIND, MANUAL_PER_STORE_PER_HOUR, canSendManual, directSendError, manualSendError, manualTextError, type ManualResult } from '../line/manual';
import { generateTempPassword, isValidEmail, loginPermissionError, normalizeEmail, canSeeLoginStatus, checkNewPassword, isUserRole, type LoginStatus, type StaffLoginHistory, type StaffLoginAction, type StaffLoginResult } from '../staffLogin';
import { ingestHpbMail, processStoredMail, type InboundIO } from '../inbound/process';
import { makeTestMail } from '../inbound/testMail';
import { planAutoIdle, lastOrderOffset } from '../schedule';
import { webSlots, menuLane, menuPeople, publishedNow, couponPrice, cancelDeadline, normPhone, optionChoices, optionError, optionTotals, bookingMenuLabel, webBookableWith, type PublicApi, type PublicStore, type PublicCatalog, type PublicMenu, type PublicBookingInput, type PublicBookingResult } from '../web';

export const STORE_HAKOZAKI = 'aaaaaaaa-0000-0000-0000-000000000001';
export const STORE_GOTANDA = 'aaaaaaaa-0000-0000-0000-000000000002';
export const STORE_TEST = 'aaaaaaaa-0000-0000-0000-000000000099';
const COMPANY_TEST = '33333333-3333-3333-3333-333333333333';
const COMPANY_BC5 = '11111111-1111-1111-1111-111111111111';
const COMPANY_KOKAGE = '22222222-2222-2222-2222-222222222222';

const uid = () => (typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const nowIso = () => new Date().toISOString();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const localDate = (iso: string) => ymd(new Date(iso));

interface State {
  store: Store; staff: Staff[]; resources: Resource[]; lanes: Lane[]; menus: Menu[]; products: Product[]; customers: Customer[];
  bookings: Booking[]; sales: Sale[]; closings: RegisterClosing[]; moves: InventoryMove[]; kartes: KarteEntry[];
  shiftPatterns: ShiftPattern[]; shifts: Shift[]; shiftMonths: ShiftMonth[]; goals: StoreGoal[];
  // フェーズC
  coupons: Coupon[]; notifications: AppNotification[]; audits: AuditLog[];
  // v1.1（0009）
  optionGroups: OptionGroup[];
  // カルテの手書きページ（0010）。画像は別のキー（DEMO_IMG）に data URL で置く
  kartePages?: KartePage[];
  // HPBの予約メール取り込み（0011）
  hpbSettings?: HpbSettings|null; hpbMappings?: HpbMapping[]; inboundMails?: InboundMail[];
  // 顧客CSV取り込み（0012）
  importLogs?: ImportLog[]; histVisits?: HistVisit[];
  // 0013：予約トラッキング・リピート率の区分の決め方
  bookingHistory?: BookingHistoryEntry[]; repeatRules?: RepeatRules;
  // 0015：LINE連携（デモ。秘密は保存しない＝「保存した日時」だけ）
  lineSettings?: LineSettings; line?: LineMemState; lineTokens?: { token: string; customer_id: ID; expires_at: string; used_at?: string|null }[];
  /** 0020：LINE連携の確認待ち（デモ） */
  lineLinkRequests?: LineLinkRequest[];
  /** 先の日付の受付枠IDLE（シフトから自動）を入れたか */
  idleSeeded?: boolean;
  /** デモのログインの状態（本物のログインは作らない。仮パスワードも保存しない） */
  staffLogins?: Record<ID, { status: LoginStatus; email?: string|null; prev?: LoginStatus; must_change?: boolean }>; loginHistory?: StaffLoginHistory[];
}

// ---- デモ用の過去・未来データ（決まった乱数で毎回同じ） ----
function rng(seed: number) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const hhmm = (m: number) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;

export function defaultPatterns(store: Store): ShiftPattern[] {
  const o = store.open_time.slice(0,5), c = store.close_time.slice(0,5);
  const [oh, om] = o.split(':').map(Number), [ch, cm] = c.split(':').map(Number);
  const P = (i: number, name: string, kind: ShiftKind, color: string, st: string|null, en: string|null): ShiftPattern => ({ id: `${store.id}-pt${i}`, store_id: store.id, name, kind, start_time: st, end_time: en, color, sort_order: i, active: true });
  return [
    P(1, '通し', 'work', '#2f6b4f', o, c),
    P(2, '早番', 'work', '#d9a441', o, hhmm(oh*60+om+6*60)),
    P(3, '遅番', 'work', '#7a9cd9', hhmm(ch*60+cm-6*60), c),
    P(4, '休', 'off', '#d6d3d1', null, null),
    P(5, '有給', 'paid', '#f9a8d4', null, null),
    P(6, '店休', 'closed', '#78716c', null, null),
    P(7, '夏季冬季休暇', 'seasonal', '#99f6e4', null, null),
  ];
}

/** デモの過去・未来データ：過去 months か月＝会計済み（キャンセル・無断・店販・値引・赤伝も少し）、今日〜1か月先＝予約。
 *  シフトも同じ期間（来月だけ未入力＝「先月をコピー」の練習用）。closedDow の曜日は店休。
 *  IDは決まった文字列（保存に失敗して作り直しても同じIDになるように）。 */
function demoHistory(st: State, seed: number, closedDow: number, skipToday: boolean, months = 6) {
  const r = rng(seed); const S = st.store.id; let n = 0; const nid = (k: string) => `${S.slice(-3)}-${k}${++n}`;
  const tech = st.menus.filter(m => m.category === 'technical' && (m.people ?? 1) === 1);
  const opts = st.menus.filter(m => m.category === 'option' && m.price > 0 && !m.option_group_id);
  const now = new Date(); const today = ymd(now);
  const start = new Date(now.getFullYear(), now.getMonth() - months, 1);
  const end = new Date(now); end.setDate(end.getDate() + 31);
  const nextMonth1 = ymd(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  const pts = st.shiftPatterns; const pt = (name: string) => pts.find(p => p.name === name)!;
  const toM = (t?: string|null) => { const [h, m] = (t || '0:0').split(':').map(Number); return h * 60 + m; };
  const pool = st.customers; let nextNew = 0;                       // 新規は名簿の先頭から順に初来店
  const last: Record<ID, string> = {};                              // お客様の直近の会計日時
  const seqByDay: Record<string, number> = {};
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = ymd(d); const w = d.getDay();
    // ---- シフト（来月分は入れない） ----
    const dayShifts: Shift[] = [];
    if (day < nextMonth1) st.staff.forEach((s, i) => {
      const p = w === closedDow ? pt('店休') : i === 0 ? (w === 0 ? pt('休') : pt('通し')) : (w === 3 || w === 6 ? pt('休') : (w % 2 ? pt('早番') : pt('遅番')));
      const sh: Shift = { id: nid('sh'), store_id: S, staff_id: s.id, date: day, kind: p.kind, pattern_id: p.id, start_time: p.start_time, end_time: p.end_time, is_store_closed: p.kind === 'closed', break_missed: false, break_start: null, break_end: null };
      st.shifts.push(sh); dayShifts.push(sh);
    });
    if (w === closedDow || (skipToday && day === today)) continue;
    const past = day < today;
    // シフトが無い日（来月）は通常どおりの人員で予約だけ作る
    const workers = day < nextMonth1 ? dayShifts.filter(x => x.kind === 'work') : st.staff.map((s, i) => ({ staff_id: s.id, start_time: st.store.open_time, end_time: i === 0 ? st.store.close_time : '16:00' } as Shift));
    for (const wk of workers) {
      const staff = st.staff.find(x => x.id === wk.staff_id)!;
      let t = toM(wk.start_time); const endM = toM(wk.end_time);
      const fill = past ? 0.42 + r() * 0.3 : Math.max(0.1, 0.55 - (d.getTime() - now.getTime()) / 86400000 / 40);   // 先の日ほど埋まっていない
      while (t + 60 <= endM) {
        const m = tech[Math.floor(r() * tech.length)];
        if (t + m.duration_min > endM) break;
        if (r() > fill) { t += 15 * (2 + Math.floor(r() * 4)); continue; }
        // お客様：3割が新規（名簿の未来店の人）、残りは来店済みの人
        const visited = Object.keys(last);
        const isNew = visited.length < 5 || (r() < 0.22 && nextNew < pool.length);
        const cust = isNew && nextNew < pool.length ? pool[nextNew++] : pool.find(c => c.id === visited[Math.floor(Math.pow(r(), 0.7) * visited.length)]) || pool[0];
        const startIso = at(day, Math.floor(t / 60), t % 60), endIso = at(day, Math.floor((t + m.duration_min) / 60), (t + m.duration_min) % 60);
        const ch: Channel = isNew ? (r() < 0.75 ? 'hpb' : (['own', 'line', 'phone'] as const)[Math.floor(r() * 3)]) : (['hpb', 'own', 'own', 'line', 'phone'] as const)[Math.floor(r() * 5)];
        // 予約が入った日時：前回の会計時に次回予約（55%）／それ以外は1〜14日前
        const prev = last[cust.id];
        const created = prev && r() < 0.55 && new Date(startIso).getTime() - new Date(prev).getTime() < 100 * 86400000 ? prev : new Date(new Date(startIso).getTime() - (1 + Math.floor(r() * 14)) * 86400000).toISOString();
        const roll = r();
        const status = past ? (roll < 0.05 ? 'cancelled' : roll < 0.065 ? 'noshow' : 'done') : 'booked';
        const b: Booking = { id: nid('b'), store_id: S, customer_id: cust.id, staff_id: staff.id, resource_id: st.resources[0]?.id, start_at: startIso, end_at: endIso, status, channel: ch, menu_ids: [m.id], nominated: !isNew && r() < 0.35, created_at: created < startIso ? created : startIso, updated_at: created };
        st.bookings.push(b);
        if (status === 'done') {
          const seq = (seqByDay[day] = (seqByDay[day] || 0) + 1);
          const id = nid('s');
          const lines: SaleLine[] = [{ id: nid('l'), sale_id: id, kind: 'menu', menu_id: m.id, name: m.name, unit_price: m.price, qty: 1, tax_rate: 0.1, staff_id: staff.id, amount: m.price }];
          if (opts.length && r() < 0.2) { const o = opts[Math.floor(r() * opts.length)]; lines.push({ id: nid('l'), sale_id: id, kind: 'option', menu_id: o.id, name: o.name, unit_price: o.price, qty: 1, tax_rate: 0.1, staff_id: staff.id, amount: o.price }); b.menu_ids.push(o.id); }
          if (st.products.length && r() < 0.15) { const pr = st.products[Math.floor(r() * st.products.length)]; lines.push({ id: nid('l'), sale_id: id, kind: 'product', product_id: pr.id, name: pr.name, unit_price: pr.price, qty: 1, tax_rate: 0.1, staff_id: staff.id, amount: pr.price }); }
          const subtotal = lines.reduce((a, l) => a + l.amount, 0);
          const discount = isNew && ch === 'hpb' && r() < 0.6 ? 1000 : 0;
          const total = subtotal - discount;
          const pm: PayMethod = (['cash', 'card', 'card', 'qr', 'emoney'] as const)[Math.floor(r() * 5)];
          const paid = pm === 'cash' ? Math.ceil(total / 1000) * 1000 : total;   // 現金はお預かり（お釣りあり）
          const sale: Sale = { id, store_id: S, booking_id: b.id, customer_id: cust.id, main_staff_id: staff.id, sale_no: `${day.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`, sold_at: endIso, status: 'confirmed', subtotal, discount, tax: Math.floor(total - total / 1.1), total, discount_reason: discount ? 'HPB新規クーポン' : null, closed_on: day,
            lines, payments: [{ id: nid('p'), sale_id: id, method: pm, amount: paid }] };
          st.sales.push(sale);
          // 1%は赤伝（打ち間違い→取消）
          if (r() < 0.01) {
            sale.status = 'voided'; const rid = nid('s');
            st.sales.push({ ...sale, id: rid, sale_no: sale.sale_no + '-R', sold_at: new Date(new Date(endIso).getTime() + 5 * 60000).toISOString(), status: 'reversal', reverses_sale_id: id, subtotal: -subtotal, discount: -discount, tax: -sale.tax, total: -total, note: '赤伝：打ち間違い',
              lines: lines.map(l => ({ ...l, id: nid('l'), sale_id: rid, qty: -l.qty, amount: -l.amount })), payments: sale.payments.map(p => ({ ...p, id: nid('p'), sale_id: rid, amount: -p.amount })) });
          } else last[cust.id] = endIso;
        }
        t += m.duration_min + m.interval_min + (r() < 0.3 ? 15 : 0);
      }
    }
  }
}
function extraCustomers(company: string, prefix: string, n: number): Customer[] {
  const fam = ['佐藤','鈴木','高橋','田中','伊藤','渡辺','山本','中村','小林','加藤','吉田','山田','松本','井上','木村'];
  const giv = ['葵','結衣','陽菜','美月','莉子','楓','七海','真央','彩花','優奈','明日香','沙織','千尋','舞','遥'];
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-x${i+1}`, company_id: company, name: `${fam[i % fam.length]} ${giv[(i*7 + Math.floor(i / 15)) % giv.length]}`, gender: i % 6 === 0 ? '男性' : i % 11 === 0 ? null : '女性', source: i % 3 ? 'hpb' : 'own', created_at: '2026-01-01T00:00:00.000Z' }));
}

const at = (day: string, h: number, m = 0) => new Date(`${day}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`).toISOString();
const mkMenu = (store: string, id: string, name: string, short: string, color: string, price: number, dur: number, cat: 'technical'|'option' = 'technical', iv = 10): Menu =>
  ({ id, store_id: store, name, short_name: short, color, category: cat, price, tax_rate: 0.1, duration_min: dur, interval_min: iv, sort_order: 0, active: true, target: 'all', nominatable: true, web_visible: cat === 'technical' && price > 0, ...(MENU_WEB[id] || {}) });
/** デモのメニューの説明・英語名など（フェーズC） */
const MENU_WEB: Record<string, Partial<Menu>> = {
  'g-m1': { name_en: '90-min Sublimic Head Spa', description: '頭皮の汚れを落としながら、深いリラックスへ。初めての方にもおすすめの定番コースです。', description_en: 'Our signature course: deep scalp cleansing and full relaxation.' },
  'g-m2': { name_en: '90-min Relaxation Head Spa', description: '眠ってしまう方が多い、ほぐし中心のコース。', description_en: 'A deeply relaxing course focused on massage.' },
  'g-m3': { name_en: '90-min Hair Growth Head Spa', description: '抜け毛・細毛が気になる方へ。育毛エッセンスで頭皮環境を整えます。', description_en: 'For thinning hair. Scalp care with growth essence.' },
  'g-m4': { name_en: 'Quick Head Spa 60 min', description: 'お仕事帰りにも。60分でしっかりほぐします。', description_en: 'A quick 60-minute refresh.' },
  'g-m5': { name_en: 'Weekday 90-min Head Spa', description: '平日限定のお得な90分コース。', description_en: 'Weekday-only 90-minute course.', weekdays: [1, 2, 3, 4, 5] },
  'm1': { name_en: 'Lash Lift', description: '自まつ毛を根元から立ち上げ、ぱっちりした目元に。' }, 'm2': { name_en: 'Lash Extensions 100', description: '自然なボリュームの100本。' }, 'm3': { name_en: 'Lash Extensions 120', description: 'しっかり華やかな120本。' },
  't-m1': { name_en: 'Lash Lift', description: '自まつ毛を根元から立ち上げます（練習用メニュー）。', description_en: 'Lifts your natural lashes from the root.' },
  't-m2': { name_en: 'Lash Extensions 100', description: '自然なボリュームの100本（練習用メニュー）。', description_en: 'Natural volume with 100 extensions.' },
  't-m3': { name_en: 'Brow Wax', description: '眉の形を整えます（練習用メニュー）。', description_en: 'Brow shaping with wax.' },
};
const mkCoupon = (store: string, id: string, name: string, kind: Coupon['kind'], value: number, menu_ids: string[], x: Partial<Coupon> = {}): Coupon =>
  ({ id, store_id: store, name, kind, value, menu_ids, target: 'all', web_visible: true, sort_order: 0, active: true, ...x });

const WEB_DEFAULTS: Partial<Store> = { phone: '03-0000-0000', cancel_deadline_days: 1, cancel_deadline_time: '18:00', booking_horizon_days: 60, booking_lead_min: 60, cancel_policy: '前日18時以降のキャンセル・変更はお電話でお願いします。', intake_questions: null, notify_email: null };

/** 先の日付に、シフトから受付枠IDLEを自動で置く（デモでネット予約の空きが出るように）。手で置いた日はそのまま */
function seedFutureIdle(st: State) {
  const today = ymd(new Date());
  const offset = lastOrderOffset(st.store, st.menus).min;
  const days = [...new Set(st.shifts.filter(x => x.date >= today && x.kind === 'work').map(x => x.date))].sort();
  for (const d of days) {
    if (st.bookings.some(b => b.status === 'block' && b.lane_id && localDate(b.start_at) === d)) continue;
    for (const p of planAutoIdle(d, st.shifts, st.lanes, offset)) st.bookings.push({ id: uid(), store_id: st.store.id, lane_id: p.lane_id, staff_id: null, start_at: at(d, Math.floor(p.from / 60), p.from % 60), end_at: at(d, Math.floor(p.to / 60), p.to % 60), status: 'block', channel: 'block', block_kind: 'idle', menu_ids: [], nominated: false, note: AUTO_IDLE_NOTE, created_at: nowIso(), updated_at: nowIso() });
  }
  st.idleSeeded = true;
}

function seedHakozaki(): State {
  const S = STORE_HAKOZAKI, C = COMPANY_BC5;
  const staff: Staff[] = [
    { id: 'bbbbbbbb-0000-0000-0000-000000000001', company_id: C, name: '飯田', role: 'manager', active: true },
    { id: 'bbbbbbbb-0000-0000-0000-000000000002', company_id: C, name: 'スタッフ2', role: 'staff', active: true },
  ];
  const resources: Resource[] = [
    { id: 'r1', store_id: S, name: 'ベッド1', kind: 'bed', sort_order: 1, active: true },
    { id: 'r2', store_id: S, name: 'ベッド2', kind: 'bed', sort_order: 2, active: true },
  ];
  const lanes: Lane[] = [ { id: 'l1', store_id: S, name: 'ネット予約枠', capacity: 1, sort_order: 1, active: true } ];
  const menus = [
    mkMenu(S,'m1','まつ毛パーマ','パーマ','#d9a441',6600,60), mkMenu(S,'m2','マツエク 100本','100本','#e07a9a',7700,75), mkMenu(S,'m3','マツエク 120本','120本','#c8559a',8800,90),
    mkMenu(S,'m4','パリジェンヌラッシュリフト','パリ','#7a9cd9',7700,60), mkMenu(S,'m5','眉Wax','眉','#8cc084',4400,30,'technical',5), mkMenu(S,'m6','まつ毛パーマ＋眉Wax','パーマ+眉','#d98c5f',9900,90),
    mkMenu(S,'o1','コーティング','コート','#bbbbbb',1100,5,'option',0), mkMenu(S,'o2','予約割引（次回予約）','次回割','#bbbbbb',-500,0,'option',0),
  ];
  const products: Product[] = [
    { id: 'p1', store_id: S, name: 'まつ毛美容液', price: 3300, cost: 1500, tax_rate: 0.1, stock: 10, reorder_point: 3, active: true },
    { id: 'p2', store_id: S, name: 'コーティング剤（ホームケア）', price: 2200, cost: 900, tax_rate: 0.1, stock: 8, reorder_point: 3, active: true },
    { id: 'p3', store_id: S, name: 'アイシャンプー', price: 1980, cost: 800, tax_rate: 0.1, stock: 6, reorder_point: 2, active: true },
  ];
  const customers: Customer[] = [
    { id: 'c1', company_id: C, name: 'サンプル 花子', kana: 'サンプル ハナコ', phone: '090-0000-0001', source: 'hpb', created_at: nowIso() },
    { id: 'c2', company_id: C, name: 'サンプル 美咲', kana: 'サンプル ミサキ', phone: '090-0000-0002', source: 'line', created_at: nowIso() },
    { id: 'c3', company_id: C, name: 'サンプル 彩', kana: 'サンプル アヤ', phone: '090-0000-0003', source: 'own', created_at: nowIso() },
  ];
  const d = ymd(new Date());
  const B = (x: Partial<Booking>): Booking => ({ id: uid(), store_id: S, status: 'booked', channel: 'own', menu_ids: [], nominated: false, created_at: nowIso(), updated_at: nowIso(), start_at: '', end_at: '', ...x });
  const bookings: Booking[] = [
    B({ customer_id: 'c1', staff_id: staff[0].id, resource_id: 'r1', start_at: at(d,10,30), end_at: at(d,11,40), channel: 'hpb', external_ref: 'YH-SAMPLE1', menu_ids: ['m1'], nominated: true }),
    B({ customer_id: 'c2', staff_id: staff[0].id, resource_id: 'r1', start_at: at(d,13,0), end_at: at(d,14,40), channel: 'own', menu_ids: ['m3'] }),
    B({ customer_id: 'c3', staff_id: staff[1].id, resource_id: 'r2', start_at: at(d,15,0), end_at: at(d,16,40), channel: 'line', menu_ids: ['m6'], nominated: true }),
    B({ lane_id: 'l1', status: 'block', channel: 'block', block_kind: 'idle', start_at: at(d,10,0), end_at: at(d,19,0) }),
  ];
  return {
    store: { id: S, company_id: C, company_name: 'BE.COLLECTION.5', company_legal_name: '株式会社BE.COLLECTION.5', name: 'ラシエル箱崎', business_type: 'eyelash', open_time: '10:00', close_time: '19:00', slot_minutes: 15, hpb_salon_id: 'H000805291', ...WEB_DEFAULTS, slug: 'laciel-hakozaki', name_en: 'Laciel Hakozaki', web_booking_enabled: false, room_count: null, start_step_min: 30 },
    staff, resources, lanes, menus, products, customers, bookings, sales: [], closings: [], moves: [], kartes: [],
    shiftPatterns: [], shifts: [], shiftMonths: [], goals: [],
    coupons: [mkCoupon(S, 'h-cp1', '【新規】まつ毛パーマ 1,000円引き', 'amount', 1000, ['m1'], { target: 'new', sort_order: 1 }), mkCoupon(S, 'h-cp2', '【再来】前回から45日以内 500円引き', 'amount', 500, [], { target: 'repeat', within_days: 45, sort_order: 2 })],
    notifications: [], audits: [], optionGroups: [],
  };
}
function seedHakozakiFull(): State { const st = seedHakozaki(); st.customers.push(...extraCustomers(st.store.company_id, 'h', 300)); st.shiftPatterns = defaultPatterns(st.store); demoHistory(st, 7, 2, true); seedFutureIdle(st); seedTracking(st); return st; }

function seedGotanda(): State {
  const S = STORE_GOTANDA, C = COMPANY_KOKAGE;
  const staff: Staff[] = [
    { id: 'bbbbbbbb-0000-0000-0000-000000000011', company_id: C, name: '菊池', role: 'manager', active: true },
    { id: 'bbbbbbbb-0000-0000-0000-000000000012', company_id: C, name: '富塚', role: 'staff', active: true },
  ];
  const resources: Resource[] = [1,2,3].map(i => ({ id: `g-r${i}`, store_id: S, name: `個室${i}`, kind: 'room', sort_order: i, active: true }));
  const lanes: Lane[] = [
    { id: 'g-l1', store_id: S, name: '1名様でのご予約', capacity: 1, sort_order: 1, active: true },
    { id: 'g-l2', store_id: S, name: '2名様でのご予約（ペア予約）', capacity: 2, sort_order: 2, active: true },
  ];
  const menus = [
    mkMenu(S,'g-m1','90分サブリミックヘッドスパ','90分サブ','#e8547a',13200,90,'technical',0),
    mkMenu(S,'g-m2','90分リラクゼーションヘッドスパ','90分リラ','#b57edc',13200,90,'technical',0),
    mkMenu(S,'g-m3','90分育毛ヘッドスパ','90分育毛','#2bb3a3',14300,90,'technical',0),
    mkMenu(S,'g-m4','クイックヘッドスパ 60分','クイック','#c5d94b',9900,60,'technical',0),
    mkMenu(S,'g-m5','平日90分ヘッドスパ','平日90分','#d9534f',11000,90,'technical',0),
    mkMenu(S,'g-o1','ヘッドスキンケア追加','スキンケア','#bbbbbb',3300,15,'option',0),
    { ...mkMenu(S,'g-m6','ペア 90分ヘッドスパ（2名様）','ペア90','#d98c5f',26400,90,'technical',0), people: 2, lane_id: 'g-l2', name_en: 'Pair 90-min Head Spa (2 guests)', description: 'お二人で同じ時間に。料金は2名様1組の料金です。', description_en: 'Two guests at the same time. Price is per pair.' },
  ];
  const products: Product[] = [
    { id: 'g-p1', store_id: S, name: 'スカルプシャンプー', price: 4400, cost: 1800, tax_rate: 0.1, stock: 6, reorder_point: 2, active: true },
    { id: 'g-p2', store_id: S, name: '育毛エッセンス', price: 6600, cost: 2800, tax_rate: 0.1, stock: 4, reorder_point: 2, active: true },
  ];
  const customers: Customer[] = [
    { id: 'g-c1', company_id: C, name: 'サンプル 里奈', kana: 'サンプル リナ', phone: '090-0000-0011', source: 'hpb', created_at: nowIso() },
    { id: 'g-c2', company_id: C, name: 'サンプル ひとみ', kana: 'サンプル ヒトミ', phone: '090-0000-0012', source: 'own', created_at: nowIso() },
    { id: 'g-c3', company_id: C, name: 'Sample Kim', kana: 'キム', source: 'viator', created_at: nowIso() },
  ];
  const d = ymd(new Date());
  const B = (x: Partial<Booking>): Booking => ({ id: uid(), store_id: S, status: 'booked', channel: 'own', menu_ids: [], nominated: false, created_at: nowIso(), updated_at: nowIso(), start_at: '', end_at: '', ...x });
  const bookings: Booking[] = [
    // 受付枠（ネット予約の受け皿）
    B({ lane_id: 'g-l1', status: 'block', channel: 'block', block_kind: 'idle', start_at: at(d,10,0), end_at: at(d,12,30) }),
    B({ lane_id: 'g-l1', status: 'block', channel: 'block', block_kind: 'idle', start_at: at(d,13,0), end_at: at(d,14,30) }),
    B({ lane_id: 'g-l1', status: 'block', channel: 'block', block_kind: 'idle', start_at: at(d,17,30), end_at: at(d,19,0) }),
    B({ lane_id: 'g-l2', status: 'block', channel: 'block', block_kind: 'idle', start_at: at(d,10,0), end_at: at(d,12,0) }),
    B({ lane_id: 'g-l2', status: 'block', channel: 'block', block_kind: 'close', start_at: at(d,18,0), end_at: at(d,19,0) }),
    // スタッフ行
    B({ customer_id: 'g-c1', staff_id: staff[0].id, resource_id: 'g-r1', lane_id: 'g-l1', start_at: at(d,11,0), end_at: at(d,12,0), channel: 'hpb', external_ref: 'HPB-SAMPLE', menu_ids: ['g-m4'] }),
    B({ customer_id: 'g-c2', staff_id: staff[0].id, resource_id: 'g-r1', start_at: at(d,13,0), end_at: at(d,14,30), channel: 'own', menu_ids: ['g-m1'] }),
    B({ customer_id: 'g-c3', staff_id: staff[1].id, resource_id: 'g-r2', start_at: at(d,15,0), end_at: at(d,16,30), channel: 'viator', external_ref: 'BR-SAMPLE', menu_ids: ['g-m2'] }),
    B({ staff_id: staff[1].id, status: 'block', channel: 'block', block_kind: 'break', start_at: at(d,12,0), end_at: at(d,13,0) }),
    B({ customer_id: 'g-c1', staff_id: staff[0].id, resource_id: 'g-r1', start_at: at(d,17,30), end_at: at(d,19,0), channel: 'hpb', menu_ids: ['g-m3'] }),
  ];
  return {
    store: { id: S, company_id: C, company_name: '株式会社KOKAGE', name: 'KOKAGE西五反田', business_type: 'headspa', open_time: '10:00', close_time: '19:00', slot_minutes: 15, hpb_salon_id: 'H000719142', ...WEB_DEFAULTS, slug: 'kokage-gotanda', name_en: 'KOKAGE Nishigotanda', web_booking_enabled: true, room_count: 3, start_step_min: 30 },
    staff, resources, lanes, menus, products, customers, bookings, sales: [], closings: [], moves: [], kartes: [],
    shiftPatterns: [], shifts: [], shiftMonths: [], goals: [],
    coupons: [
      mkCoupon(S, 'g-cp1', '【新規】90分サブリミックヘッドスパ 初回特別価格', 'fixed', 9900, ['g-m1'], { target: 'new', sort_order: 1, name_en: 'First visit: 90-min Sublimic Head Spa', description: '初めての方限定。人気No.1の90分コースを特別価格で。' }),
      mkCoupon(S, 'g-cp2', '【再来】前回から45日以内のメンテナンス 10%オフ', 'percent', 10, [], { target: 'repeat', within_days: 45, sort_order: 2, name_en: 'Maintenance within 45 days: 10% off', description: '前回のご来店から45日以内のご予約で、全コース10%オフ。' }),
      mkCoupon(S, 'g-cp3', '【平日限定】クイックヘッドスパ 60分', 'fixed', 8800, ['g-m4'], { weekdays: [1, 2, 3, 4, 5], sort_order: 3, name_en: 'Weekdays: Quick Head Spa 60 min' }),
    ],
    notifications: [], audits: [], optionGroups: [],
  };
}
function seedGotandaFull(): State { const st = seedGotanda(); st.customers.push(...extraCustomers(st.store.company_id, 'g', 300)); st.shiftPatterns = defaultPatterns(st.store); demoHistory(st, 11, 2, true); seedFutureIdle(st); addHelpStaff(st); seedTracking(st); return st; }
/** ほかの店舗からのヘルプの人（台帳には出さない。会計の明細担当では選べる） */
const HELP_STAFF_ID = 'bbbbbbbb-0000-0000-0000-000000000019';
function addHelpStaff(st: State) {
  if (st.store.id !== STORE_GOTANDA || st.staff.some(x => x.id === HELP_STAFF_ID)) return;
  st.staff.push({ id: HELP_STAFF_ID, company_id: st.store.company_id, name: '鮎川（博多からヘルプ）', role: 'staff', active: true, show_on_ledger: false, web_nominatable: false, nomination_fee: 0, color: '#6b8e9f', sort_order: 9, home_store_id: 'aaaaaaaa-0000-0000-0000-0000000000a1', store_ids: ['aaaaaaaa-0000-0000-0000-0000000000a1'] });
}
/** デモの予約トラッキング：今日の見本の予約に「登録」、HPBの見本には「担当の変更」も入れておく */
function seedTracking(st: State) {
  if (st.bookingHistory) return;
  st.bookingHistory = [];
  const today = ymd(new Date());
  const day = (n: number, h: number) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, 12, 31, 0); return d.toISOString(); };
  for (const b of st.bookings.filter(x => x.status !== 'block' && localDate(x.start_at) === today && x.customer_id && !x.customer_id.includes('-x'))) {
    const src: HistorySource = b.channel === 'hpb' ? 'hpb' : b.channel === 'own' ? 'web' : 'ledger';
    const other = st.staff.find(x => x.id !== b.staff_id && onLedger(x));
    const changed = b.external_ref === 'HPB-SAMPLE' && other;
    const first = changed ? { ...b, staff_id: other!.id, lane_id: b.lane_id } : b;
    st.bookingHistory.push({ id: uid(), booking_id: b.id, at: day(6, 16), op: 'insert', source: src, actor_name: src === 'ledger' ? st.staff[0]?.name : null, snapshot: pickHistory(first), before: null });
    if (changed) st.bookingHistory.push({ id: uid(), booking_id: b.id, at: day(2, 15), op: 'update', source: 'ledger', actor_name: st.staff[0]?.name, snapshot: pickHistory(b), before: pickHistory(first) });
  }
}

/** テスト店舗（練習用）：本番のテスト店舗と同じ扱い。データは3か月分だけ */
function seedTest(): State {
  const S = STORE_TEST, C = COMPANY_TEST;
  const staff: Staff[] = [
    { id: 'bbbbbbbb-0000-0000-0000-000000000901', company_id: C, name: '練習A', role: 'manager', active: true },
    { id: 'bbbbbbbb-0000-0000-0000-000000000902', company_id: C, name: '練習B', role: 'staff', active: true },
  ];
  const off = (id: string, name: string, en: string, price: number, min: number, i: number): Menu => ({ ...mkMenu(S, id, name, name, '#bbbbbb', price, min, 'option', 0), option_group_id: 't-og1', web_visible: true, name_en: en, sort_order: 30 + i });
  const menus = [mkMenu(S, 't-m1', 'まつ毛パーマ', 'パーマ', '#d9a441', 6600, 60), { ...mkMenu(S, 't-m2', 'マツエク 100本', '100本', '#e07a9a', 7700, 75), option_group_ids: ['t-og1'] }, mkMenu(S, 't-m3', '眉Wax', '眉', '#8cc084', 4400, 30, 'technical', 5), mkMenu(S, 't-o1', 'コーティング', 'コート', '#bbbbbb', 1100, 5, 'option', 0),
    { ...mkMenu(S, 't-m4', 'ペア まつ毛パーマ（2名様）', 'ペアパーマ', '#7a9cd9', 13200, 60), people: 2, name_en: 'Pair Lash Lift (2 guests)', description: 'お二人で同じ時間に（練習用メニュー）。料金は2名様1組の料金です。', description_en: 'Two guests at the same time. Price is per pair.' },
    off('t-o2', 'オフなし', 'No removal', 0, 0, 1), off('t-o3', '自店オフ', 'Removal (our salon)', 0, 10, 2), off('t-o4', '他店オフ', 'Removal (other salon)', 1100, 15, 3)];
  return {
    store: { id: S, company_id: C, company_name: 'テスト会社（練習用）', name: 'テスト店舗（練習用）', business_type: 'eyelash', open_time: '10:00', close_time: '19:00', slot_minutes: 15, ...WEB_DEFAULTS, slug: 'test-store', name_en: 'Test Salon (practice)', web_booking_enabled: true, web_message: '練習用のテスト店舗です。実際のご予約にはなりません。', room_count: 2, start_step_min: 30 },
    staff, resources: [{ id: 't-r1', store_id: S, name: 'ベッド1', kind: 'bed', sort_order: 1, active: true }], lanes: [{ id: 't-l1', store_id: S, name: 'ネット予約枠', capacity: 1, sort_order: 1, active: true }],
    menus, products: [{ id: 't-p1', store_id: S, name: 'まつ毛美容液', price: 3300, cost: 1500, tax_rate: 0.1, stock: 10, reorder_point: 3, active: true }],
    customers: [], bookings: [], sales: [], closings: [], moves: [], kartes: [], shiftPatterns: [], shifts: [], shiftMonths: [], goals: [],
    coupons: [
      mkCoupon(S, 't-cp1', '【新規】まつ毛パーマ 初回5,500円', 'fixed', 5500, ['t-m1'], { target: 'new', sort_order: 1, name_en: 'First visit: Lash Lift ¥5,500', description: '初めての方限定の特別価格です。' }),
      mkCoupon(S, 't-cp2', '【再来】前回から45日以内 1,000円引き', 'amount', 1000, [], { target: 'repeat', within_days: 45, sort_order: 2, name_en: 'Within 45 days: ¥1,000 off', description: '前回のご来店から45日以内なら、全メニュー1,000円引き。' }),
      mkCoupon(S, 't-cp3', '【平日限定】眉Wax 3,300円（先着10名）', 'fixed', 3300, ['t-m3'], { weekdays: [1, 2, 3, 4, 5], first_n: 10, sort_order: 3 }),
      mkCoupon(S, 't-cp4', 'クーポンコード TEST10（10%オフ）', 'percent', 10, [], { code: 'TEST10', per_customer_limit: 1, sort_order: 4 }),
    ],
    notifications: [], audits: [],
    optionGroups: [{ id: 't-og1', store_id: S, name: 'オフ', name_en: 'Removal', description: '今ついているエクステのオフ（取り外し）', required: true, multi: false, sort_order: 1, active: true }],
  };
}
function seedTestFull(): State { const st = seedTest(); st.customers.push(...extraCustomers(COMPANY_TEST, 't', 120)); st.shiftPatterns = defaultPatterns(st.store); demoHistory(st, 5, 1, false, 3); seedFutureIdle(st); seedTracking(st); return st; }

const SEEDS: Record<string, () => State> = { [STORE_HAKOZAKI]: seedHakozakiFull, [STORE_GOTANDA]: seedGotandaFull, [STORE_TEST]: seedTestFull };
const LIGHT: Record<string, () => State> = { [STORE_HAKOZAKI]: seedHakozaki, [STORE_GOTANDA]: seedGotanda, [STORE_TEST]: seedTest };
/** 古い端末データ（フェーズBまで）に、フェーズCの項目を足す */
/** スタッフの項目（0008）を埋める：所属店舗・表示順・色など */
const STAFF_COLORS = ['#2f6b4f', '#1d5f8a', '#8a3b5c', '#d9a441', '#7a9cd9', '#8cc084', '#d98c5f', '#b57edc', '#e07a9a', '#6b8e9f'];
function normStaff(st: State) {
  st.staff.forEach((x, i) => {
    x.sort_order ??= i + 1; x.show_on_ledger ??= true; x.web_nominatable ??= true; x.nomination_fee ??= 0;
    x.color ??= STAFF_COLORS[i % STAFF_COLORS.length]; x.home_store_id ??= st.store.id; x.store_ids ??= [st.store.id];
  });
}
function upgrade(st: State): State {
  const base = LIGHT[st.store.id]?.();
  st.shiftPatterns ??= defaultPatterns(st.store); st.shifts ??= []; st.shiftMonths ??= []; st.goals ??= [];
  // 0023 相当：夏季冬季休暇のパターンが無い端末データに足す（消した＝active:false のものがあれば足さない）
  if (!st.shiftPatterns.some(p => p.kind === 'seasonal')) { const s7 = defaultPatterns(st.store).find(p => p.kind === 'seasonal'); if (s7) st.shiftPatterns.push(s7); }
  if (base) {
    st.store = { ...base.store, ...st.store, slug: st.store.slug ?? base.store.slug, web_booking_enabled: st.store.web_booking_enabled ?? base.store.web_booking_enabled };
    st.menus = st.menus.map(m => { const b = base.menus.find(x => x.id === m.id); return { target: 'all', nominatable: true, web_visible: m.category === 'technical' && m.price > 0, ...(b ? { name_en: b.name_en, description: b.description, description_en: b.description_en, weekdays: b.weekdays } : {}), ...m }; });
    st.coupons ??= base.coupons;
  }
  addHelpStaff(st); seedTracking(st);
  st.coupons ??= []; st.notifications ??= []; st.audits ??= []; st.importLogs ??= []; st.histVisits ??= []; st.optionGroups ??= base?.optionGroups ?? []; st.kartePages ??= []; st.hpbMappings ??= []; st.inboundMails ??= [];
  normStaff(st);
  if (!st.idleSeeded) { seedFutureIdle(st); save(st); }
  return st;
}
const CUR_KEY = 'salon-app-demo-store';
// v4：過去6か月分の会計・シフト、テスト店舗、目標（v3の端末データは使わず作り直す）
// v5：オプション・ペア・部屋数（v1.1）。v4 の端末データは使わず作り直す
const KEY = (id: string) => `salon-app-demo-v5-${id}`;
for (const old of ['v2', 'v3', 'v4']) { try { if (typeof window !== 'undefined') for (const id of [STORE_HAKOZAKI, STORE_GOTANDA]) localStorage.removeItem(`salon-app-demo-${old}-${id}`); } catch {} }

function currentStoreId(): string {
  if (typeof window === 'undefined') return STORE_GOTANDA;
  try { return localStorage.getItem(CUR_KEY) || STORE_GOTANDA; } catch { return STORE_GOTANDA; }
}
const CACHE: Record<string, State> = {};
function load(id: string = currentStoreId()): State {
  if (!SEEDS[id]) id = STORE_GOTANDA;
  if (typeof window === 'undefined') { const st = SEEDS[id](); normStaff(st); return st; }
  try { const s = localStorage.getItem(KEY(id)); if (s) return upgrade(JSON.parse(s) as State); } catch {}
  // 保存できなかった（容量など）ときも同じ内容を使い回す
  if (CACHE[id]) return CACHE[id];
  const st = SEEDS[id](); normStaff(st); CACHE[id] = st; save(st); return st;
}
let LAST_SAVE_OK = true;
function save(s: State) { CACHE[s.store.id] = s; try { localStorage.setItem(KEY(s.store.id), JSON.stringify(s)); LAST_SAVE_OK = true; } catch { LAST_SAVE_OK = false; } }
/** 直前の save() が端末に書けたか（容量オーバーの検出用） */
function saved(_s: State) { void _s; return LAST_SAVE_OK || typeof window === 'undefined'; }

// ---- デモの画像置き場（カルテの手書き・背景）。本番の Supabase Storage の代わり ----
const DEMO_IMG = 'salon-app-demo-img-';
const DEMO_BG_KEY = 'salon-app-demo-karte-bg';
/** 画像の合計の上限（文字数。localStorage は端末で約5MB） */
const DEMO_IMG_BUDGET = 2_000_000;
function demoImgTotal() { let n = 0; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(DEMO_IMG)) n += localStorage.getItem(k)?.length ?? 0; } } catch {} return n; }
function blobToDataUrl(b: Blob): Promise<string> { return new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => ng(r.error); r.readAsDataURL(b); }); }
async function putDemoImg(b: Blob): Promise<string> {
  const url = await blobToDataUrl(b);
  if (url.length > 1_600_000) throw new Error('画像が大きすぎてデモでは保存できません（本番では保存できます）');
  if (demoImgTotal() + url.length > DEMO_IMG_BUDGET) throw new Error('デモの画像の保存容量（この端末で約2MB）がいっぱいです。デモでは写真の背景は数枚までです（本番ではこの制限はありません）');
  const id = uid();
  try { localStorage.setItem(DEMO_IMG + id, url); } catch { throw new Error('この端末の保存容量がいっぱいで保存できませんでした（デモ）'); }
  return 'demo-img:' + id;
}
function delDemoImg(path: string) { if (path.startsWith('demo-img:')) try { localStorage.removeItem(DEMO_IMG + path.slice(9)); } catch {} }
function demoImgUrl(path: string): string | null {
  if (path.startsWith('data:') || /^https?:/.test(path)) return path;
  if (!path.startsWith('demo-img:')) return null;
  try { return localStorage.getItem(DEMO_IMG + path.slice(9)); } catch { return null; }
}
function readDemoBgs(): KarteBackground[] { try { return JSON.parse(localStorage.getItem(DEMO_BG_KEY) || '[]') as KarteBackground[]; } catch { return []; } }

export function resetDemo() { try { for (const id of Object.keys(SEEDS)) localStorage.removeItem(KEY(id)); const ks: string[] = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(DEMO_IMG)) ks.push(k); } ks.forEach(k => localStorage.removeItem(k)); localStorage.removeItem(DEMO_BG_KEY); } catch {} }

export const memoryRepo: Repo = {
  mode: 'memory',
  async store() { return load().store; },
  async stores() { return [seedGotanda().store, seedHakozaki().store, seedTest().store]; },
  switchStore(id: ID) { try { localStorage.setItem(CUR_KEY, id); } catch {} },
  async lanes() { return load().lanes.filter(l => l.active).sort((a,b) => a.sort_order - b.sort_order); },
  async staff() { return load().staff.filter(onLedger).sort(byStaffOrder); },
  async resources() { return load().resources; },
  async menus() { return load().menus.filter(m => m.active); },
  async products() { return load().products.filter(p => p.active); },
  async customers(q, opt) {
    const limit = opt?.limit ?? 200, offset = opt?.offset ?? 0;
    const cs = [...load().customers].filter(c => !c.merged_into).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    const k = (q || '').trim().toLowerCase(); const digits = k.replace(/[^0-9]/g, '');
    const hit = k ? cs.filter(c => (c.name + (c.kana || '')).toLowerCase().includes(k) || (digits.length >= 3 && (c.phone || '').replace(/[^0-9]/g, '').includes(digits))) : cs;
    return hit.slice(offset, offset + limit);
  },
  async customer(id) { return load().customers.find(c => c.id === id); },
  async upsertCustomer(c) {
    const s = load();
    if (c.id) { const i = s.customers.findIndex(x => x.id === c.id); s.customers[i] = { ...s.customers[i], ...c } as Customer; save(s); return s.customers[i]; }
    const n: Customer = { id: uid(), company_id: s.store.company_id, created_at: nowIso(), ...c } as Customer; s.customers.unshift(n); save(s); return n;
  },
  async bookingsOn(date) { return load().bookings.filter(b => localDate(b.start_at) === date).sort((a,b) => a.start_at.localeCompare(b.start_at)); },
  async bookingsOfCustomer(id) { return load().bookings.filter(b => b.customer_id === id).sort((a,b) => b.start_at.localeCompare(a.start_at)); },
  async bookingsBetween(from, to) { return load().bookings.filter(b => { const d = localDate(b.start_at); return d >= from && d < to; }).sort((a,b) => a.start_at.localeCompare(b.start_at)); },
  async createBookings(list) { const s = load(); for (const b of list) { const n: Booking = { ...b, store_id: s.store.id, id: uid(), created_at: nowIso(), updated_at: nowIso() }; s.bookings.push(n); ledgerRec(s, null, n); } save(s); return list.length; },
  async deleteBookings(ids) { const s = load(); const set = new Set(ids); s.bookings.filter(b => set.has(b.id)).forEach(b => ledgerRec(s, b, null)); s.bookings = s.bookings.filter(b => !set.has(b.id)); save(s); },
  async booking(id) { return load().bookings.find(b => b.id === id); },
  async createBooking(b) { const s = load(); const n: Booking = { ...b, store_id: s.store.id, id: uid(), created_at: nowIso(), updated_at: nowIso() }; s.bookings.push(n); ledgerRec(s, null, n); save(s); return n; },
  async updateBooking(id, patch) { const s = load(); const i = s.bookings.findIndex(b => b.id === id); const before = s.bookings[i]; s.bookings[i] = { ...before, ...patch, updated_at: nowIso() }; ledgerRec(s, before, s.bookings[i]); save(s); return s.bookings[i]; },
  async deleteBooking(id) { const s = load(); const b = s.bookings.find(x => x.id === id); if (b) ledgerRec(s, b, null); s.bookings = s.bookings.filter(b => b.id !== id); save(s); },
  async salesOn(date) { return load().sales.filter(x => localDate(x.sold_at) === date).sort((a,b) => a.sold_at.localeCompare(b.sold_at)); },
  async salesOfCustomer(id) { return load().sales.filter(x => x.customer_id === id).sort((a,b) => b.sold_at.localeCompare(a.sold_at)); },
  async salesBetween(from, to) { return load().sales.filter(x => { const d = localDate(x.sold_at); return d >= from && d < to; }).sort((a,b) => a.sold_at.localeCompare(b.sold_at)); },
  async firstVisits(ids) {
    const s = load(); const want = new Set(ids); const out: Record<ID, string> = {};
    const put = (cid: ID|null|undefined, t: string) => { if (cid && want.has(cid) && (!out[cid] || t < out[cid])) out[cid] = t; };
    for (const x of s.sales) if (x.status === 'confirmed') put(x.customer_id, x.sold_at);
    for (const b of s.bookings) if (b.status === 'done') put(b.customer_id, b.start_at);
    for (const h of s.histVisits ?? []) for (const t of histTimes(s, h.customer_id)) put(h.customer_id, t);
    return out;
  },
  async createSale(input) {
    const s = load();
    // 0014 と同じ決まり：同じ合言葉（client_key）の会計は1枚だけ／入力チェック／会計済みの予約は二重に会計しない
    if (input.client_key) { const dup = s.sales.find(x => (x as Sale & { client_key?: string }).client_key === input.client_key); if (dup) return dup; }
    const bad = validateSale(input); if (bad) throw new Error(bad);
    const bk = input.booking_id ? s.bookings.find(b => b.id === input.booking_id) : undefined;
    if (bk && bk.status === 'done') throw new Error('この予約はもう会計済みです（伝票の一覧を確認してください）');
    const today = ymd(new Date());
    const prefix = today.replace(/-/g,'');
    let seq = s.sales.filter(x => localDate(x.sold_at) === today).length + 1;
    while (s.sales.some(x => x.sale_no === `${prefix}-${String(seq).padStart(3,'0')}`)) seq++;
    const id = uid();
    const lines: SaleLine[] = input.lines.map(l => ({ ...l, id: uid(), sale_id: id, amount: l.unit_price * l.qty }));
    const { subtotal, total, tax } = saleTotals(input.lines, input.discount);
    const payments: Payment[] = input.payments.map(p => ({ ...p, id: uid(), sale_id: id }));
    const sale = { id, store_id: s.store.id, booking_id: input.booking_id, customer_id: input.customer_id, main_staff_id: input.main_staff_id, main_label: input.main_staff_id ? null : input.main_label ?? null, main_lane_id: input.main_staff_id ? null : input.main_lane_id ?? null, sale_no: `${prefix}-${String(seq).padStart(3,'0')}`, sold_at: nowIso(), status: 'confirmed', subtotal, discount: input.discount, tax, total, discount_reason: input.discount_reason, note: input.note, lines, payments, coupon_id: input.coupon_id ?? null, client_key: input.client_key } as Sale & { client_key?: string };
    s.sales.push(sale);
    for (const l of lines) if (l.kind === 'product' && l.product_id) {
      const p = s.products.find(p => p.id === l.product_id); if (p) { p.stock -= l.qty; s.moves.push({ id: uid(), product_id: p.id, store_id: s.store.id, qty: -l.qty, reason: 'sale', moved_at: nowIso() }); }
    }
    const doneIds = [input.booking_id, ...(bk?.pair_group ? (input.partner_booking_ids ?? []) : [])].filter(Boolean) as ID[];
    for (const bid of doneIds) { const b = s.bookings.find(x => x.id === bid && (bid === input.booking_id || x.pair_group === bk?.pair_group)); if (b && b.status !== 'done') { const before = { ...b }; b.status = 'done'; b.updated_at = nowIso(); ledgerRec(s, before, b); } }
    save(s); return sale;
  },
  async reverseSale(id, reason) {
    const s = load(); const orig = s.sales.find(x => x.id === id)!;
    const me = demoMe(s.store);
    if (!reason.trim()) throw new Error('理由を入れてください');
    if (orig.status !== 'confirmed') throw new Error('この伝票はすでに赤伝済みです');
    if (me.role === 'viewer') throw new Error('この操作の権限がありません');
    if (orig.closed_on && me.role !== 'owner' && me.role !== 'manager') throw new Error('締め済みの伝票の赤伝は、オーナー・店長だけができます');
    orig.status = 'voided';
    const rid = uid();
    const rev: Sale = { ...orig, id: rid, sale_no: orig.sale_no + '-R', sold_at: nowIso(), status: 'reversal', reverses_sale_id: orig.id, subtotal: -orig.subtotal, discount: -orig.discount, tax: -orig.tax, total: -orig.total, note: `赤伝：${reason}`,
      lines: orig.lines.map(l => ({ ...l, id: uid(), sale_id: rid, qty: -l.qty, amount: -l.amount })), payments: orig.payments.map(p => ({ ...p, id: uid(), sale_id: rid, amount: -p.amount })) };
    s.sales.push(rev);
    s.audits.push({ id: uid(), at: nowIso(), store_id: s.store.id, actor_name: me.name, table_name: 'sales', row_id: orig.id, action: orig.closed_on ? 'reverse_after_close' : 'reverse', reason: reason.trim(),
      before: { sale_no: orig.sale_no, total: orig.total, sold_at: orig.sold_at, closed_on: orig.closed_on ?? null, status: 'confirmed' }, after: { reversal_id: rid, reversal_sale_no: rev.sale_no, total: -orig.total, role: me.role } });
    for (const l of rev.lines) if (l.kind === 'product' && l.product_id) { const p = s.products.find(p => p.id === l.product_id); if (p) { p.stock -= l.qty; s.moves.push({ id: uid(), product_id: p.id, store_id: s.store.id, qty: -l.qty, reason: 'return', moved_at: nowIso() }); } }
    save(s); return rev;
  },
  async closing(date) { return load().closings.find(c => c.date === date); },
  async saveClosing(c) {
    const s = load(); const i = s.closings.findIndex(x => x.date === c.date);
    const n: RegisterClosing = { ...c, id: i >= 0 ? s.closings[i].id : uid(), store_id: s.store.id };
    if (i >= 0) s.closings[i] = n; else s.closings.push(n);
    if (n.closed_at) for (const x of s.sales) if (localDate(x.sold_at) === c.date && !x.closed_on) x.closed_on = c.date;
    save(s); return n;
  },
  async adjustStock(product_id, qty, reason) { const s = load(); const p = s.products.find(p => p.id === product_id)!; p.stock += qty; s.moves.push({ id: uid(), product_id, store_id: s.store.id, qty, reason, moved_at: nowIso() }); save(s); return p; },
  async inventoryMoves(product_id) { return load().moves.filter(m => m.product_id === product_id).sort((a,b) => b.moved_at.localeCompare(a.moved_at)); },
  async kartes(customer_id) { return load().kartes.filter(k => k.customer_id === customer_id).sort((a,b) => b.visited_on.localeCompare(a.visited_on)); },
  async addKarte(k) { const s = load(); const n: KarteEntry = { ...k, id: uid(), created_at: nowIso() }; s.kartes.push(n); save(s); return n; },
  // ---- カルテの手書き（0010 相当）。画像はこの端末の localStorage に data URL で保存（容量に上限あり） ----
  async kartePages(ids) { const set = new Set(ids); return (load().kartePages ?? []).filter(p => set.has(p.karte_entry_id)).sort((a, b) => a.page_no - b.page_no); },
  async saveKartePages(entryId, drafts) {
    const s = load(); s.kartePages ??= [];
    if (!s.kartes.some(k => k.id === entryId)) throw new Error('カルテが見つかりません');
    const old = s.kartePages.filter(p => p.karte_entry_id === entryId);
    const made: string[] = []; const drop: string[] = [];
    try {
      const rows: KartePage[] = [];
      for (const [i, d] of drafts.entries()) {
        const prev = old.find(p => p.id === d.id);
        let background_path: string|null = null;
        if (d.bg.kind === 'photo') { if (d.bg.blob) { background_path = await putDemoImg(d.bg.blob); made.push(background_path); } else background_path = d.bg.path ?? null; }
        const png_path = await putDemoImg(d.image); made.push(png_path);
        if (prev?.png_path) drop.push(prev.png_path);
        if (prev?.background_path && prev.background_path !== background_path) drop.push(prev.background_path);
        // 0024 相当：置いた画像（新しい物だけ保存。消えた物はあとで片づける）
        const images: KartePageImage[] = [];
        for (const im of (d.images ?? []).slice(0, KARTE_PAGE_IMAGES_MAX)) {
          let path = im.path ?? null;
          if (im.blob) { path = await putDemoImg(im.blob); made.push(path); }
          if (path) images.push({ id: im.id, path, x: im.x, y: im.y, w: im.w, h: im.h });
        }
        for (const pi of prev?.images ?? []) if (!images.some(x => x.path === pi.path)) drop.push(pi.path);
        rows.push({ id: d.id, karte_entry_id: entryId, page_no: i + 1, strokes: d.strokes, png_path, background_path,
          background_template_id: d.bg.kind === 'template' ? d.bg.id : null, background_builtin: d.bg.kind === 'builtin' ? d.bg.key : null,
          background_opacity: Math.round(Math.max(0.05, Math.min(1, d.opacity)) * 100) / 100, images, created_at: prev?.created_at ?? nowIso(), updated_at: nowIso() });
      }
      for (const p of old) if (!drafts.some(d => d.id === p.id)) { if (p.png_path) drop.push(p.png_path); if (p.background_path) drop.push(p.background_path); for (const pi of p.images ?? []) drop.push(pi.path); }
      s.kartePages = [...s.kartePages.filter(p => p.karte_entry_id !== entryId), ...rows];
      save(s);
      if (!saved(s)) throw new Error('この端末の保存容量がいっぱいで保存できませんでした（デモ）。手書きのページを減らしてください');
      drop.forEach(delDemoImg);
      return rows;
    } catch (e) { made.forEach(delDemoImg); throw e; }
  },
  async karteBackgrounds(all) {
    const st = load(); const list = readDemoBgs().filter(b => b.company_id === st.store.company_id);
    return list.filter(b => all || b.store_id == null || b.store_id === st.store.id).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja'));
  },
  async saveKarteBackground(b, image) {
    const st = load(); const me = demoMe(st.store);
    if (me.role !== 'owner' && me.role !== 'manager') throw new Error('カルテの背景はオーナー・店長だけが変更できます');
    b = Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)) as typeof b;   // id: undefined などで既存の値を消さない
    if (!b.name.trim()) throw new Error('名前を入れてください');
    const list = readDemoBgs(); const i = b.id ? list.findIndex(x => x.id === b.id) : -1;
    const prev = i >= 0 ? list[i] : null;
    let image_path = prev?.image_path ?? b.image_path ?? null;
    if (image) image_path = await putDemoImg(image);
    if (!image_path && !(b.builtin_key ?? prev?.builtin_key)) throw new Error('画像を選んでください');
    const mine = list.filter(x => x.company_id === st.store.company_id);
    const n: KarteBackground = { id: prev?.id ?? uid(), company_id: st.store.company_id, store_id: null, sort_order: (mine.reduce((m, x) => Math.max(m, x.sort_order), 0) + 1), active: true, builtin_key: null, created_at: nowIso(), ...prev, ...b, image_path, name: b.name.trim() } as KarteBackground;
    if (i >= 0) list[i] = n; else list.push(n);
    try { localStorage.setItem(DEMO_BG_KEY, JSON.stringify(list)); } catch { if (image) delDemoImg(image_path!); throw new Error('この端末の保存容量がいっぱいで保存できませんでした（デモ）'); }
    if (image && prev?.image_path && prev.image_path !== image_path) delDemoImg(prev.image_path);
    return n;
  },
  async karteFileUrls(paths) { const out: Record<string, string> = {}; for (const p of paths) { const u = demoImgUrl(p); if (u) out[p] = u; } return out; },
  async karteFileBlob(path) { const u = demoImgUrl(path); if (!u) throw new Error('画像が見つかりません（この端末に保存されていません）'); return (await fetch(u)).blob(); },
  async shiftPatterns() { return load().shiftPatterns.filter(p => p.active).sort((a,b) => a.sort_order - b.sort_order); },
  async saveShiftPattern(p) {
    const s = load();
    if (p.id) { const i = s.shiftPatterns.findIndex(x => x.id === p.id); s.shiftPatterns[i] = { ...s.shiftPatterns[i], ...p } as ShiftPattern; save(s); return s.shiftPatterns[i]; }
    const n: ShiftPattern = { color: '#888888', sort_order: s.shiftPatterns.length + 1, active: true, start_time: null, end_time: null, ...p, id: uid(), store_id: s.store.id } as ShiftPattern;
    s.shiftPatterns.push(n); save(s); return n;
  },
  async deleteShiftPattern(id) { const s = load(); const p = s.shiftPatterns.find(x => x.id === id); if (p) p.active = false; save(s); },
  async shiftsBetween(from, to) { return load().shifts.filter(x => x.date >= from && x.date < to); },
  async saveShifts(rows) {
    const s = load();
    for (const r of rows) {
      const i = s.shifts.findIndex(x => x.staff_id === r.staff_id && x.date === r.date);
      const n: Shift = { ...r, id: i >= 0 ? s.shifts[i].id : uid(), store_id: s.store.id };
      if (i >= 0) s.shifts[i] = n; else s.shifts.push(n);
    }
    save(s);
  },
  async deleteShifts(keys) { const s = load(); const k = new Set(keys.map(x => `${x.staff_id}|${x.date}`)); s.shifts = s.shifts.filter(x => !k.has(`${x.staff_id}|${x.date}`)); save(s); },
  async shiftMonth(ym) { return load().shiftMonths.find(x => x.ym === ym); },
  // ---- フェーズB ----
  async capabilities() { return { goals: true, shiftBreaks: true, lastOrder: true, phaseC: true, staffSettings: true, v11: true, karte10: true, hpb11: true, import12: true, v13: true, v14: true, v15: true, v18: true, v20: true, v22: true, karte24: true, consent25: true }; },
  async updateStoreSettings(patch) { const s = load(); s.store = { ...s.store, ...patch }; save(s); return s.store; },
  async reportBundle(storeIds, from, salesTo, bookingsTo) {
    const out = { stores: [] as Store[], sales: [] as Sale[], bookings: [] as Booking[], shifts: [] as Shift[], menus: [] as Menu[], staff: [] as Staff[], customers: [] as Customer[], firstVisits: {} as Record<ID, Record<ID, string>> };
    for (const id of storeIds) {
      const s = load(id); out.stores.push(s.store);
      const sales = s.sales.filter(x => { const d = localDate(x.sold_at); return d >= from && d < salesTo; });
      out.sales.push(...sales);
      out.bookings.push(...s.bookings.filter(b => { const d = localDate(b.start_at); return d >= from && d < bookingsTo; }));
      out.shifts.push(...s.shifts.filter(x => x.date >= from && x.date < bookingsTo));
      out.menus.push(...s.menus); out.staff.push(...s.staff.filter(x => !out.staff.some(y => y.id === x.id)));
      const ids = new Set(sales.map(x => x.customer_id).filter(Boolean) as ID[]);
      out.customers.push(...s.customers.filter(c => ids.has(c.id)));
      const fv: Record<ID, string> = {};
      const put = (cid: ID|null|undefined, t: string) => { if (cid && ids.has(cid) && (!fv[cid] || t < fv[cid])) fv[cid] = t; };
      for (const x of s.sales) if (x.status === 'confirmed') put(x.customer_id, x.sold_at);
      for (const b of s.bookings) if (b.status === 'done') put(b.customer_id, b.start_at);
      for (const cid of new Set((s.histVisits ?? []).map(h => h.customer_id))) for (const t of histTimes(s, cid)) put(cid, t);
      out.firstVisits[s.store.id] = fv;
    }
    return out;
  },
  async customersByIds(ids) { const set = new Set(ids); return load().customers.filter(c => set.has(c.id)); },
  async goals(storeIds, fromYm, toYm) { return storeIds.flatMap(id => load(id).goals.filter(g => g.ym >= fromYm && g.ym <= toYm)); },
  async saveGoal(store_id, ym, target_sales) { const s = load(store_id); s.goals = s.goals.filter(g => g.ym !== ym); if (target_sales !== null) s.goals.push({ store_id, ym, target_sales }); save(s); },
  async markShiftMonth(ym) { const s = load(); const n: ShiftMonth = { store_id: s.store.id, ym, confirmed_at: nowIso() }; s.shiftMonths = [...s.shiftMonths.filter(x => x.ym !== ym), n]; save(s); return n; },
  // ---- フェーズC ----
  async me() { return demoMe(load().store); },
  async allMenus() { return [...load().menus].sort((a, b) => a.sort_order - b.sort_order); },
  async saveMenu(m) {
    const s = load();
    if (m.id && s.menus.some(x => x.id === m.id)) { const i = s.menus.findIndex(x => x.id === m.id); s.menus[i] = { ...s.menus[i], ...m } as Menu; save(s); return s.menus[i]; }
    const n: Menu = { category: 'technical', price: 0, tax_rate: 0.1, duration_min: 60, interval_min: 0, active: true, target: 'all', nominatable: true, web_visible: true, ...m, id: uid(), store_id: s.store.id, sort_order: Math.max(0, ...s.menus.map(x => x.sort_order)) + 1 } as Menu;
    s.menus.push(n); save(s); return n;
  },
  async reorderMenus(ids) { const s = load(); ids.forEach((id, i) => { const m = s.menus.find(x => x.id === id); if (m) m.sort_order = i + 1; }); save(s); },
  async coupons() { return [...load().coupons].sort((a, b) => a.sort_order - b.sort_order); },
  async saveCoupon(c) {
    const s = load();
    if (c.id && s.coupons.some(x => x.id === c.id)) { const i = s.coupons.findIndex(x => x.id === c.id); s.coupons[i] = { ...s.coupons[i], ...c } as Coupon; save(s); return s.coupons[i]; }
    const n: Coupon = { kind: 'amount', value: 0, menu_ids: [], target: 'all', web_visible: true, active: true, ...c, id: uid(), store_id: s.store.id, sort_order: Math.max(0, ...s.coupons.map(x => x.sort_order)) + 1 } as Coupon;
    s.coupons.push(n); save(s); return n;
  },
  async reorderCoupons(ids) { const s = load(); ids.forEach((id, i) => { const c = s.coupons.find(x => x.id === id); if (c) c.sort_order = i + 1; }); save(s); },
  async couponUsage() { return couponUse(load()); },
  async notifications(onlyUnread) { return load().notifications.filter(n => (n.kind === 'new_booking' || n.kind === 'cancel_booking' || n.kind.startsWith('hpb_') || n.kind === 'line_change') && (!onlyUnread || !n.read_at)).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
  async markNotificationsRead(ids) { const s = load(); const set = new Set(ids); for (const n of s.notifications) if (set.has(n.id) && !n.read_at) n.read_at = nowIso(); save(s); },
  async auditLogs(from, to) { return load().audits.filter(a => { const d = localDate(a.at); return d >= from && d < to; }).sort((a, b) => b.at.localeCompare(a.at)); },
  // ---- 設定＞スタッフ ----
  async allStaff() { return [...load().staff].sort(byStaffOrder); },
  async saveStaff(input) {
    const s = load(); const me = demoMe(s.store);
    if (me.role !== 'owner' && me.role !== 'manager') throw new Error('この操作の権限がありません');
    const name = input.name.trim(); if (!name) throw new Error('名前を入れてください');
    const old = input.id ? s.staff.find(x => x.id === input.id) : undefined;
    if ((input.role === 'owner' || old?.role === 'owner') && me.role !== 'owner') throw new Error('オーナーの登録・変更はオーナーだけができます');
    // デモは1社1店舗。別の会社の店舗は入れない
    const store_ids = [...new Set(input.store_ids)].filter(id => id === s.store.id);
    const clean = { ...input, name, store_ids, home_store_id: input.home_store_id && store_ids.includes(input.home_store_id) ? input.home_store_id : store_ids[0] ?? null } as StaffInput;
    if (old) { Object.assign(old, clean, { id: old.id, company_id: old.company_id, email: old.email, auth_user_id: old.auth_user_id }); save(s); return old; }
    const n: Staff = { show_on_ledger: true, web_nominatable: true, nomination_fee: 0, active: true, ...clean, id: uid(), company_id: s.store.company_id, sort_order: Math.max(0, ...s.staff.map(x => x.sort_order ?? 0)) + 1 } as Staff;
    s.staff.push(n); save(s); return n;
  },
  // ---- スタッフのログイン（デモ：発行は「ふり」だけ。仮パスワードは画面に出すだけで保存しない） ----
  async staffLoginStatus() {
    const s = load(); const me = demoMe(s.store);
    if (!canSeeLoginStatus(me.role)) throw new Error('ログインの状態はオーナー・店長だけが見られます');
    const map = s.staffLogins ?? {};
    return { server: true, demo: true, invite_enabled: false, history: (s.loginHistory ?? []).slice(0, 20),
      items: s.staff.map(x => ({ staff_id: x.id, status: map[x.id]?.status ?? (x.auth_user_id ? 'active' as const : 'none' as const), email: map[x.id]?.email ?? x.email ?? null, must_change: map[x.id]?.must_change ?? map[x.id]?.status === 'invited' })) };
  },
  async staffLoginAction(a) {
    const s = load(); const me = demoMe(s.store);
    if (a.kind === 'create_user') return demoCreateUser(s, me, a);
    const t = s.staff.find(x => x.id === a.staff_id); if (!t) throw new Error('スタッフが見つかりません');
    const err = loginPermissionError(a.kind, { staff_id: me.id, role: me.role }, t); if (err) throw new Error(err);
    s.staffLogins ??= {}; s.loginHistory ??= [];
    const cur = s.staffLogins[t.id]?.status ?? (t.auth_user_id ? 'active' : 'none');
    const log = (action: string, reason?: string|null) => s.loginHistory!.unshift({ at: nowIso(), action, actor_name: me.name, target_name: t.name, reason: reason ?? null });
    const loginUrl = (email?: string|null) => `${typeof location !== 'undefined' ? location.origin : ''}/bookings${email ? `?email=${encodeURIComponent(email)}` : ''}`;
    if (a.kind === 'set_password') {
      if (cur === 'none') throw new Error('まだログインがありません（先に「ユーザーを追加」か「ログインを発行」）');
      const bad = checkNewPassword(String(a.password ?? ''), t.email); if (bad) throw new Error(bad);
      // デモ：パスワードはチェックだけして捨てる（保存しない）
      const must = a.must_change !== false;
      s.staffLogins[t.id] = { status: cur === 'stopped' ? 'stopped' : must ? 'invited' : 'active', email: t.email, must_change: must }; log('user_password'); save(s);
      return { ok: true, demo: true, message: `パスワードを変えました（デモ：本物のパスワードは変えていません）。${must ? '次のログインで本人に自分のパスワードを決めてもらいます' : 'このパスワードのまま使えます'}`, email: t.email ?? undefined, status: s.staffLogins[t.id].status, staff_id: t.id };
    }
    if (a.kind === 'issue' || a.kind === 'invite') {
      if (a.kind === 'invite') throw new Error('デモでは招待メールは送れません（「ログインを発行」を試してください）');
      if (cur !== 'none') throw new Error('このスタッフのログインはもう発行済みです（パスワードを忘れたときは「パスワードを再設定」）');
      const email = normalizeEmail(a.email || ''); if (!isValidEmail(email)) throw new Error('メールアドレスが正しくありません');
      const dup = s.staff.find(x => x.id !== t.id && normalizeEmail(x.email || '') === email); if (dup) throw new Error(`このメールは「${dup.name}」さんで使われています。別のメールにしてください`);
      t.email = email; s.staffLogins[t.id] = { status: 'invited', email }; log('login_issue'); save(s);
      return { ok: true, demo: true, message: 'ログインを発行しました（デモ：本物のログインは作っていません）', temp_password: generateTempPassword(), email, login_url: loginUrl(email), status: 'invited' as const };
    }
    if (a.kind === 'reset') {
      if (cur === 'none') throw new Error('まだログインが発行されていません（先に「ログインを発行」）');
      s.staffLogins[t.id] = { status: cur === 'stopped' ? 'stopped' : 'invited', email: t.email }; log('login_reset'); save(s);
      return { ok: true, demo: true, message: 'パスワードを再設定しました（デモ）', temp_password: generateTempPassword(), email: t.email ?? undefined, login_url: loginUrl(t.email), status: s.staffLogins[t.id].status };
    }
    if (a.kind === 'stop') {
      if (cur === 'none') return { ok: true, demo: true, message: 'ログインはまだ発行されていないので、止めるものはありません', status: 'none' as const };
      s.staffLogins[t.id] = { status: 'stopped', email: t.email, prev: cur === 'stopped' ? s.staffLogins[t.id]?.prev : cur }; log('login_stop', a.reason === 'retire' ? '退職' : null); save(s);
      return { ok: true, demo: true, message: 'ログインを止めました（デモ）', status: 'stopped' as const };
    }
    if (cur === 'none') throw new Error('まだログインが発行されていません');
    const back = s.staffLogins[t.id]?.prev === 'invited' ? 'invited' as const : 'active' as const;
    s.staffLogins[t.id] = { status: back, email: t.email }; log('login_resume'); save(s);
    return { ok: true, demo: true, message: 'ログインを再開しました（デモ）', status: back };
  },
  async changeOwnPassword() { /* デモにはログインが無い */ },
  async reorderStaff(ids) { const s = load(); ids.forEach((id, i) => { const x = s.staff.find(y => y.id === id); if (x) x.sort_order = i + 1; }); save(s); },
  async deleteStaff(id) {
    const s = load();
    const used = s.bookings.some(b => b.staff_id === id) || s.sales.some(x => x.main_staff_id === id || x.lines.some(l => l.staff_id === id)) || s.shifts.some(x => x.staff_id === id) || s.kartes.some(k => k.staff_id === id);
    if (used) throw new Error(STAFF_HAS_HISTORY);
    s.staff = s.staff.filter(x => x.id !== id); save(s);
  },
  // ---- v1.1：オプショングループ ----
  async optionGroups() { return [...load().optionGroups].sort((a, b) => a.sort_order - b.sort_order); },
  async saveOptionGroup(g) {
    const s = load(); const me = demoMe(s.store);
    if (me.role !== 'owner' && me.role !== 'manager') throw new Error('この操作の権限がありません');
    if (!g.name.trim()) throw new Error('グループ名を入れてください');
    if (g.id && s.optionGroups.some(x => x.id === g.id)) { const i = s.optionGroups.findIndex(x => x.id === g.id); s.optionGroups[i] = { ...s.optionGroups[i], ...g } as OptionGroup; save(s); return s.optionGroups[i]; }
    const n: OptionGroup = { required: false, multi: false, active: true, ...g, id: uid(), store_id: s.store.id, sort_order: Math.max(0, ...s.optionGroups.map(x => x.sort_order)) + 1 } as OptionGroup;
    s.optionGroups.push(n); save(s); return n;
  },
  async deleteOptionGroup(id) {
    const s = load(); s.optionGroups = s.optionGroups.filter(x => x.id !== id);
    for (const m of s.menus) { if (m.option_group_id === id) m.option_group_id = null; if (m.option_group_ids?.includes(id)) m.option_group_ids = m.option_group_ids.filter(x => x !== id); }
    for (const c of s.coupons) if (c.option_group_ids?.includes(id)) c.option_group_ids = c.option_group_ids.filter(x => x !== id);
    save(s);
  },
  // ---- HPBの予約メール取り込み（0011 相当）。本番のサーバと同じ処理（src/lib/inbound/process.ts）を端末内で動かす ----
  async hpbSettings() { const s = load(); return s.hpbSettings ?? { store_id: s.store.id, enabled: isTestStore(s.store), secret_hash: null, plus_address: null, default_menu_id: null, parser_config: {} }; },
  async saveHpbSettings(patch) {
    const s = load(); const me = demoMe(s.store);
    if (me.role !== 'owner' && me.role !== 'manager') throw new Error('HPB連携の設定の変更はオーナー・店長だけができます');
    s.hpbSettings = { ...(await memoryRepo.hpbSettings())!, ...patch, store_id: s.store.id, updated_at: nowIso() }; save(s); return s.hpbSettings;
  },
  async hpbMappings() { return [...(load().hpbMappings ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || a.sort_order - b.sort_order); },
  async saveHpbMapping(m) {
    const s = load(); const me = demoMe(s.store); s.hpbMappings ??= [];
    if (me.role !== 'owner' && me.role !== 'manager') throw new Error('対応表の変更はオーナー・店長だけができます');
    if (!m.pattern.trim()) throw new Error('言葉を入れてください');
    const i = m.id ? s.hpbMappings.findIndex(x => x.id === m.id) : -1;
    const n: HpbMapping = { active: true, menu_id: null, people: null, staff_id: null, sort_order: Math.max(0, ...s.hpbMappings.map(x => x.sort_order)) + 1, ...(i >= 0 ? s.hpbMappings[i] : {}), ...m, id: i >= 0 ? s.hpbMappings[i].id : uid(), store_id: s.store.id, pattern: m.pattern.trim() } as HpbMapping;
    if (i >= 0) s.hpbMappings[i] = n; else s.hpbMappings.push(n); save(s); return n;
  },
  async deleteHpbMapping(id) { const s = load(); s.hpbMappings = (s.hpbMappings ?? []).filter(x => x.id !== id); save(s); },
  async inboundMails(limit = 100) { return [...(load().inboundMails ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit); },
  async hpbAction(a) {
    const s = load(); const me = demoMe(s.store);
    if (me.role !== 'owner' && me.role !== 'manager') throw new Error('この操作はオーナー・店長だけができます');
    const io = memoryIO(s);
    if (a.kind === 'test') {
      if (me.role !== 'owner') throw new Error('テストメールはオーナーだけが送れます');
      if (!isTestStore(s.store)) throw new Error('テストメールはテスト店舗（練習用）だけで使えます');
      const m = makeTestMail(a.test);
      const r = await ingestHpbMail(io, { messageId: `test-${uid()}`, subject: m.subject, body: m.body, date: nowIso(), from: 'test@salon-app', isTest: true });
      save(s); return { ok: true, status: r.mail.status, action: r.mail.action, mail_id: r.mail.id, booking_ids: r.mail.booking_ids ?? [] };
    }
    const mail = (s.inboundMails ?? []).find(x => x.id === a.mail_id); if (!mail) throw new Error('メールが見つかりません');
    if (a.kind === 'ignore') { mail.status = 'ignored'; mail.action = `${mail.action ? mail.action + '\n' : ''}手で「無視」にしました`; save(s); return { ok: true, status: 'ignored', mail_id: mail.id }; }
    const r = await processStoredMail(io, mail, a.kind === 'fix' ? a.manual : undefined);
    save(s); return { ok: true, status: r.mail.status, action: r.mail.action, mail_id: mail.id, booking_ids: r.mail.booking_ids ?? [] };
  },
  // ---- 顧客CSV取り込み（0012）。デモは表示中の店舗のデータに入れる ----
  async importIndex() { return [...load().customers]; },
  async histKeys(source) { return new Set((load().histVisits ?? []).filter(h => h.source === source && h.kind === 'visit').map(h => h.dedupe_key)); },
  async runCustomerImport(req, onProgress) {
    const s = load(); const me = demoAdmin(s);
    const log = newLog(s, me, 'customers', req.source, req.file_name, req.mode);
    const total = req.creates.length + req.updates.length + req.sames.length; let done = 0; let created = 0, updated = 0, sums = 0;
    const step = async () => { done++; if (done % 100 === 0 || done === total) { onProgress?.(done, total); await new Promise(r => setTimeout(r, 0)); } };
    for (const c of req.creates) {
      const n: Customer = { id: uid(), company_id: s.store.company_id, created_at: nowIso(), ...c.data, import_source: req.source, import_id: log.id };
      s.customers.push(n); created++; if (c.summary) { putSummary(s, n.id, req.source, c.summary, log.id); sums++; } await step();
    }
    for (const u of req.updates) {
      const t = s.customers.find(x => x.id === u.id); if (!t) continue;
      Object.assign(t, u.patch, u.patch.external_id ? { import_source: req.source } : {}); updated++;
      if (u.summary) { putSummary(s, t.id, req.source, u.summary, log.id); sums++; } await step();
    }
    for (const x of req.sames) { if (x.summary) { putSummary(s, x.id, req.source, x.summary, log.id); sums++; } await step(); }
    log.counts = { created, updated, same: req.same, skipped: req.skipped, errors: req.errors, visits: sums };
    save(s); if (!saved(s)) throw new Error('この端末の保存容量がいっぱいで保存できませんでした（デモ。本番では保存できます）');
    return log;
  },
  async runVisitImport(req, onProgress) {
    const s = load(); const me = demoAdmin(s);
    const log = newLog(s, me, 'visits', req.source, req.file_name, 'fill');
    const keys = new Set((s.histVisits ?? []).filter(h => h.source === req.source).map(h => h.dedupe_key)); let added = 0, done = 0;
    for (const r of req.rows) {
      done++;
      if (keys.has(r.dedupe_key)) continue; keys.add(r.dedupe_key);
      s.histVisits!.push({ id: uid(), company_id: s.store.company_id, store_id: s.store.id, kind: 'visit', source: req.source, import_id: log.id, created_at: nowIso(), ...r }); added++;
      if (done % 200 === 0) { onProgress?.(done, req.rows.length); await new Promise(x => setTimeout(x, 0)); }
    }
    onProgress?.(req.rows.length, req.rows.length);
    log.counts = { created: added, updated: 0, same: 0, skipped: req.skipped + (req.rows.length - added), errors: req.errors, visits: added };
    save(s); if (!saved(s)) throw new Error('この端末の保存容量がいっぱいで保存できませんでした（デモ。本番では保存できます）');
    return log;
  },
  async importLogs() { return [...(load().importLogs ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)); },
  async undoImport(id) {
    const s = load(); demoAdmin(s);
    const lg = (s.importLogs ?? []).find(x => x.id === id); if (!lg) throw new Error('取り込みの記録が見つかりません');
    if (lg.undone_at) throw new Error('この取り込みはすでに取り消しています');
    const before = (s.histVisits ?? []).length; s.histVisits = (s.histVisits ?? []).filter(h => h.import_id !== id); const visits = before - s.histVisits.length;
    const used = (cid: ID) => s.bookings.some(b => b.customer_id === cid) || s.sales.some(x => x.customer_id === cid) || s.kartes.some(k => k.customer_id === cid) || s.histVisits!.some(h => h.customer_id === cid) || s.customers.some(c => c.merged_into === cid);
    const mine = s.customers.filter(c => c.import_id === id); const del = new Set(mine.filter(c => !used(c.id)).map(c => c.id));
    s.customers = s.customers.filter(c => !del.has(c.id));
    const res = { removed: del.size, kept: mine.length - del.size, visits };
    lg.undone_at = nowIso(); lg.undo_result = res; save(s); return res;
  },
  async importPresets() { try { return JSON.parse(localStorage.getItem(DEMO_PRESET_KEY) || '[]') as ImportPreset[]; } catch { return []; } },
  async saveImportPreset(p) {
    demoAdmin(load());
    let list: ImportPreset[] = []; try { list = JSON.parse(localStorage.getItem(DEMO_PRESET_KEY) || '[]'); } catch {}
    list = [...list.filter(x => !(x.source === p.source && x.kind === p.kind)), { ...p, updated_at: nowIso() }];
    try { localStorage.setItem(DEMO_PRESET_KEY, JSON.stringify(list)); } catch {}
  },
  async historicalVisits(cid) { return (load().histVisits ?? []).filter(h => h.customer_id === cid).sort((a, b) => (b.visited_on || b.last_visit_on || '').localeCompare(a.visited_on || a.last_visit_on || '')); },
  // ---- 0013 ----
  async bookingHistory(id) { return (load().bookingHistory ?? []).filter(h => h.booking_id === id).sort((a, b) => a.at.localeCompare(b.at)); },
  async repeatSource(storeIds, to) {
    const out: RepeatSource = { stores: [], staff: [], visits: [], summaries: [], genders: {}, rules: {}, rulesReady: true };
    for (const id of storeIds) {
      const s = load(id); out.stores.push(s.store); out.rules[s.store.id] = normRules(s.repeatRules ?? DEFAULT_REPEAT_RULES);
      for (const x of s.staff) if (!out.staff.some(y => y.id === x.id)) out.staff.push(x);
      out.visits.push(...repeatVisitsOf(s, to));
      for (const h of s.histVisits ?? []) if (h.kind === 'summary') out.summaries.push({ store_id: h.store_id, customer_id: h.customer_id, visit_count: h.visit_count ?? null, first_visit_on: h.first_visit_on ?? null, last_visit_on: h.last_visit_on ?? null } satisfies RepeatSummary);
      for (const c of s.customers) out.genders[c.id] = c.gender ?? null;
    }
    return out;
  },
  async saveRepeatRules(storeId, rules) {
    const s = load(storeId); const me = demoMe(s.store);
    if (me.role !== 'owner' && me.role !== 'manager') throw new Error('区分の決め方の変更はオーナー・店長だけができます');
    s.repeatRules = normRules(rules); save(s);
  },
  // ---- LINE連携（0015・デモ）：LINE には何も送らない。送る代わりに文面を見せる ----
  async lineSettings() { const s = load(); return s.lineSettings ?? defaultLineSettings(s.store.id); },
  async saveLineSettings(p) {
    const s = load(); demoLineAdmin(s);
    for (const [k, t] of Object.entries(p.templates || {})) if (t && t.trim()) { const c = checkTemplate(t, k as never); if (c.errors.length) throw new Error(c.errors.join('／')); }
    s.lineSettings = { ...(s.lineSettings ?? defaultLineSettings(s.store.id)), ...p, updated_at: nowIso() }; save(s); return s.lineSettings;
  },
  async saveLineCredentials(c) {
    const s = load(); demoLineAdmin(s);
    if (c.channel_secret && !/^[0-9a-f]{32}$/.test(c.channel_secret)) throw new Error('チャネルシークレットは英数字32文字です（LINE Developers の「チャネル基本設定」）');
    if (c.access_token && (c.access_token.length < 40 || /\s/.test(c.access_token))) throw new Error('チャネルアクセストークン（長期）が正しくありません');
    const cur = s.lineSettings ?? defaultLineSettings(s.store.id);
    // デモは中身を保存しない（保存した日時だけ）
    const next = { ...cur, secret_set_at: c.channel_secret === undefined || c.channel_secret === null ? cur.secret_set_at : c.channel_secret ? nowIso() : null,
      token_set_at: c.access_token === undefined || c.access_token === null ? cur.token_set_at : c.access_token ? nowIso() : null };
    if (c.channel_secret === '' || c.access_token === '') next.enabled = false;
    s.lineSettings = next; save(s); return next;
  },
  async lineAction(a) {
    const s = load();
    if (a.kind === 'test_connection') return { ok: false, message: 'デモではLINEにつなぎません（本番で、チャネルアクセストークンを保存してから押してください）' };
    if (a.kind === 'test_send') { demoLineAdmin(s); const io = demoLineIO(s); return { ok: true, message: 'デモなので送らずに、文面だけ表示します', previews: [{ to: '自分', kind: a.template, text: previewText(sampleMessages(io, a.template, io.bookingUrl())) }] }; }
    const previews: { to: string; kind: string; text: string }[] = [];
    const io = demoLineIO(s, true);
    const sender: LineSender = { demo: true,
      async push(to, msgs) { previews.push({ to: whoIs(s, to), kind: 'push', text: previewText(msgs) }); },
      async reply(_t, msgs) { previews.push({ to: '返信', kind: 'reply', text: previewText(msgs) }); } };
    const uidOf = (linkId: ID) => s.line!.links.find(l => l.id === linkId)?.line_user_id;
    const ev = (o: Record<string, unknown>) => ({ type: 'message', webhookEventId: uid(), replyToken: 'demo', ...o });
    if (a.kind === 'demo_follow') {
      const c = s.customers.find(x => x.id === a.customer_id); if (!c) throw new Error('お客様が見つかりません');
      const existing = s.line!.links.find(l => l.customer_id === c.id);
      const u = existing?.line_user_id || demoUid();
      await io.saveLink({ line_user_id: u, customer_id: c.id, display_name: a.name || c.name, linked_at: nowIso(), linked_via: 'token' }, { takeOver: true });   // スタッフの操作＝会計のQRと同じ扱い
      await handleEvents(io, sender, [ev({ type: 'follow', source: { type: 'user', userId: u } })]);
      save(s); return { ok: true, message: `${c.name}様がLINEでつながりました（デモ）`, previews };
    }
    if (a.kind === 'demo_unfollow') { const u = uidOf(a.link_id); if (!u) throw new Error('見つかりません'); await handleEvents(io, sender, [ev({ type: 'unfollow', source: { type: 'user', userId: u } })]); save(s); return { ok: true, message: 'ブロックされました（デモ）＝お知らせは止まります', previews }; }
    if (a.kind === 'demo_message') { const u = uidOf(a.link_id); if (!u) throw new Error('見つかりません'); await handleEvents(io, sender, [ev({ type: 'message', source: { type: 'user', userId: u }, message: { type: 'text', text: a.text } })]); save(s); return { ok: true, message: 'メッセージが届きました（デモ）', previews }; }
    if (a.kind === 'demo_postback') {
      const b = s.bookings.find(x => x.id === a.booking_id); if (!b?.customer_id) throw new Error('予約が見つかりません');
      const l = s.line!.links.find(x => x.customer_id === b.customer_id); if (!l) throw new Error('このお客様はLINEとつながっていません（先に「友だち追加（デモ）」）');
      await handleEvents(io, sender, [ev({ type: 'postback', source: { type: 'user', userId: l.line_user_id }, postback: { data: `a=${a.answer}&b=${b.id}` } })]);
      save(s); return { ok: true, message: a.answer === 'ok' ? '「予定どおり伺います」が押されました（デモ）＝台帳に✓' : '「変更したい」が押されました（デモ）＝台帳に？、お知らせに通知', previews };
    }
    // demo_cron：前日確認・再来案内を、時刻を待たずに作って「送ったことにする」（文面を見せるだけ）
    const r = await runCron(io, sender, { force: true });
    save(s);
    const why = r.plans.map(p => p.skipped).filter(Boolean);
    return { ok: true, message: `テスト送信（デモ）：前日確認 ${r.plans[0].queued}件・再来案内 ${r.plans[1].queued}件を作り、${r.sent}件の文面を表示しました（LINEには送っていません）${why.length ? `（${why.join('／')}）` : ''}`, previews };
  },
  // 0022（案B）：同じ電話番号のお客様（ヒント）と統合（デモ。サーバと同じ決まり：在籍の owner・manager・staff）
  async customersSamePhone(customerId) { const s = load(); const me = s.customers.find(c => c.id === customerId); return me ? samePhoneCustomers(me, s.customers) : []; },
  async mergeCustomers(keepId, mergeId) {
    const s = load(); const me = demoMe(s.store);
    if (!canMerge(me.active === false ? null : me.role)) throw new Error('統合できるのは、在籍のオーナー・店長・スタッフだけです');
    if (keepId === mergeId) throw new Error('同じお客様です');
    const k = s.customers.find(c => c.id === keepId), m = s.customers.find(c => c.id === mergeId);
    if (!k || !m) throw new Error('お客様が見つかりません');
    if (k.merged_into || m.merged_into) throw new Error('もう統合されています（画面を開き直してください）');
    let nb = 0, ns = 0, nk = 0;
    for (const b of s.bookings) if (b.customer_id === m.id) { b.customer_id = k.id; nb++; }
    for (const x of s.sales) if (x.customer_id === m.id) { x.customer_id = k.id; ns++; }
    for (const x of s.kartes) if (x.customer_id === m.id) { x.customer_id = k.id; nk++; }
    for (const h of s.histVisits ?? []) if (h.customer_id === m.id) h.customer_id = k.id;
    for (const x of s.line?.messages ?? []) if (x.customer_id === m.id) x.customer_id = k.id;
    for (const r of s.lineLinkRequests ?? []) if (r.customer_id === m.id && r.status === 'pending') { r.status = 'expired'; r.decided_at = nowIso(); }
    let line: 'moved'|'kept'|'none' = 'none';
    const lk = s.line?.links.find(l => l.customer_id === k.id), lm = s.line?.links.find(l => l.customer_id === m.id);
    if (lm) { if (!lk) { lm.customer_id = k.id; line = 'moved'; } else { lm.customer_id = null; line = 'kept'; } }
    const fill = (a?: string|null, b?: string|null) => (a && a.trim() ? a : b ?? a ?? null);
    Object.assign(k, { kana: fill(k.kana, m.kana), phone: fill(k.phone, m.phone), email: fill(k.email, m.email), birth_month: fill(k.birth_month, m.birth_month), gender: fill(k.gender, m.gender), source: fill(k.source, m.source),
      note: k.note?.trim() ? (m.note?.trim() ? `${k.note}\n${m.note}` : k.note) : m.note ?? k.note ?? null, birthday: k.birthday ?? m.birthday ?? null, postal_code: fill(k.postal_code, m.postal_code), address: fill(k.address, m.address) });
    m.merged_into = k.id;
    s.audits.push({ id: uid(), at: nowIso(), store_id: s.store.id, actor_name: me.name, table_name: 'customers', row_id: k.id, action: 'merge', before: { merged_id: m.id, kept_id: k.id }, after: { kept_id: k.id, merged_id: m.id, bookings: nb, sales: ns, kartes: nk, line } });
    save(s);
    return { ok: true, message: `統合しました（予約 ${nb}件・お会計 ${ns}件・カルテ ${nk}件を移しました${line === 'moved' ? '・LINEのつながりも移しました' : line === 'kept' ? '・LINEは残す側のものを残しました' : ''}）`, kept_id: k.id, line };
  },
  async lineLinks(ids) { const s = load(); const L = s.line?.links ?? []; return ids ? L.filter(l => l.customer_id && ids.includes(l.customer_id)) : [...L]; },
  async lineLinkRequests(ids) { const s = load(); const rs = openRequests(s.lineLinkRequests); return ids ? rs.filter(r => ids.includes(r.customer_id)) : rs; },
  // デモ：サーバと同じ決まり（在籍の owner・manager・staff・確認待ち・30日以内）。前の LINE へのお知らせは受信箱に「デモ」として残す
  async decideLineLinkRequest(requestId, decision) {
    const s = load(); const me = demoMe(s.store);
    const r = (s.lineLinkRequests ?? []).find(x => x.id === requestId) || null;
    const e = decideRequestError({ role: me.active === false ? null : me.role, request: r });
    if (e) { if (e.status === 410 && r) { r.status = 'expired'; r.decided_at = nowIso(); save(s); } throw new Error(e.message); }
    r!.status = decision === 'approve' ? 'approved' : 'rejected'; r!.decided_by = me.id; r!.decided_at = nowIso();
    if (decision === 'reject') {
      const cur = s.line?.links.find(l => l.customer_id === r!.customer_id) || null;
      if (isOwnerCheck(r!, cur)) { cur!.customer_id = null; cur!.needs_confirm = false; save(s); return { ok: true, message: 'このLINEをお客様から外しました（このLINEにはもう届きません）' }; }
      save(s); return { ok: true, message: 'つながないことにしました' };
    }
    const out = await applyLink(demoLinkApplyIO(s), DEMO_SENDER, { storeId: s.store.id, storeName: s.store.name, planLimit: (s.lineSettings ?? defaultLineSettings(s.store.id)).plan_limit,
      lineUserId: r!.line_user_id, displayName: r!.display_name ?? null, customerId: r!.customer_id, via: 'staff_approved', takeOver: true, logText: 'LINE連携（確認待ちをスタッフが承認・デモ）' });
    save(s);
    return { ok: true, message: `このお客様のLINEとつなぎました${out.repointed ? (out.notice === 'demo' ? '（前につながっていたLINEへの「送り先が変わりました」は、デモなので受信箱に残しただけです）' : '') : ''}` };
  },
  async lineMessages(limit = 200) { return [...(load().line?.messages ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit); },
  async lineQueue(limit = 200) { return [...(load().line?.queue ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit); },
  async lineMonthUsage() { const s = load(); return demoLineIO(s).monthCount(); },
  async markLineHandled(ids) { const s = load(); const me = demoMe(s.store); const set = new Set(ids.map(String)); for (const m of s.line?.messages ?? []) if (set.has(String(m.id)) && !m.handled_at) { m.handled_at = nowIso(); m.handled_by_name = me.name; } save(s); },
  async setLineOptOut(linkId, opt) { const s = load(); if (!opt) demoLineAdmin(s); const l = s.line?.links.find(x => x.id === linkId); if (!l) throw new Error('見つかりません'); Object.assign(l, { opted_out: opt, opt_out_reason: opt ? 'staff' : null, opted_out_at: opt ? nowIso() : null }); save(s); },
  async setLineTestTarget(u) { const s = load(); if (demoMe(s.store).role !== 'owner') throw new Error('オーナーだけができます'); s.lineSettings = { ...(s.lineSettings ?? defaultLineSettings(s.store.id)), test_line_user_id: u }; save(s); },
  // デモ：LINE には送らない。サーバと同じ決まりで確かめて、受信箱に「デモ」として残す（通数には数えない）
  async lineContact(items) {
    const s = load(); const me = demoMe(s.store);
    if (!canSendManual(me.role, me.active)) throw new Error('LINEで連絡できるのは、オーナー・店長・スタッフだけです');
    // デモの予約IDは UUID でないので、本文と人数だけサーバと同じ決まりで確かめる
    if (!items.length) throw new Error('送る相手がいません');
    if (items.length > MANUAL_BATCH_MAX) throw new Error(`一度に送れるのは${MANUAL_BATCH_MAX}人までです`);
    for (const it of items) { const e = manualTextError(it.text); if (e) throw new Error(e); }
    const parsed = { items: [...new Map(items.map(it => [it.booking_id, { booking_id: it.booking_id, text: it.text.trim() }])).values()] };
    s.line ??= emptyLineState();
    const io = demoLineIO(s);
    const limit = (s.lineSettings ?? defaultLineSettings(s.store.id)).plan_limit;
    const used = await io.monthCount();
    const hourAgo = Date.now() - 3600_000;
    const recent = (bid: string | null) => s.line!.messages.filter(m => m.direction === 'out' && m.kind === MANUAL_KIND && (m.status === 'sent' || m.status === 'demo') && Date.parse(m.created_at) >= hourAgo && (!bid || m.booking_id === bid)).length;
    let storeRecent = Math.min(recent(null), MANUAL_PER_STORE_PER_HOUR);
    const results: ManualResult[] = [];
    for (const it of parsed.items) {
      const id = it.booking_id;
      const b = s.bookings.find(x => x.id === id) || null;
      const link = b?.customer_id ? s.line.links.find(l => l.customer_id === b.customer_id) || null : null;
      const err = manualSendError({ booking: b, storeId: s.store.id, link, recentForBooking: b ? recent(b.id) : 0, recentForStore: storeRecent, used, limit });
      if (err) { results.push({ booking_id: id, ok: false, message: err }); continue; }
      s.line.messages.push({ id: uid(), store_id: s.store.id, line_user_id: link!.line_user_id, customer_id: b!.customer_id, booking_id: b!.id, direction: 'out', kind: MANUAL_KIND, text: it.text, status: 'demo', counted: false, created_at: nowIso() });
      storeRecent++;
      results.push({ booking_id: id, ok: true, message: '送りました（デモなのでLINEには届きません）' });
    }
    save(s);
    const okN = results.filter(r => r.ok).length;
    return { ok: okN > 0, message: results.length === 1 ? results[0].message : `${results.length}人中 ${okN}人に送りました（デモ）`, results, used, limit };
  },
  // デモ：顧客詳細からの「LINEで連絡」。サーバと同じ決まりで確かめて、受信箱に「デモ」として残す（LINEには届かない）
  async lineContactCustomer(customerId, text) {
    const s = load(); const me = demoMe(s.store);
    if (!canSendManual(me.role, me.active)) throw new Error('LINEで連絡できるのは、オーナー・店長・スタッフだけです');
    const e = manualTextError(text); if (e) throw new Error(e);
    s.line ??= emptyLineState();
    const io = demoLineIO(s);
    const limit = (s.lineSettings ?? defaultLineSettings(s.store.id)).plan_limit;
    const used = await io.monthCount();
    const hourAgo = Date.now() - 3600_000;
    const recent = (cid: string | null) => s.line!.messages.filter(m => m.direction === 'out' && m.kind === MANUAL_KIND && (m.status === 'sent' || m.status === 'demo') && Date.parse(m.created_at) >= hourAgo && (!cid || m.customer_id === cid)).length;
    const c = s.customers.find(x => x.id === customerId) || null;
    const link = c ? s.line.links.find(l => l.customer_id === c.id) || null : null;
    const err = directSendError({ customer: c, companyId: s.store.company_id, link, recentForCustomer: c ? recent(c.id) : 0, recentForStore: Math.min(recent(null), MANUAL_PER_STORE_PER_HOUR), used, limit });
    if (err) return { ok: false, message: err, used, limit };
    s.line.messages.push({ id: uid(), store_id: s.store.id, line_user_id: link!.line_user_id, customer_id: c!.id, booking_id: null, direction: 'out', kind: MANUAL_KIND, text: text.trim(), status: 'demo', counted: false, created_at: nowIso() });
    save(s);
    return { ok: true, message: '送りました（デモなのでLINEには届きません）', used, limit };
  },
  async createLineLinkToken(customerId) {
    const s = load(); if (!s.store.slug) throw new Error('予約ページのURL名が未設定です（設定＞店舗・ネット予約）');
    const token = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    s.lineTokens = [...(s.lineTokens ?? []).filter(t => Date.parse(t.expires_at) > Date.now() - 86400000), { token, customer_id: customerId, expires_at: new Date(Date.now() + 30 * 60000).toISOString() }];
    save(s);
    const origin = typeof location !== 'undefined' ? location.origin : '';
    return { token, url: `${origin}/r/${s.store.slug}?liff=1&link=${token}` };
  },
};

/** リピート率推移表の来店（確定伝票＋旧POSの来店）。同じ日の重なりは repeat.ts でまとめる */
function repeatVisitsOf(s: State, to: string): RepeatVisit[] {
  const out: RepeatVisit[] = [];
  const bk = new Map(s.bookings.map(b => [b.id, b]));
  for (const x of s.sales) {
    if (x.status !== 'confirmed' || !x.customer_id) continue;
    const date = localDate(x.sold_at); if (date >= to) continue;
    const tech = x.lines.filter(l => l.kind !== 'product');
    const ids = [...new Set((tech.length ? tech : x.lines).map(l => l.staff_id || x.main_staff_id).filter((v): v is ID => !!v))];
    const b = x.booking_id ? bk.get(x.booking_id) : undefined;
    out.push({ store_id: x.store_id, customer_id: x.customer_id, date, staff_ids: ids, nominated: b ? !!b.nominated : null, src: 'sale' });
  }
  for (const h of s.histVisits ?? []) {
    if (h.kind !== 'visit' || !h.visited_on || h.visited_on >= to) continue;
    const st = h.staff_name ? s.staff.find(x => x.name.replace(/\s/g, '') === h.staff_name!.replace(/\s/g, '')) : undefined;
    out.push({ store_id: h.store_id, customer_id: h.customer_id, date: h.visited_on, staff_ids: st ? [st.id] : [], nominated: null, src: 'hist' });
  }
  return out;
}

// ---- 顧客CSV取り込み（デモ）の部品 ----
const DEMO_PRESET_KEY = 'salon-app-demo-import-presets';
function demoAdmin(s: State) { const me = demoMe(s.store); if (me.role !== 'owner' && me.role !== 'manager') throw new Error('顧客CSV取り込みはオーナー・店長だけができます'); return me; }
function newLog(s: State, me: Staff, kind: ImportLog['kind'], source: ImportSource, file_name: string, mode: ImportLog['mode']): ImportLog {
  s.importLogs ??= []; s.histVisits ??= [];
  const log: ImportLog = { id: uid(), company_id: s.store.company_id, store_id: s.store.id, kind, source, file_name: file_name.slice(0, 300), mode, actor_name: me.name, created_at: nowIso(), counts: { created: 0, updated: 0, same: 0, skipped: 0, errors: 0 } };
  s.importLogs.push(log); return log;
}
function putSummary(s: State, customer_id: ID, source: ImportSource, sm: HistSummaryInput, import_id: ID) {
  s.histVisits ??= []; const key = `summary:${customer_id}`;
  s.histVisits = s.histVisits.filter(h => !(h.source === source && h.dedupe_key === key));
  s.histVisits.push({ id: uid(), company_id: s.store.company_id, store_id: s.store.id, customer_id, kind: 'summary', first_visit_on: sm.first_visit_on ?? null, last_visit_on: sm.last_visit_on ?? null, visit_count: sm.visit_count ?? null, staff_name: sm.staff_name ?? null, source, dedupe_key: key, import_id, created_at: nowIso() });
}
/** 旧POSの来店の日付（初来店・前回来店の判定用。その日の12:00） */
function histTimes(s: State, cid: ID): string[] {
  return (s.histVisits ?? []).filter(h => h.customer_id === cid).flatMap(h => [h.visited_on, h.first_visit_on, h.last_visit_on]).filter((d): d is string => !!d).map(d => new Date(`${d}T12:00:00`).toISOString());
}

/** デモ：端末内のデータで、本番のサーバと同じ取り込み処理を動かすための口 */
function memoryIO(s: State): InboundIO {
  s.inboundMails ??= [];
  return {
    store: s.store, staff: s.staff.filter(onLedger).sort(byStaffOrder), lanes: s.lanes.filter(l => l.active), menus: s.menus.filter(m => m.active),
    settings: s.hpbSettings ?? { store_id: s.store.id, enabled: isTestStore(s.store) }, mappings: s.hpbMappings ?? [],
    async shiftsOn(date) { return s.shifts.filter(x => x.date === date && x.staff_id); },
    async bookingsOn(date) { return s.bookings.filter(b => localDate(b.start_at) === date); },
    async bookingsByRef(ref) { return s.bookings.filter(b => b.channel === 'hpb' && b.external_ref === ref); },
    async findCustomer(phone, kana, name) {
      if (phone) { const c = s.customers.find(x => normPhone(x.phone || '') === phone); if (c) return c.id; }
      const k = (x?: string|null) => (x || '').replace(/[\s\u3000]/g, '');
      if (k(kana).length >= 2) { const cs = s.customers.filter(x => k(x.kana) === k(kana) && (!name || k(name) === k(kana) || k(x.name) === k(name) || k(x.name) === k(kana))); if (cs.length === 1) return cs[0].id; }
      return null;
    },
    async createCustomer(c) { const n: Customer = { id: uid(), company_id: s.store.company_id, name: c.name, kana: c.kana, phone: c.phone, source: 'hpb', created_at: nowIso() }; s.customers.unshift(n); return n.id; },
    async insertBookings(rows) { const made = rows.map(r => ({ ...r, id: uid(), created_at: nowIso(), updated_at: nowIso() } as Booking)); s.bookings.push(...made); made.forEach(b => rec(s, null, b, 'hpb')); return made; },
    async updateBooking(id, patch) { const b = s.bookings.find(x => x.id === id); if (b) { const before = { ...b }; Object.assign(b, patch, { updated_at: nowIso() }); rec(s, before, b, 'hpb'); } },
    async notify(n) { s.notifications.push({ id: uid(), store_id: s.store.id, booking_id: n.booking_id, kind: n.kind, channel: 'app', to_address: null, subject: n.subject, body: n.body, status: 'skipped', created_at: nowIso() }); },
    newId: uid,
    async findMail(mid) { return s.inboundMails!.find(m => m.message_id === mid) ?? null; },
    async getMail(id) { return s.inboundMails!.find(m => m.id === id) ?? null; },
    async insertMail(m) { const r = { ...m, id: uid(), created_at: nowIso() } as InboundMail; s.inboundMails!.push(r); if (s.inboundMails!.length > 300) s.inboundMails!.splice(0, s.inboundMails!.length - 300); return r; },
    async updateMail(id, patch) { const m = s.inboundMails!.find(x => x.id === id); if (m) Object.assign(m, patch); },
  };
}
// ---- LINE連携（デモ）の材料 ----
function demoLineAdmin(s: State) { const me = demoMe(s.store); if (me.role !== 'owner' && me.role !== 'manager') throw new Error('LINE連携の設定はオーナー・店長だけができます'); }
function demoUid() { return 'U' + Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''); }
/** この端末の「デモのLINE」のユーザーID（お客様の LIFF の代わり） */
function demoLineUid() { let u = ''; try { u = localStorage.getItem('salon-app-demo-line-uid') || ''; if (!u) { u = demoUid(); localStorage.setItem('salon-app-demo-line-uid', u); } } catch { u = demoUid(); } return u; }
function whoIs(s: State, u: string) { const l = s.line?.links.find(x => x.line_user_id === u); const c = l?.customer_id ? s.customers.find(x => x.id === l.customer_id) : null; return c?.name || l?.display_name || 'LINEのお客様'; }
/** demo=true：デモの操作（オン/オフに関係なく文面を見せる。送信は数えない） */
function demoLineIO(s: State, demo = false): LineIO {
  s.line ??= emptyLineState();
  const settings = s.lineSettings ?? defaultLineSettings(s.store.id);
  const origin = typeof location !== 'undefined' ? location.origin : '';
  const io = memoryLineIO({ store: { id: s.store.id, name: s.store.name, phone: s.store.phone, slug: s.store.slug, business_type: s.store.business_type },
    settings: demo ? { ...settings, enabled: true, confirm_enabled: true, revisit_enabled: true } : settings,
    menus: s.menus, bookings: s.bookings, customers: s.customers, sales: s.sales, hist: s.histVisits, line: s.line,
    bookingUrl: s.store.slug ? `${origin}/r/${s.store.slug}` : null, vacancy: (from, days) => vacancyRateOf(from, days, s.shifts, s.bookings, s.menus) });
  // 「変更したい」・メッセージは台帳の「お知らせ」にも出す
  const base = io.notifyStaff;
  io.notifyStaff = async n => { await base(n); s.notifications.push({ id: uid(), store_id: s.store.id, booking_id: n.booking_id ?? null, kind: n.kind, channel: 'app', subject: n.subject, body: n.body, status: 'skipped', created_at: nowIso() }); };
  return io;
}
/** デモの送信（LINEには送らない。受信箱に status=demo で残る） */
const DEMO_SENDER: LineSender = { demo: true, async push() {}, async reply() {} };
/** デモの LINE のつなぎ（監査ログは残さない＝デモ） */
function demoLinkApplyIO(s: State): LinkApplyIO {
  const io = demoLineIO(s);
  return { linkOfCustomer: io.linkOfCustomer, linkByUser: io.linkByUser, saveLink: io.saveLink, logMessage: io.logMessage, monthCount: io.monthCount, async audit() {} };
}
export const STAFF_HAS_HISTORY = '過去の予約・売上・シフト・カルテにこの人の名前が残っているため削除できません。「退職」にしてください（過去の記録には名前が残ります）。';

// ---- デモの「ログイン中のスタッフ」（右上で役割を切り替えて、権限の違いを試せる） ----
export const DEMO_ROLE_KEY = 'salon-app-demo-role';
export type DemoRole = 'owner'|'manager'|'staff';
export function getDemoRole(): DemoRole { try { const r = localStorage.getItem(DEMO_ROLE_KEY); return r === 'manager' || r === 'staff' ? r : 'owner'; } catch { return 'owner'; } }
export function setDemoRole(r: DemoRole) { try { localStorage.setItem(DEMO_ROLE_KEY, r); } catch {} }
/** デモ：設定＞ユーザーの「ユーザーを追加」。パスワードはチェックだけして捨てる（保存しない） */
function demoCreateUser(s: State, me: Staff, a: Extract<StaffLoginAction, { kind: 'create_user' }>): StaffLoginResult {
  if (me.role !== 'owner') throw new Error('ユーザーの追加はオーナーだけができます');
  s.staffLogins ??= {}; s.loginHistory ??= [];
  const email = normalizeEmail(String(a.email ?? '')); const must = a.must_change !== false;
  let t = a.staff_id ? s.staff.find(x => x.id === a.staff_id) : undefined;
  if (a.staff_id && !t) throw new Error('スタッフが見つかりません');
  if (t) {
    const err = loginPermissionError('create_user', { staff_id: me.id, role: me.role }, t); if (err) throw new Error(err);
    if ((s.staffLogins[t.id]?.status ?? (t.auth_user_id ? 'active' : 'none')) !== 'none') throw new Error('このスタッフにはもうログインがあります（パスワードは「パスワードを変更」から）');
  } else {
    const name = String(a.name ?? '').trim();
    if (!name) throw new Error('名前を入れてください');
    if (name.length > 40) throw new Error('名前は40文字までにしてください');
    if (!isUserRole(a.role)) throw new Error('役割は「スタッフ」か「店長」から選んでください（オーナーは作れません）');
  }
  if (!isValidEmail(email)) throw new Error('メールアドレスが正しくありません');
  const bad = checkNewPassword(String(a.password ?? ''), email); if (bad) throw new Error(bad);
  const dup = s.staff.find(x => x.id !== t?.id && normalizeEmail(x.email || '') === email);
  if (dup) throw new Error(`このメールは「${dup.name}」さんで使われています。別のメールにしてください`);
  if (!t) {
    const on = a.show_on_ledger !== false;
    t = { id: uid(), company_id: s.store.company_id, name: String(a.name).trim(), role: a.role, active: true, show_on_ledger: on, web_nominatable: on, nomination_fee: 0, home_store_id: s.store.id, store_ids: [s.store.id], sort_order: Math.max(0, ...s.staff.map(x => x.sort_order ?? 0)) + 1 } as Staff;
    s.staff.push(t);
  }
  t.email = email;
  s.staffLogins[t.id] = { status: 'invited', email, must_change: must };
  s.loginHistory.unshift({ at: nowIso(), action: 'user_create', actor_name: me.name, target_name: t.name, reason: null });
  save(s);
  return { ok: true, demo: true, message: `${t.name}さんのユーザーを作りました（デモ：本物のログインは作っていません）。${must ? '最初のログインで本人に自分のパスワードを決めてもらいます' : '決めたパスワードのまま使えます'}`, email, status: 'invited', staff_id: t.id };
}
function demoMe(store: Store): Staff {
  const role = getDemoRole();
  return { id: `demo-${role}`, company_id: store.company_id, name: role === 'owner' ? '中嶋' : role === 'manager' ? '店長デモ' : 'スタッフデモ', role, active: true };
}
const liveB = (b: Booking) => b.status === 'booked' || b.status === 'arrived' || b.status === 'done';
/** 予約トラッキング（本番は 0013 のトリガーが記録する。デモは同じ内容をここで残す） */
function rec(s: State, before: Booking|null, after: Booking|null, source: HistorySource, actor?: string|null) {
  if (!worthRecording(before, after)) return;
  s.bookingHistory ??= [];
  const b = (after || before)!;
  s.bookingHistory.push({ id: uid(), booking_id: b.id, at: nowIso(), op: opOf(before, after), source, actor_name: source === 'ledger' ? actor ?? demoMe(s.store).name : null, snapshot: pickHistory(after || before!), before: before ? pickHistory(before) : null });
}
const ledgerRec = (s: State, before: Booking|null, after: Booking|null) => rec(s, before, after, 'ledger', demoMe(s.store).name);
function couponUse(s: State) {
  const out: Record<ID, number> = {};
  for (const b of s.bookings) if (b.coupon_id && liveB(b) && !b.customer_name?.endsWith('（同行者）')) out[b.coupon_id] = (out[b.coupon_id] || 0) + 1;
  for (const x of s.sales) if (x.coupon_id && x.status === 'confirmed' && !(x.booking_id && s.bookings.some(b => b.id === x.booking_id && b.coupon_id === x.coupon_id))) out[x.coupon_id] = (out[x.coupon_id] || 0) + 1;
  return out;
}

// ---- 公式ネット予約（デモ）：同じブラウザの端末内データで、本番の public_* 関数と同じ動きをする ----
function stateBySlug(slug: string): State | null {
  for (const id of Object.keys(SEEDS)) { const st = load(id); if (st.store.slug === slug.trim().toLowerCase()) return st; }
  return null;
}
/** デモ：プライバシーポリシー・利用規約のページ用（店舗名・会社名・電話・住所だけ） */
export function memoryLegalStore(slug: string) {
  const st = stateBySlug(slug); if (!st?.store.slug) return null;
  const x = st.store;
  return { slug: x.slug!, name: x.name, company_name: x.company_legal_name || x.company_name || null, phone: x.phone ?? null, address: x.address ?? null };
}
const err = (code: string) => new Error(code);
const usedCount = (st: State, couponId: string, customerId?: string) => st.bookings.filter(b => b.coupon_id === couponId && liveB(b) && (!customerId || b.customer_id === customerId)).length;
function catalog(st: State, code?: string|null): PublicCatalog {
  const lanes = st.lanes;
  // オプション：ネット予約に出す選択肢があるグループだけ
  const groups = st.optionGroups.filter(g => g.active).sort((a, b) => a.sort_order - b.sort_order)
    .map(g => ({ id: g.id, name: g.name, name_en: g.name_en, description: g.description, required: g.required, multi: g.multi,
      items: st.menus.filter(m => m.category === 'option' && m.active && m.web_visible !== false && m.option_group_id === g.id).sort((a, b) => a.sort_order - b.sort_order).map(m => ({ id: m.id, name: m.name, name_en: m.name_en, description: m.description, price: m.price, minutes: m.duration_min })) }))
    .filter(g => g.items.length);
  const gids = (ids?: string[]|null) => (ids || []).filter(id => groups.some(g => g.id === id));
  const webMenus = st.menus.filter(m => m.active && m.web_visible !== false && m.category === 'technical' && publishedNow(m.publish_from, m.publish_to)).sort((a, b) => a.sort_order - b.sort_order);
  const toPublic = (m: Menu): PublicMenu => ({ id: m.id, name: m.name, name_en: m.name_en, description: m.description, description_en: m.description_en, image_url: m.image_url, price: m.price, duration_min: m.duration_min, target: m.target || 'all', nominatable: m.nominatable !== false, people: menuPeople(m, lanes), color: m.color, option_group_ids: gids(m.option_group_ids), price_per: 'group' as const });
  const coupons = st.coupons.filter(c => c.active && c.web_visible && publishedNow(c.publish_from, c.publish_to) && (!c.code || (code && code.trim().toLowerCase() === c.code.trim().toLowerCase())) && (!c.first_n || c.first_n > usedCount(st, c.id))).sort((a, b) => a.sort_order - b.sort_order)
      .map(c => ({ id: c.id, name: c.name, name_en: c.name_en, description: c.description, description_en: c.description_en, kind: c.kind, value: c.value, menu_ids: c.menu_ids, target: c.target, within_days: c.within_days, weekdays: c.weekdays, time_from: c.time_from, time_to: c.time_to, has_code: !!c.code, left: c.first_n ? Math.max(0, c.first_n - usedCount(st, c.id)) : null, option_group_ids: gids(c.option_group_ids) }));
  // 0018：クーポン専用はメニュー欄に出さない。掲載中のクーポンが対象にしているものだけ coupon_menus に
  const targeted = new Set(coupons.flatMap(c => c.menu_ids));
  return {
    menus: webMenus.filter(m => !m.coupon_only).map(toPublic),
    coupon_menus: webMenus.filter(m => m.coupon_only && targeted.has(m.id)).map(m => ({ ...toPublic(m), coupon_only: true })),
    coupons,
    staff: st.staff.filter(x => onLedger(x) && x.web_nominatable !== false && x.role !== 'viewer').sort(byStaffOrder).map(x => ({ id: x.id, name: x.display_name?.trim() || x.name, name_en: x.name_en || null, fee: x.nomination_fee || 0 })),
    option_groups: groups,
  };
}
/** 選んだオプション（ネット予約に出すもの・このメニュー／クーポンのグループ）。strict＝必須・1つだけも確認 */
function webOptions(st: State, menu: Menu, coupon: Coupon|null, ids: string[]|undefined, strict: boolean) {
  const choices = optionChoices(menu, coupon, st.optionGroups, st.menus, true);
  const sel = [...new Set(ids || [])];
  const e = optionError(choices, sel);
  if (e && (strict || e === 'option_invalid')) return { error: e, items: [] as Menu[] };
  const items = sel.map(id => st.menus.find(m => m.id === id)!).filter(Boolean);
  return { error: null, items };
}
function slotsOf(st: State, menuId: string, date: string, couponId?: string|null, staffId?: string|null, optionIds?: string[]) {
  const menu = st.menus.find(m => m.id === menuId); if (!menu) return [];
  const coupon = couponId ? st.coupons.find(c => c.id === couponId) || null : null;
  if (couponId && !coupon) return [];
  const o = webOptions(st, menu, coupon, optionIds, false); if (o.error) return [];
  return webSlots({ store: st.store, menu, coupon, options: o.items, lanes: st.lanes, shifts: st.shifts, bookings: st.bookings, staff: st.staff, date, staffId });
}
const addDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return ymd(x); };

/** ネット予約の確定（デモ）。line を渡すと LINE予約（0022・案B）：そのLINEのお客様がいればその人、いなければ新しいお客様を作ってつなぐ */
function webCreateBooking(i: PublicBookingInput, line: { uid: string; name: string } | null): PublicBookingResult & { customer_created?: boolean } {
    const st = stateBySlug(i.slug); if (!st || !st.store.web_booking_enabled) throw err('store_not_found');
    const name = i.name.trim(), kana = i.kana.trim(), email = i.email.trim().toLowerCase(), phone = normPhone(i.phone);
    if (!name || name.length > 60) throw err('invalid_name');
    if (kana.length > 60 || (i.lang === 'ja' && !kana)) throw err('invalid_kana');
    if (phone.length < 8 || phone.length > 15) throw err('invalid_phone');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err('invalid_email');
    if (i.intake.length > 30 || JSON.stringify(i.intake).length > 8000) throw err('invalid_intake');
    const m = st.menus.find(x => x.id === i.menu_id); if (!m) throw err('menu_not_found');
    if (!webBookableWith(m, i.coupon_id ? st.coupons.find(c => c.id === i.coupon_id) : null)) throw err('menu_coupon_only');
    const sameCust = (b: Booking) => { const c = st.customers.find(x => x.id === b.customer_id); return !!c && normPhone(c.phone || '') === phone; };
    const hourAgo = Date.now() - 3600000;
    if (st.bookings.filter(b => b.channel === 'own' && b.cancel_token && sameCust(b) && new Date(b.created_at).getTime() > hourAgo).length >= 3
      || st.bookings.filter(b => b.channel === 'own' && b.cancel_token && sameCust(b) && b.status === 'booked' && new Date(b.start_at).getTime() > Date.now()).length >= 5) throw err('too_many');
    const start = new Date(i.start_at); const date = ymd(start);
    const opt = webOptions(st, m, i.coupon_id ? st.coupons.find(c => c.id === i.coupon_id) || null : null, i.option_ids, true);
    if (opt.error) throw err(opt.error);
    const slot = slotsOf(st, m.id, date, i.coupon_id, i.staff_id, i.option_ids).find(x => x.start.getTime() === start.getTime());
    if (!slot) throw err('slot_taken');
    let cust: Customer | undefined;
    const check: string[] = [];
    if (line) {
      // 0022（案B）：LINEのユーザーIDが本人。電話番号では既存のお客様につながない
      const l = st.line?.links.find(x => x.line_user_id === line.uid && x.customer_id);
      const c0 = l ? st.customers.find(c => c.id === l.customer_id) : undefined;
      cust = c0?.merged_into ? st.customers.find(c => c.id === c0.merged_into && !c.merged_into) : c0;
      if (st.bookings.filter(b => b.channel === 'own' && b.cancel_token && cust && b.customer_id === cust.id && Date.now() - new Date(b.created_at).getTime() < 86400000).length >= 5) throw err('too_many');
    } else {
      cust = st.customers.find(c => !c.merged_into && normPhone(c.phone || '') === phone);
    }
    // 0020：既存のお客様の名前・フリガナ・メール・電話はネット予約の入力で変えない・埋めない（入力は予約の web_* に残す）
    const newCust = !cust;
    if (!cust) {
      cust = { id: uid(), company_id: st.store.company_id, name, kana: kana || null, phone: i.phone, email, source: 'own', created_at: nowIso() }; st.customers.unshift(cust);
      if (line) {
        st.line ??= emptyLineState();
        const ex = st.line.links.find(x => x.line_user_id === line.uid);
        if (ex) Object.assign(ex, { customer_id: cust.id, display_name: ex.display_name || line.name, linked_at: nowIso(), linked_via: 'line_id', needs_confirm: false, updated_at: nowIso() });
        else st.line.links.push({ id: uid(), store_id: st.store.id, line_user_id: line.uid, customer_id: cust.id, display_name: line.name, followed: true, opted_out: false, linked_at: nowIso(), linked_via: 'line_id', needs_confirm: false, created_at: nowIso(), updated_at: nowIso() });
      }
    }
    if (line && samePhoneCustomers({ ...cust, phone: i.phone }, st.customers).length) {
      const cpNew = i.coupon_id ? st.coupons.find(c => c.id === i.coupon_id)?.target === 'new' : false;
      check.push(`同じ電話番号のお客様がいます${m.target === 'new' || cpNew ? '（新規クーポンの対象外の可能性）' : ''}`);
    }
    if (st.bookings.some(b => b.customer_id === cust!.id && b.start_at === start.toISOString() && (b.status === 'booked' || b.status === 'arrived'))) throw err('duplicate');
    const visits = [...st.sales.filter(x => x.customer_id === cust!.id && x.status === 'confirmed').map(x => x.sold_at), ...st.bookings.filter(b => b.customer_id === cust!.id && b.status === 'done').map(b => b.start_at), ...histTimes(st, cust.id)].sort();
    const last = visits[visits.length - 1]; const isNew = !last;
    // 0020（C1）：来店歴で決まる条件は断らず、スタッフに「要確認」（断るとお客様かどうかが外から分かる）
    if (m.target === 'new' && !isNew) check.push('新規限定メニューの対象外の可能性');
    if (m.target === 'repeat' && isNew) check.push('再来限定メニューの対象外の可能性');
    let price = m.price; const cp = i.coupon_id ? st.coupons.find(c => c.id === i.coupon_id) : undefined;
    if (i.coupon_id) {
      if (!cp || !cp.active || !cp.web_visible || !publishedNow(cp.publish_from, cp.publish_to)) throw err('coupon_invalid');
      if (cp.code && (i.code || '').trim().toLowerCase() !== cp.code.trim().toLowerCase()) throw err('coupon_code');
      if (cp.menu_ids.length && !cp.menu_ids.includes(m.id)) throw err('coupon_menu');
      if (cp.target === 'new' && !isNew) check.push('新規クーポンの対象外の可能性');
      if (cp.target === 'repeat' && isNew) check.push('再来クーポンの対象外の可能性');
      if (cp.within_days && (!last || (new Date(`${date}T00:00:00`).getTime() - new Date(`${ymd(new Date(last))}T00:00:00`).getTime()) / 86400000 > cp.within_days)) check.push(`前回から${cp.within_days}日以内クーポンの対象外の可能性`);
      if (cp.first_n && usedCount(st, cp.id) >= cp.first_n) throw err('coupon_sold_out');
      if (cp.per_customer_limit && usedCount(st, cp.id, cust.id) >= cp.per_customer_limit) check.push('クーポンの利用回数を超えている可能性');
      price = couponPrice(cp.kind, cp.value, m.price);
    }
    // 指名料（指名したときだけ）。ペアは料金が「1組」、オプションは1名ごと
    const fee = i.staff_id ? st.staff.find(x => x.id === i.staff_id)?.nomination_fee || 0 : 0;
    const people = menuPeople(m, st.lanes);
    const ot = optionTotals(opt.items.map(x => x.id), st.menus);
    const total = price + ot.price * people + fee;
    const ml = menuLane(st.lanes, m.lane_id);
    const end = new Date(start.getTime() + (m.duration_min + ot.minutes + (m.interval_min || 0)) * 60000);
    const hex = () => uid().replace(/-/g, '');
    const token = (hex() + hex()).slice(0, 64).padEnd(64, '0');
    const bno = `W${ymd(new Date()).slice(2).replace(/-/g, '')}-${hex().slice(0, 5).toUpperCase()}`;
    const grp = people > 1 ? uid() : null; let firstId = '';
    const optLabel = opt.items.map(x => x.name).join('＋') || null;
    for (let k = 0; k < people; k++) {
      const b: Booking = { id: uid(), store_id: st.store.id, customer_id: k === 0 ? cust.id : null, customer_name: k === 0 ? null : `${name}（同行者）`, staff_id: slot.staffIds[k] || null, lane_id: ml?.lane.id ?? null,
        start_at: start.toISOString(), end_at: end.toISOString(), status: 'booked', channel: 'own', menu_ids: [m.id, ...opt.items.map(x => x.id)], nominated: !!i.staff_id && k === 0, pair_group: grp, note: `ネット予約 ${bno}${line ? '（LINE）' : ''}${cp ? `／クーポン：${cp.name}` : ''}${optLabel ? `／オプション：${optLabel}` : ''}${fee ? `／指名料 ${fee}円` : ''}${check.length ? `／要確認：${check.join('・')}` : ''}`,
        coupon_id: cp?.id ?? null, intake: k === 0 ? i.intake : null, cancel_token: k === 0 ? token : null, booking_no: bno, price_quote: k === 0 ? total : null, lang: i.lang, created_at: nowIso(), updated_at: nowIso(),
        customer_created: k === 0 && newCust, web_name: k === 0 ? name : null, web_kana: k === 0 ? kana || null : null, web_phone: k === 0 ? i.phone : null, web_email: k === 0 ? email : null, web_check: k === 0 && check.length ? check.join('・') : null };
      st.bookings.push(b); rec(st, null, b, 'web'); if (k === 0) firstId = b.id;
    }
    const sx = st.staff.find(x => x.id === slot.staffIds[0]); const staffName = sx ? sx.display_name?.trim() || sx.name : null;
    const hmS = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    const body = `予約番号：${bno}\n日時：${date.replace(/-/g, '/')} ${hmS}\nメニュー：${m.name}${optLabel ? `＋${optLabel}` : ''}${people > 1 ? `（${people}名様）` : ''}${cp ? `\nクーポン：${cp.name}` : ''}\n料金：${total}円（税込）${fee ? `（指名料 ${fee}円を含む）` : ''}\nお名前：${name}${kana ? `（${kana}）` : ''}\n電話：${i.phone}\nメール：${email}${staffName ? `\n担当：${staffName}${i.staff_id ? '（指名）' : ''}` : ''}`;
    st.notifications.push({ id: uid(), store_id: st.store.id, booking_id: firstId, kind: 'new_booking', channel: 'email', to_address: st.store.notify_email || null, subject: `【新しいネット予約】${date.slice(5).replace('-', '/')} ${hmS} ${name}様`, body, status: 'queued', created_at: nowIso() },
      { id: uid(), store_id: st.store.id, booking_id: firstId, kind: 'booking_confirmation', channel: 'email', to_address: email, subject: `【${st.store.name}】ご予約ありがとうございます（${bno}）`, body, status: 'queued', created_at: nowIso() });
    save(st);
    return { booking_no: bno, cancel_token: token, start_at: start.toISOString(), end_at: end.toISOString(), menu_name: m.name, menu_name_en: m.name_en, price: Math.round(total / people), price_total: total, options_label: optLabel, people, store_name: st.store.name, staff_name: staffName, coupon_name: cp?.name ?? null, deadline: cancelDeadline(st.store, start.toISOString()).toISOString(), customer_created: newCust };
}

export const memoryPublicApi: PublicApi = {
  mode: 'memory',
  async storeInfo(slug) {
    const st = stateBySlug(slug); if (!st || !st.store.web_booking_enabled) return null;
    const x = st.store;
    return { slug: x.slug!, name: x.name, name_en: x.name_en, business_type: x.business_type, phone: x.phone, address: x.address, logo_url: x.logo_url, photo_url: x.photo_url, web_message: x.web_message, cancel_policy: x.cancel_policy,
      cancel_deadline_days: x.cancel_deadline_days ?? 1, cancel_deadline_time: x.cancel_deadline_time || '18:00', booking_horizon_days: x.booking_horizon_days ?? 60, slot_minutes: x.slot_minutes, intake_questions: x.intake_questions, today: ymd(new Date()) } satisfies PublicStore;
  },
  async menus(slug, code) { const st = stateBySlug(slug); return st && st.store.web_booking_enabled ? catalog(st, code) : null; },
  async availability(slug, menuId, from, to, couponId, staffId, optionIds) {
    const st = stateBySlug(slug); if (!st || !st.store.web_booking_enabled) return null;
    const days: Record<string, string[]> = {};
    for (let d = from, n = 0; d < to && n < 31; d = addDay(d, 1), n++) days[d] = slotsOf(st, menuId, d, couponId, staffId, optionIds).map(x => `${String(x.start.getHours()).padStart(2, '0')}:${String(x.start.getMinutes()).padStart(2, '0')}`);
    return { days };
  },
  async createBooking(i) { await new Promise(r => setTimeout(r, 150)); return webCreateBooking(i, null); },
  // 0022（案B）：LINEの中の予約。LINEのユーザーIDが本人（電話番号では既存のお客様につながない）。デモは端末の「デモのLINE」
  async lineBook(i) {
    await new Promise(r => setTimeout(r, 150));
    const st = stateBySlug(i.slug); if (!st?.lineSettings?.enabled) throw err('not_ready');
    const u = demoLineUid();
    const r = webCreateBooking(i, { uid: u, name: 'デモのLINE' });
    return { ...r, line: { linked: true, customer_created: !!r.customer_created } };
  },
  async bookingByToken(token) {
    if (!token || token.length < 32) return null;
    for (const id of Object.keys(SEEDS)) {
      const st = load(id); const b = st.bookings.find(x => x.cancel_token === token); if (!b) continue;
      const m = st.menus.find(x => x.id === b.menu_ids[0]); const dl = cancelDeadline(st.store, b.start_at);
      return { booking_no: b.booking_no || '', status: b.status, start_at: b.start_at, end_at: b.end_at, menu_name: bookingMenuLabel(b.menu_ids, st.menus) || m?.name, menu_name_en: m?.name_en, price: b.price_quote, store_name: st.store.name, store_phone: st.store.phone, slug: st.store.slug || '', customer_name: b.web_name ?? undefined, deadline: dl.toISOString(), cancellable: b.status === 'booked' && Date.now() <= dl.getTime() };
    }
    return null;
  },
  async cancelBooking(token) {
    if (!token || token.length < 32) throw err('not_found');
    for (const id of Object.keys(SEEDS)) {
      const st = load(id); const b = st.bookings.find(x => x.cancel_token === token); if (!b) continue;
      if (b.status === 'cancelled') throw err('already_cancelled');
      if (b.status !== 'booked') throw err('not_cancellable');
      if (Date.now() > cancelDeadline(st.store, b.start_at).getTime()) throw err('deadline_passed');
      for (const x of st.bookings) if (x.id === b.id || (b.pair_group && x.pair_group === b.pair_group)) { const before = { ...x }; x.status = 'cancelled'; x.note = `${x.note || ''}／お客様がネットでキャンセル`; x.updated_at = nowIso(); rec(st, before, x, 'web'); }
      const c = st.customers.find(x => x.id === b.customer_id);
      st.notifications.push({ id: uid(), store_id: st.store.id, booking_id: b.id, kind: 'cancel_booking', channel: 'email', to_address: st.store.notify_email || null, subject: `【ネット予約のキャンセル】${localDate(b.start_at).slice(5).replace('-', '/')} ${c?.name || ''}様`, body: `予約番号：${b.booking_no}`, status: 'queued', created_at: nowIso() });
      save(st); return { ok: true, booking_no: b.booking_no };
    }
    throw err('not_found');
  },
  // LINE連携（デモ）：LIFF は使えないので、この端末の「デモのLINE」でつなぐ
  async lineInfo(slug) { const st = stateBySlug(slug); const ls = st?.lineSettings; return st && ls?.enabled ? { liff_id: ls.liff_id || 'demo', basic_id: ls.bot_basic_id || '@demo' } : null; },
  async linkLine(body) {
    const st = stateBySlug(body.slug); if (!st?.lineSettings?.enabled) return { ok: false, message: 'この店舗のLINE連携は準備中です' };
    const u = demoLineUid();
    const basic_id = st.lineSettings.bot_basic_id || '@demo';
    const io = demoLinkApplyIO(st);
    const base = { storeId: st.store.id, storeName: st.store.name, planLimit: st.lineSettings.plan_limit, lineUserId: u, displayName: 'デモのLINE' };
    if (body.mode !== 'token') return { ok: false, message: 'QRコードが正しくありません' };
    const t = (st.lineTokens ?? []).find(x => x.token === body.token);
    if (!t || t.used_at || Date.parse(t.expires_at) < Date.now()) return { ok: false, message: 'このQRコードは使えません（30分の期限切れ・使用済み）。お店で新しいQRコードを出してもらってください' };
    t.used_at = nowIso();
    await applyLink(io, DEMO_SENDER, { ...base, customerId: t.customer_id, via: 'token', takeOver: true, logText: 'LINE連携（会計のQR・デモ）' });
    save(st); return { ok: true, name: st.customers.find(c => c.id === t.customer_id)?.name ?? null, basic_id };
  },
};
