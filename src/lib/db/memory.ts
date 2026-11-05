// デモ用（Supabase未設定時）。ブラウザの localStorage に保存する。本番では supabase.ts を使う。
// 店舗ごとに別のデータを持ち、ヘッダーの店舗切替で行き来できる。
import type { Repo, Store, Staff, Resource, Lane, Menu, Product, Customer, Booking, Sale, SaleLine, Payment, RegisterClosing, InventoryMove, KarteEntry, NewSaleInput, ID, ShiftPattern, Shift, ShiftMonth, ShiftKind } from './types';

export const STORE_HAKOZAKI = 'aaaaaaaa-0000-0000-0000-000000000001';
export const STORE_GOTANDA = 'aaaaaaaa-0000-0000-0000-000000000002';
const COMPANY_BC5 = '11111111-1111-1111-1111-111111111111';
const COMPANY_KOKAGE = '22222222-2222-2222-2222-222222222222';

const uid = () => (typeof globalThis.crypto !== 'undefined' && 'randomUUID' in globalThis.crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const nowIso = () => new Date().toISOString();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const localDate = (iso: string) => ymd(new Date(iso));

interface State {
  store: Store; staff: Staff[]; resources: Resource[]; lanes: Lane[]; menus: Menu[]; products: Product[]; customers: Customer[];
  bookings: Booking[]; sales: Sale[]; closings: RegisterClosing[]; moves: InventoryMove[]; kartes: KarteEntry[];
  shiftPatterns: ShiftPattern[]; shifts: Shift[]; shiftMonths: ShiftMonth[];
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

/** 過去約2か月＝会計済み、今日〜3週間先＝予約。closedDow の曜日は店休。 */
function demoHistory(st: State, seed: number, closedDow: number, skipToday: boolean) {
  const r = rng(seed); const S = st.store.id;
  const tech = st.menus.filter(m => m.category === 'technical');
  const now = new Date(); const today = ymd(now);
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now); end.setDate(end.getDate() + 21);
  const slots = [10*60, 11*60+45, 13*60+30, 15*60+15, 17*60];
  const seqByDay: Record<string, number> = {};
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = ymd(d);
    if (d.getDay() === closedDow || (skipToday && day === today)) continue;
    const n = 1 + Math.floor(r() * 4);
    const used = new Set<string>();
    for (let i = 0; i < n; i++) {
      const staff = st.staff[Math.floor(r() * st.staff.length)];
      const slot = slots[Math.floor(r() * slots.length)];
      if (used.has(staff.id + slot)) continue; used.add(staff.id + slot);
      const m = tech[Math.floor(r() * tech.length)];
      const cust = st.customers[Math.floor(Math.pow(r(), 1.3) * st.customers.length)];
      const past = day < today;
      const startIso = at(day, Math.floor(slot/60), slot%60), endIso = at(day, Math.floor((slot+m.duration_min)/60), (slot+m.duration_min)%60);
      const ch = (['hpb','hpb','own','phone','line'] as const)[Math.floor(r()*5)];
      const b: Booking = { id: uid(), store_id: S, customer_id: cust.id, staff_id: staff.id, resource_id: st.resources[0]?.id, start_at: startIso, end_at: endIso, status: past ? 'done' : 'booked', channel: ch, menu_ids: [m.id], nominated: r() < 0.3, created_at: nowIso(), updated_at: nowIso() };
      st.bookings.push(b);
      if (past) {
        const seq = (seqByDay[day] = (seqByDay[day] || 0) + 1);
        const id = uid();
        const pm = (['cash','card','card','qr'] as const)[Math.floor(r()*4)];
        st.sales.push({ id, store_id: S, booking_id: b.id, customer_id: cust.id, main_staff_id: staff.id, sale_no: `${day.replace(/-/g,'')}-${String(seq).padStart(3,'0')}`, sold_at: endIso, status: 'confirmed', subtotal: m.price, discount: 0, tax: Math.floor(m.price - m.price/1.1), total: m.price, closed_on: day,
          lines: [{ id: uid(), sale_id: id, kind: 'menu', menu_id: m.id, name: m.name, unit_price: m.price, qty: 1, tax_rate: 0.1, staff_id: staff.id, amount: m.price }],
          payments: [{ id: uid(), sale_id: id, method: pm, amount: m.price }] });
      }
    }
  }
  // 先月分のシフト（「先月をコピー」の練習用）。今月は未入力にしておく
  const pts = st.shiftPatterns; const pt = (name: string) => pts.find(p => p.name === name)!;
  const pm0 = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  for (let d = new Date(pm0); d.getMonth() === pm0.getMonth(); d.setDate(d.getDate() + 1)) {
    st.staff.forEach((s, i) => {
      const w = d.getDay();
      const p = w === closedDow ? pt('店休') : i === 0 ? (w === 0 ? pt('休') : pt('通し')) : (w === 3 || w === 6 ? pt('休') : (w % 2 ? pt('早番') : pt('遅番')));
      st.shifts.push({ id: uid(), store_id: S, staff_id: s.id, date: ymd(d), kind: p.kind, pattern_id: p.id, start_time: p.start_time, end_time: p.end_time, is_store_closed: p.kind === 'closed', break_missed: false });
    });
  }
}
function extraCustomers(company: string, prefix: string, n: number): Customer[] {
  const fam = ['佐藤','鈴木','高橋','田中','伊藤','渡辺','山本','中村','小林','加藤','吉田','山田','松本','井上','木村'];
  const giv = ['葵','結衣','陽菜','美月','莉子','楓','七海','真央','彩花','優奈','明日香','沙織','千尋','舞','遥'];
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-x${i+1}`, company_id: company, name: `${fam[i % fam.length]} ${giv[(i*7) % giv.length]}`, source: i % 3 ? 'hpb' : 'own', created_at: nowIso() }));
}

const at = (day: string, h: number, m = 0) => new Date(`${day}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`).toISOString();
const mkMenu = (store: string, id: string, name: string, short: string, color: string, price: number, dur: number, cat: 'technical'|'option' = 'technical', iv = 10): Menu =>
  ({ id, store_id: store, name, short_name: short, color, category: cat, price, tax_rate: 0.1, duration_min: dur, interval_min: iv, sort_order: 0, active: true });

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
    store: { id: S, company_id: C, name: 'ラシエル箱崎', business_type: 'eyelash', open_time: '10:00', close_time: '19:00', slot_minutes: 15, hpb_salon_id: 'H000805291' },
    staff, resources, lanes, menus, products, customers, bookings, sales: [], closings: [], moves: [], kartes: [],
    shiftPatterns: [], shifts: [], shiftMonths: [],
  };
}
function seedHakozakiFull(): State { const st = seedHakozaki(); st.customers.push(...extraCustomers(st.store.company_id, 'h', 18)); st.shiftPatterns = defaultPatterns(st.store); demoHistory(st, 7, 2, true); return st; }

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
    store: { id: S, company_id: C, name: 'KOKAGE西五反田', business_type: 'headspa', open_time: '10:00', close_time: '19:00', slot_minutes: 15, hpb_salon_id: 'H000719142' },
    staff, resources, lanes, menus, products, customers, bookings, sales: [], closings: [], moves: [], kartes: [],
    shiftPatterns: [], shifts: [], shiftMonths: [],
  };
}
function seedGotandaFull(): State { const st = seedGotanda(); st.customers.push(...extraCustomers(st.store.company_id, 'g', 22)); st.shiftPatterns = defaultPatterns(st.store); demoHistory(st, 11, 2, true); return st; }

const SEEDS: Record<string, () => State> = { [STORE_HAKOZAKI]: seedHakozakiFull, [STORE_GOTANDA]: seedGotandaFull };
const CUR_KEY = 'salon-app-demo-store';
// v3：シフト・過去2か月分の会計を追加（v2の端末データは使わず作り直す）
const KEY = (id: string) => `salon-app-demo-v3-${id}`;

function currentStoreId(): string {
  if (typeof window === 'undefined') return STORE_GOTANDA;
  try { return localStorage.getItem(CUR_KEY) || STORE_GOTANDA; } catch { return STORE_GOTANDA; }
}
function load(): State {
  const id = currentStoreId();
  if (typeof window === 'undefined') return SEEDS[id]();
  try { const s = localStorage.getItem(KEY(id)); if (s) { const st = JSON.parse(s) as State; st.shiftPatterns ??= defaultPatterns(st.store); st.shifts ??= []; st.shiftMonths ??= []; return st; } } catch {}
  const st = SEEDS[id](); save(st); return st;
}
function save(s: State) { try { localStorage.setItem(KEY(s.store.id), JSON.stringify(s)); } catch {} }

export function resetDemo() { try { for (const id of Object.keys(SEEDS)) localStorage.removeItem(KEY(id)); } catch {} }

export const memoryRepo: Repo = {
  mode: 'memory',
  async store() { return load().store; },
  async stores() { return [seedHakozaki().store, seedGotanda().store]; },
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
    const sale: Sale = { id, store_id: s.store.id, booking_id: input.booking_id, customer_id: input.customer_id, main_staff_id: input.main_staff_id, sale_no: `${today.replace(/-/g,'')}-${String(seq).padStart(3,'0')}`, sold_at: nowIso(), status: 'confirmed', subtotal, discount: input.discount, tax, total, discount_reason: input.discount_reason, note: input.note, lines, payments };
    s.sales.push(sale);
    for (const l of lines) if (l.kind === 'product' && l.product_id) {
      const p = s.products.find(p => p.id === l.product_id); if (p) { p.stock -= l.qty; s.moves.push({ id: uid(), product_id: p.id, store_id: s.store.id, qty: -l.qty, reason: 'sale', moved_at: nowIso() }); }
    }
    if (input.booking_id) { const b = s.bookings.find(b => b.id === input.booking_id); if (b) b.status = 'done'; }
    save(s); return sale;
  },
  async reverseSale(id, reason) {
    const s = load(); const orig = s.sales.find(x => x.id === id)!;
    if (orig.closed_on) throw new Error('締め済みの伝票は赤伝にできません（管理者権限が必要）');
    orig.status = 'voided';
    const rid = uid();
    const rev: Sale = { ...orig, id: rid, sale_no: orig.sale_no + '-R', sold_at: nowIso(), status: 'reversal', reverses_sale_id: orig.id, subtotal: -orig.subtotal, discount: -orig.discount, tax: -orig.tax, total: -orig.total, note: `赤伝：${reason}`,
      lines: orig.lines.map(l => ({ ...l, id: uid(), sale_id: rid, qty: -l.qty, amount: -l.amount })), payments: orig.payments.map(p => ({ ...p, id: uid(), sale_id: rid, amount: -p.amount })) };
    s.sales.push(rev);
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
  async markShiftMonth(ym) { const s = load(); const n: ShiftMonth = { store_id: s.store.id, ym, confirmed_at: nowIso() }; s.shiftMonths = [...s.shiftMonths.filter(x => x.ym !== ym), n]; save(s); return n; },
};
