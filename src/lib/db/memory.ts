// デモ用（Supabase未設定時）。ブラウザの localStorage に保存する。本番では supabase.ts を使う。
// 店舗ごとに別のデータを持ち、ヘッダーの店舗切替で行き来できる。
import type { Repo, Store, Staff, Resource, Lane, Menu, Product, Customer, Booking, Sale, SaleLine, Payment, RegisterClosing, InventoryMove, KarteEntry, NewSaleInput, ID, ShiftPattern, Shift, ShiftMonth, ShiftKind, StoreGoal, PayMethod, Channel, Coupon, AppNotification, AuditLog } from './types';
import { AUTO_IDLE_NOTE } from './types';
import { planAutoIdle, lastOrderOffset } from '../schedule';
import { webSlots, menuLane, publishedNow, couponPrice, cancelDeadline, normPhone, type PublicApi, type PublicStore, type PublicCatalog } from '../web';

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
  /** 先の日付の受付枠IDLE（シフトから自動）を入れたか */
  idleSeeded?: boolean;
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
  ];
}

/** デモの過去・未来データ：過去 months か月＝会計済み（キャンセル・無断・店販・値引・赤伝も少し）、今日〜1か月先＝予約。
 *  シフトも同じ期間（来月だけ未入力＝「先月をコピー」の練習用）。closedDow の曜日は店休。
 *  IDは決まった文字列（保存に失敗して作り直しても同じIDになるように）。 */
function demoHistory(st: State, seed: number, closedDow: number, skipToday: boolean, months = 6) {
  const r = rng(seed); const S = st.store.id; let n = 0; const nid = (k: string) => `${S.slice(-3)}-${k}${++n}`;
  const tech = st.menus.filter(m => m.category === 'technical');
  const opts = st.menus.filter(m => m.category === 'option' && m.price > 0);
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
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-x${i+1}`, company_id: company, name: `${fam[i % fam.length]} ${giv[(i*7 + Math.floor(i / 15)) % giv.length]}`, source: i % 3 ? 'hpb' : 'own', created_at: '2026-01-01T00:00:00.000Z' }));
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
    store: { id: S, company_id: C, company_name: 'BE.COLLECTION.5', name: 'ラシエル箱崎', business_type: 'eyelash', open_time: '10:00', close_time: '19:00', slot_minutes: 15, hpb_salon_id: 'H000805291', ...WEB_DEFAULTS, slug: 'laciel-hakozaki', name_en: 'Laciel Hakozaki', web_booking_enabled: false },
    staff, resources, lanes, menus, products, customers, bookings, sales: [], closings: [], moves: [], kartes: [],
    shiftPatterns: [], shifts: [], shiftMonths: [], goals: [],
    coupons: [mkCoupon(S, 'h-cp1', '【新規】まつ毛パーマ 1,000円引き', 'amount', 1000, ['m1'], { target: 'new', sort_order: 1 }), mkCoupon(S, 'h-cp2', '【再来】前回から45日以内 500円引き', 'amount', 500, [], { target: 'repeat', within_days: 45, sort_order: 2 })],
    notifications: [], audits: [],
  };
}
function seedHakozakiFull(): State { const st = seedHakozaki(); st.customers.push(...extraCustomers(st.store.company_id, 'h', 300)); st.shiftPatterns = defaultPatterns(st.store); demoHistory(st, 7, 2, true); seedFutureIdle(st); return st; }

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
    store: { id: S, company_id: C, company_name: '株式会社KOKAGE', name: 'KOKAGE西五反田', business_type: 'headspa', open_time: '10:00', close_time: '19:00', slot_minutes: 15, hpb_salon_id: 'H000719142', ...WEB_DEFAULTS, slug: 'kokage-gotanda', name_en: 'KOKAGE Nishigotanda', web_booking_enabled: true },
    staff, resources, lanes, menus, products, customers, bookings, sales: [], closings: [], moves: [], kartes: [],
    shiftPatterns: [], shifts: [], shiftMonths: [], goals: [],
    coupons: [
      mkCoupon(S, 'g-cp1', '【新規】90分サブリミックヘッドスパ 初回特別価格', 'fixed', 9900, ['g-m1'], { target: 'new', sort_order: 1, name_en: 'First visit: 90-min Sublimic Head Spa', description: '初めての方限定。人気No.1の90分コースを特別価格で。' }),
      mkCoupon(S, 'g-cp2', '【再来】前回から45日以内のメンテナンス 10%オフ', 'percent', 10, [], { target: 'repeat', within_days: 45, sort_order: 2, name_en: 'Maintenance within 45 days: 10% off', description: '前回のご来店から45日以内のご予約で、全コース10%オフ。' }),
      mkCoupon(S, 'g-cp3', '【平日限定】クイックヘッドスパ 60分', 'fixed', 8800, ['g-m4'], { weekdays: [1, 2, 3, 4, 5], sort_order: 3, name_en: 'Weekdays: Quick Head Spa 60 min' }),
    ],
    notifications: [], audits: [],
  };
}
function seedGotandaFull(): State { const st = seedGotanda(); st.customers.push(...extraCustomers(st.store.company_id, 'g', 300)); st.shiftPatterns = defaultPatterns(st.store); demoHistory(st, 11, 2, true); seedFutureIdle(st); return st; }

/** テスト店舗（練習用）：本番のテスト店舗と同じ扱い。データは3か月分だけ */
function seedTest(): State {
  const S = STORE_TEST, C = COMPANY_TEST;
  const staff: Staff[] = [
    { id: 'bbbbbbbb-0000-0000-0000-000000000901', company_id: C, name: '練習A', role: 'manager', active: true },
    { id: 'bbbbbbbb-0000-0000-0000-000000000902', company_id: C, name: '練習B', role: 'staff', active: true },
  ];
  const menus = [mkMenu(S, 't-m1', 'まつ毛パーマ', 'パーマ', '#d9a441', 6600, 60), mkMenu(S, 't-m2', 'マツエク 100本', '100本', '#e07a9a', 7700, 75), mkMenu(S, 't-m3', '眉Wax', '眉', '#8cc084', 4400, 30, 'technical', 5), mkMenu(S, 't-o1', 'コーティング', 'コート', '#bbbbbb', 1100, 5, 'option', 0)];
  return {
    store: { id: S, company_id: C, company_name: 'テスト会社（練習用）', name: 'テスト店舗（練習用）', business_type: 'eyelash', open_time: '10:00', close_time: '19:00', slot_minutes: 15, ...WEB_DEFAULTS, slug: 'test-store', name_en: 'Test Salon (practice)', web_booking_enabled: true, web_message: '練習用のテスト店舗です。実際のご予約にはなりません。' },
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
  };
}
function seedTestFull(): State { const st = seedTest(); st.customers.push(...extraCustomers(COMPANY_TEST, 't', 120)); st.shiftPatterns = defaultPatterns(st.store); demoHistory(st, 5, 1, false, 3); seedFutureIdle(st); return st; }

const SEEDS: Record<string, () => State> = { [STORE_HAKOZAKI]: seedHakozakiFull, [STORE_GOTANDA]: seedGotandaFull, [STORE_TEST]: seedTestFull };
const LIGHT: Record<string, () => State> = { [STORE_HAKOZAKI]: seedHakozaki, [STORE_GOTANDA]: seedGotanda, [STORE_TEST]: seedTest };
/** 古い端末データ（フェーズBまで）に、フェーズCの項目を足す */
function upgrade(st: State): State {
  const base = LIGHT[st.store.id]?.();
  st.shiftPatterns ??= defaultPatterns(st.store); st.shifts ??= []; st.shiftMonths ??= []; st.goals ??= [];
  if (base) {
    st.store = { ...base.store, ...st.store, slug: st.store.slug ?? base.store.slug, web_booking_enabled: st.store.web_booking_enabled ?? base.store.web_booking_enabled };
    st.menus = st.menus.map(m => { const b = base.menus.find(x => x.id === m.id); return { target: 'all', nominatable: true, web_visible: m.category === 'technical' && m.price > 0, ...(b ? { name_en: b.name_en, description: b.description, description_en: b.description_en, weekdays: b.weekdays } : {}), ...m }; });
    st.coupons ??= base.coupons;
  }
  st.coupons ??= []; st.notifications ??= []; st.audits ??= [];
  if (!st.idleSeeded) { seedFutureIdle(st); save(st); }
  return st;
}
const CUR_KEY = 'salon-app-demo-store';
// v4：過去6か月分の会計・シフト、テスト店舗、目標（v3の端末データは使わず作り直す）
const KEY = (id: string) => `salon-app-demo-v4-${id}`;
for (const old of ['v2', 'v3']) { try { if (typeof window !== 'undefined') for (const id of [STORE_HAKOZAKI, STORE_GOTANDA]) localStorage.removeItem(`salon-app-demo-${old}-${id}`); } catch {} }

function currentStoreId(): string {
  if (typeof window === 'undefined') return STORE_GOTANDA;
  try { return localStorage.getItem(CUR_KEY) || STORE_GOTANDA; } catch { return STORE_GOTANDA; }
}
const CACHE: Record<string, State> = {};
function load(id: string = currentStoreId()): State {
  if (!SEEDS[id]) id = STORE_GOTANDA;
  if (typeof window === 'undefined') return SEEDS[id]();
  try { const s = localStorage.getItem(KEY(id)); if (s) return upgrade(JSON.parse(s) as State); } catch {}
  // 保存できなかった（容量など）ときも同じ内容を使い回す
  if (CACHE[id]) return CACHE[id];
  const st = SEEDS[id](); CACHE[id] = st; save(st); return st;
}
function save(s: State) { CACHE[s.store.id] = s; try { localStorage.setItem(KEY(s.store.id), JSON.stringify(s)); } catch {} }

export function resetDemo() { try { for (const id of Object.keys(SEEDS)) localStorage.removeItem(KEY(id)); } catch {} }

export const memoryRepo: Repo = {
  mode: 'memory',
  async store() { return load().store; },
  async stores() { return [seedGotanda().store, seedHakozaki().store, seedTest().store]; },
  switchStore(id: ID) { try { localStorage.setItem(CUR_KEY, id); } catch {} },
  async lanes() { return load().lanes.filter(l => l.active).sort((a,b) => a.sort_order - b.sort_order); },
  async staff() { return load().staff.filter(s => s.active); },
  async resources() { return load().resources; },
  async menus() { return load().menus.filter(m => m.active); },
  async products() { return load().products.filter(p => p.active); },
  async customers(q) { const cs = load().customers; if (!q) return cs; const k = q.toLowerCase(); return cs.filter(c => (c.name + (c.kana||'') + (c.phone||'')).toLowerCase().includes(k)); },
  async customer(id) { return load().customers.find(c => c.id === id); },
  async upsertCustomer(c) {
    const s = load();
    if (c.id) { const i = s.customers.findIndex(x => x.id === c.id); s.customers[i] = { ...s.customers[i], ...c } as Customer; save(s); return s.customers[i]; }
    const n: Customer = { id: uid(), company_id: s.store.company_id, created_at: nowIso(), ...c } as Customer; s.customers.unshift(n); save(s); return n;
  },
  async bookingsOn(date) { return load().bookings.filter(b => localDate(b.start_at) === date).sort((a,b) => a.start_at.localeCompare(b.start_at)); },
  async bookingsOfCustomer(id) { return load().bookings.filter(b => b.customer_id === id).sort((a,b) => b.start_at.localeCompare(a.start_at)); },
  async bookingsBetween(from, to) { return load().bookings.filter(b => { const d = localDate(b.start_at); return d >= from && d < to; }).sort((a,b) => a.start_at.localeCompare(b.start_at)); },
  async createBookings(list) { const s = load(); for (const b of list) s.bookings.push({ ...b, store_id: s.store.id, id: uid(), created_at: nowIso(), updated_at: nowIso() }); save(s); return list.length; },
  async deleteBookings(ids) { const s = load(); const set = new Set(ids); s.bookings = s.bookings.filter(b => !set.has(b.id)); save(s); },
  async booking(id) { return load().bookings.find(b => b.id === id); },
  async createBooking(b) { const s = load(); const n: Booking = { ...b, store_id: s.store.id, id: uid(), created_at: nowIso(), updated_at: nowIso() }; s.bookings.push(n); save(s); return n; },
  async updateBooking(id, patch) { const s = load(); const i = s.bookings.findIndex(b => b.id === id); s.bookings[i] = { ...s.bookings[i], ...patch, updated_at: nowIso() }; save(s); return s.bookings[i]; },
  async deleteBooking(id) { const s = load(); s.bookings = s.bookings.filter(b => b.id !== id); save(s); },
  async salesOn(date) { return load().sales.filter(x => localDate(x.sold_at) === date).sort((a,b) => a.sold_at.localeCompare(b.sold_at)); },
  async salesOfCustomer(id) { return load().sales.filter(x => x.customer_id === id).sort((a,b) => b.sold_at.localeCompare(a.sold_at)); },
  async salesBetween(from, to) { return load().sales.filter(x => { const d = localDate(x.sold_at); return d >= from && d < to; }).sort((a,b) => a.sold_at.localeCompare(b.sold_at)); },
  async firstVisits(ids) {
    const s = load(); const want = new Set(ids); const out: Record<ID, string> = {};
    const put = (cid: ID|null|undefined, t: string) => { if (cid && want.has(cid) && (!out[cid] || t < out[cid])) out[cid] = t; };
    for (const x of s.sales) if (x.status === 'confirmed') put(x.customer_id, x.sold_at);
    for (const b of s.bookings) if (b.status === 'done') put(b.customer_id, b.start_at);
    return out;
  },
  async createSale(input) {
    const s = load();
    const today = ymd(new Date());
    const seq = s.sales.filter(x => localDate(x.sold_at) === today).length + 1;
    const id = uid();
    const lines: SaleLine[] = input.lines.map(l => ({ ...l, id: uid(), sale_id: id, amount: l.unit_price * l.qty }));
    const subtotal = lines.reduce((a, l) => a + l.amount, 0);
    const total = subtotal - input.discount;
    const tax = Math.floor(total - total / 1.1);
    const payments: Payment[] = input.payments.map(p => ({ ...p, id: uid(), sale_id: id }));
    const sale: Sale = { id, store_id: s.store.id, booking_id: input.booking_id, customer_id: input.customer_id, main_staff_id: input.main_staff_id, sale_no: `${today.replace(/-/g,'')}-${String(seq).padStart(3,'0')}`, sold_at: nowIso(), status: 'confirmed', subtotal, discount: input.discount, tax, total, discount_reason: input.discount_reason, note: input.note, lines, payments, coupon_id: input.coupon_id ?? null };
    s.sales.push(sale);
    for (const l of lines) if (l.kind === 'product' && l.product_id) {
      const p = s.products.find(p => p.id === l.product_id); if (p) { p.stock -= l.qty; s.moves.push({ id: uid(), product_id: p.id, store_id: s.store.id, qty: -l.qty, reason: 'sale', moved_at: nowIso() }); }
    }
    if (input.booking_id) { const b = s.bookings.find(b => b.id === input.booking_id); if (b) b.status = 'done'; }
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
  async capabilities() { return { goals: true, shiftBreaks: true, lastOrder: true, phaseC: true }; },
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
  async notifications(onlyUnread) { return load().notifications.filter(n => (n.kind === 'new_booking' || n.kind === 'cancel_booking') && (!onlyUnread || !n.read_at)).sort((a, b) => b.created_at.localeCompare(a.created_at)); },
  async markNotificationsRead(ids) { const s = load(); const set = new Set(ids); for (const n of s.notifications) if (set.has(n.id) && !n.read_at) n.read_at = nowIso(); save(s); },
  async auditLogs(from, to) { return load().audits.filter(a => { const d = localDate(a.at); return d >= from && d < to; }).sort((a, b) => b.at.localeCompare(a.at)); },
};

// ---- デモの「ログイン中のスタッフ」（右上で役割を切り替えて、権限の違いを試せる） ----
export const DEMO_ROLE_KEY = 'salon-app-demo-role';
export type DemoRole = 'owner'|'manager'|'staff';
export function getDemoRole(): DemoRole { try { const r = localStorage.getItem(DEMO_ROLE_KEY); return r === 'manager' || r === 'staff' ? r : 'owner'; } catch { return 'owner'; } }
export function setDemoRole(r: DemoRole) { try { localStorage.setItem(DEMO_ROLE_KEY, r); } catch {} }
function demoMe(store: Store): Staff {
  const role = getDemoRole();
  return { id: `demo-${role}`, company_id: store.company_id, name: role === 'owner' ? '中嶋' : role === 'manager' ? '店長デモ' : 'スタッフデモ', role, active: true };
}
const liveB = (b: Booking) => b.status === 'booked' || b.status === 'arrived' || b.status === 'done';
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
const err = (code: string) => new Error(code);
const usedCount = (st: State, couponId: string, customerId?: string) => st.bookings.filter(b => b.coupon_id === couponId && liveB(b) && (!customerId || b.customer_id === customerId)).length;
function catalog(st: State, code?: string|null): PublicCatalog {
  const lanes = st.lanes;
  return {
    menus: st.menus.filter(m => m.active && m.web_visible !== false && m.category === 'technical' && publishedNow(m.publish_from, m.publish_to)).sort((a, b) => a.sort_order - b.sort_order)
      .map(m => ({ id: m.id, name: m.name, name_en: m.name_en, description: m.description, description_en: m.description_en, image_url: m.image_url, price: m.price, duration_min: m.duration_min, target: m.target || 'all', nominatable: m.nominatable !== false, people: menuLane(lanes, m.lane_id)?.people || 1, color: m.color })),
    coupons: st.coupons.filter(c => c.active && c.web_visible && publishedNow(c.publish_from, c.publish_to) && (!c.code || (code && code.trim().toLowerCase() === c.code.trim().toLowerCase())) && (!c.first_n || c.first_n > usedCount(st, c.id))).sort((a, b) => a.sort_order - b.sort_order)
      .map(c => ({ id: c.id, name: c.name, name_en: c.name_en, description: c.description, description_en: c.description_en, kind: c.kind, value: c.value, menu_ids: c.menu_ids, target: c.target, within_days: c.within_days, weekdays: c.weekdays, time_from: c.time_from, time_to: c.time_to, has_code: !!c.code, left: c.first_n ? Math.max(0, c.first_n - usedCount(st, c.id)) : null })),
    staff: st.staff.filter(x => x.active && x.role !== 'viewer').map(x => ({ id: x.id, name: x.name })),
  };
}
function slotsOf(st: State, menuId: string, date: string, couponId?: string|null, staffId?: string|null) {
  const menu = st.menus.find(m => m.id === menuId); if (!menu) return [];
  const coupon = couponId ? st.coupons.find(c => c.id === couponId) || null : null;
  if (couponId && !coupon) return [];
  return webSlots({ store: st.store, menu, coupon, lanes: st.lanes, shifts: st.shifts, bookings: st.bookings, staff: st.staff, date, staffId });
}
const addDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return ymd(x); };

export const memoryPublicApi: PublicApi = {
  mode: 'memory',
  async storeInfo(slug) {
    const st = stateBySlug(slug); if (!st || !st.store.web_booking_enabled) return null;
    const x = st.store;
    return { slug: x.slug!, name: x.name, name_en: x.name_en, business_type: x.business_type, phone: x.phone, address: x.address, logo_url: x.logo_url, photo_url: x.photo_url, web_message: x.web_message, cancel_policy: x.cancel_policy,
      cancel_deadline_days: x.cancel_deadline_days ?? 1, cancel_deadline_time: x.cancel_deadline_time || '18:00', booking_horizon_days: x.booking_horizon_days ?? 60, slot_minutes: x.slot_minutes, intake_questions: x.intake_questions, today: ymd(new Date()) } satisfies PublicStore;
  },
  async menus(slug, code) { const st = stateBySlug(slug); return st && st.store.web_booking_enabled ? catalog(st, code) : null; },
  async availability(slug, menuId, from, to, couponId, staffId) {
    const st = stateBySlug(slug); if (!st || !st.store.web_booking_enabled) return null;
    const days: Record<string, string[]> = {};
    for (let d = from, n = 0; d < to && n < 31; d = addDay(d, 1), n++) days[d] = slotsOf(st, menuId, d, couponId, staffId).map(x => `${String(x.start.getHours()).padStart(2, '0')}:${String(x.start.getMinutes()).padStart(2, '0')}`);
    return { days };
  },
  async createBooking(i) {
    await new Promise(r => setTimeout(r, 150));
    const st = stateBySlug(i.slug); if (!st || !st.store.web_booking_enabled) throw err('store_not_found');
    const name = i.name.trim(), kana = i.kana.trim(), email = i.email.trim().toLowerCase(), phone = normPhone(i.phone);
    if (!name || name.length > 60) throw err('invalid_name');
    if (kana.length > 60 || (i.lang === 'ja' && !kana)) throw err('invalid_kana');
    if (phone.length < 8 || phone.length > 15) throw err('invalid_phone');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err('invalid_email');
    if (i.intake.length > 30 || JSON.stringify(i.intake).length > 8000) throw err('invalid_intake');
    const m = st.menus.find(x => x.id === i.menu_id); if (!m) throw err('menu_not_found');
    const sameCust = (b: Booking) => { const c = st.customers.find(x => x.id === b.customer_id); return !!c && normPhone(c.phone || '') === phone; };
    const hourAgo = Date.now() - 3600000;
    if (st.bookings.filter(b => b.channel === 'own' && b.cancel_token && sameCust(b) && new Date(b.created_at).getTime() > hourAgo).length >= 3
      || st.bookings.filter(b => b.channel === 'own' && b.cancel_token && sameCust(b) && b.status === 'booked' && new Date(b.start_at).getTime() > Date.now()).length >= 5) throw err('too_many');
    const start = new Date(i.start_at); const date = ymd(start);
    const slot = slotsOf(st, m.id, date, i.coupon_id, i.staff_id).find(x => x.start.getTime() === start.getTime());
    if (!slot) throw err('slot_taken');
    let cust = st.customers.find(c => normPhone(c.phone || '') === phone);
    if (!cust) { cust = { id: uid(), company_id: st.store.company_id, name, kana: kana || null, phone: i.phone, email, source: 'own', created_at: nowIso() }; st.customers.unshift(cust); }
    else if (!cust.email) cust.email = email;
    if (st.bookings.some(b => b.customer_id === cust!.id && b.start_at === start.toISOString() && (b.status === 'booked' || b.status === 'arrived'))) throw err('duplicate');
    const visits = [...st.sales.filter(x => x.customer_id === cust!.id && x.status === 'confirmed').map(x => x.sold_at), ...st.bookings.filter(b => b.customer_id === cust!.id && b.status === 'done').map(b => b.start_at)].sort();
    const last = visits[visits.length - 1]; const isNew = !last;
    if (m.target === 'new' && !isNew) throw err('menu_new_only');
    if (m.target === 'repeat' && isNew) throw err('menu_repeat_only');
    let price = m.price; const cp = i.coupon_id ? st.coupons.find(c => c.id === i.coupon_id) : undefined;
    if (i.coupon_id) {
      if (!cp || !cp.active || !cp.web_visible || !publishedNow(cp.publish_from, cp.publish_to)) throw err('coupon_invalid');
      if (cp.code && (i.code || '').trim().toLowerCase() !== cp.code.trim().toLowerCase()) throw err('coupon_code');
      if (cp.menu_ids.length && !cp.menu_ids.includes(m.id)) throw err('coupon_menu');
      if (cp.target === 'new' && !isNew) throw err('coupon_new_only');
      if (cp.target === 'repeat' && isNew) throw err('coupon_repeat_only');
      if (cp.within_days && (!last || (new Date(`${date}T00:00:00`).getTime() - new Date(`${ymd(new Date(last))}T00:00:00`).getTime()) / 86400000 > cp.within_days)) throw err('coupon_within_days');
      if (cp.first_n && usedCount(st, cp.id) >= cp.first_n) throw err('coupon_sold_out');
      if (cp.per_customer_limit && usedCount(st, cp.id, cust.id) >= cp.per_customer_limit) throw err('coupon_limit');
      price = couponPrice(cp.kind, cp.value, m.price);
    }
    const ml = menuLane(st.lanes, m.lane_id)!;
    const end = new Date(start.getTime() + (m.duration_min + (m.interval_min || 0)) * 60000);
    const hex = () => uid().replace(/-/g, '');
    const token = (hex() + hex()).slice(0, 64).padEnd(64, '0');
    const bno = `W${ymd(new Date()).slice(2).replace(/-/g, '')}-${hex().slice(0, 5).toUpperCase()}`;
    const grp = ml.people > 1 ? uid() : null; let firstId = '';
    for (let k = 0; k < ml.people; k++) {
      const b: Booking = { id: uid(), store_id: st.store.id, customer_id: k === 0 ? cust.id : null, customer_name: k === 0 ? null : `${name}（同行者）`, staff_id: slot.staffIds[k] || null, lane_id: ml.lane.id,
        start_at: start.toISOString(), end_at: end.toISOString(), status: 'booked', channel: 'own', menu_ids: [m.id], nominated: !!i.staff_id, pair_group: grp, note: `ネット予約 ${bno}${cp ? `／クーポン：${cp.name}` : ''}`,
        coupon_id: cp?.id ?? null, intake: k === 0 ? i.intake : null, cancel_token: k === 0 ? token : null, booking_no: bno, price_quote: price, lang: i.lang, created_at: nowIso(), updated_at: nowIso() };
      st.bookings.push(b); if (k === 0) firstId = b.id;
    }
    const staffName = st.staff.find(x => x.id === slot.staffIds[0])?.name || null;
    const hmS = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    const body = `予約番号：${bno}\n日時：${date.replace(/-/g, '/')} ${hmS}\nメニュー：${m.name}${cp ? `\nクーポン：${cp.name}` : ''}\n料金：${price * ml.people}円（税込）\nお名前：${name}${kana ? `（${kana}）` : ''}\n電話：${i.phone}\nメール：${email}${staffName ? `\n担当：${staffName}${i.staff_id ? '（指名）' : ''}` : ''}`;
    st.notifications.push({ id: uid(), store_id: st.store.id, booking_id: firstId, kind: 'new_booking', channel: 'email', to_address: st.store.notify_email || null, subject: `【新しいネット予約】${date.slice(5).replace('-', '/')} ${hmS} ${name}様`, body, status: 'queued', created_at: nowIso() },
      { id: uid(), store_id: st.store.id, booking_id: firstId, kind: 'booking_confirmation', channel: 'email', to_address: email, subject: `【${st.store.name}】ご予約ありがとうございます（${bno}）`, body, status: 'queued', created_at: nowIso() });
    save(st);
    return { booking_no: bno, cancel_token: token, start_at: start.toISOString(), end_at: end.toISOString(), menu_name: m.name, menu_name_en: m.name_en, price, people: ml.people, store_name: st.store.name, staff_name: staffName, coupon_name: cp?.name ?? null, deadline: cancelDeadline(st.store, start.toISOString()).toISOString() };
  },
  async bookingByToken(token) {
    if (!token || token.length < 32) return null;
    for (const id of Object.keys(SEEDS)) {
      const st = load(id); const b = st.bookings.find(x => x.cancel_token === token); if (!b) continue;
      const m = st.menus.find(x => x.id === b.menu_ids[0]); const dl = cancelDeadline(st.store, b.start_at);
      return { booking_no: b.booking_no || '', status: b.status, start_at: b.start_at, end_at: b.end_at, menu_name: m?.name, menu_name_en: m?.name_en, price: b.price_quote, store_name: st.store.name, store_phone: st.store.phone, slug: st.store.slug || '', customer_name: st.customers.find(c => c.id === b.customer_id)?.name, deadline: dl.toISOString(), cancellable: b.status === 'booked' && Date.now() <= dl.getTime() };
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
      for (const x of st.bookings) if (x.id === b.id || (b.pair_group && x.pair_group === b.pair_group)) { x.status = 'cancelled'; x.note = `${x.note || ''}／お客様がネットでキャンセル`; x.updated_at = nowIso(); }
      const c = st.customers.find(x => x.id === b.customer_id);
      st.notifications.push({ id: uid(), store_id: st.store.id, booking_id: b.id, kind: 'cancel_booking', channel: 'email', to_address: st.store.notify_email || null, subject: `【ネット予約のキャンセル】${localDate(b.start_at).slice(5).replace('-', '/')} ${c?.name || ''}様`, body: `予約番号：${b.booking_no}`, status: 'queued', created_at: nowIso() });
      save(st); return { ok: true, booking_no: b.booking_no };
    }
    throw err('not_found');
  },
};
