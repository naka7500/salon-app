// 本番用：Supabase。NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / NEXT_PUBLIC_STORE_ID を .env.local に置く。
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { HpbSettings, HpbMapping, InboundMail, HpbActionResult, Repo, Sale, SaleLine, Payment, Booking, InventoryMove, RegisterClosing, Product, Lane, Store, ShiftPattern, Shift, ShiftMonth, ID, Capabilities, Customer, Menu, Staff, StoreGoal, Coupon, AppNotification, AuditLog, OptionGroup, KartePage, KarteBackground } from './types';
import type { PublicApi } from '../web';
import { onLedger, byStaffOrder } from './types';

let client: SupabaseClient | null = null;
export function sb() {
  if (!client) client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  return client;
}
// 現在の店舗。ログイン後に initStore() で「見られる店舗」の中から決める（RLSで見えない店舗は選べない）
const CUR_KEY = 'salon-app.current-store';
let STORE_ID = process.env.NEXT_PUBLIC_STORE_ID ?? '';
let COMPANY_ID = '';
export async function initStore(): Promise<number> {
  const list = must(await sb().from('stores').select('id, company_id, name').order('name')) as { id: string; company_id: string; name: string }[];
  let pick = ''; try { pick = localStorage.getItem(CUR_KEY) ?? ''; } catch {}
  const found = list.find(x => x.id === pick) ?? list.find(x => x.id === process.env.NEXT_PUBLIC_STORE_ID) ?? list[0];
  if (found) { STORE_ID = found.id; COMPANY_ID = found.company_id; }
  return list.length;
}
const dayRange = (date: string) => { const s = new Date(`${date}T00:00:00`); const e = new Date(s); e.setDate(e.getDate() + 1); return [s.toISOString(), e.toISOString()]; };
const periodRange = (from: string, to: string) => [new Date(`${from}T00:00:00`).toISOString(), new Date(`${to}T00:00:00`).toISOString()];
const hm5 = (t: string|null|undefined) => (t ? t.slice(0, 5) : t ?? null);   // DBの time は 'HH:MM:SS' で返る
const normShift = (r: Shift): Shift => ({ ...r, start_time: hm5(r.start_time), end_time: hm5(r.end_time), ...('break_start' in r ? { break_start: hm5(r.break_start), break_end: hm5(r.break_end) } : {}) });
type StoreRow = Store & { companies?: { name: string } | null };
const normStore = (r: StoreRow): Store => { const { companies, ...rest } = r; return { ...rest, company_name: companies?.name ?? null, ...(rest.cancel_deadline_time ? { cancel_deadline_time: hm5(rest.cancel_deadline_time)! } : {}) }; };
const normMenu = (m: Menu): Menu => ({ ...m, time_from: hm5(m.time_from), time_to: hm5(m.time_to) });
const normCoupon = (c: Coupon): Coupon => ({ ...c, time_from: hm5(c.time_from), time_to: hm5(c.time_to), menu_ids: c.menu_ids ?? [] });
/** 0007 が無いDBに送ってはいけない列（メニュー） */
const MENU_C_COLS = ['name_en', 'description', 'description_en', 'image_url', 'target', 'publish_from', 'publish_to', 'weekdays', 'time_from', 'time_to', 'lane_id', 'nominatable', 'web_visible'] as const;
/** 0009 が無いDBに送ってはいけない列（メニュー・クーポン・店舗） */
const MENU_V11_COLS = ['people', 'option_group_id', 'option_group_ids'] as const;
const STORE_V11_COLS = ['room_count', 'start_step_min'] as const;
// 0006 が入っているか（列・表があるか）を1回だけ調べる
let CAPS: Promise<Capabilities> | null = null;
async function probe(table: string, cols: string) { const r = await sb().from(table).select(cols).limit(1); return !r.error; }
function caps() {
  if (!CAPS) CAPS = (async () => { const [goals, shiftBreaks, lastOrder, phaseC, staffSettings, v11, karte10, hpb11] = await Promise.all([probe('store_goals', 'store_id'), probe('shifts', 'break_start'), probe('stores', 'last_order_offset_min'), probe('coupons', 'id'), probe('staff', 'show_on_ledger'), probe('option_groups', 'id'), probe('karte_pages', 'id'), probe('hpb_mappings', 'id')]); return { goals, shiftBreaks, lastOrder, phaseC, staffSettings, v11, karte10, hpb11 }; })();
  return CAPS as Promise<Capabilities>;
}
const SALE_SELECT = '*, lines:sale_lines(*), payments(*)';
const fixSale = (r: Sale): Sale => ({ ...r, lines: r.lines ?? [], payments: r.payments ?? [] });
const normPattern = (r: ShiftPattern): ShiftPattern => ({ ...r, start_time: hm5(r.start_time), end_time: hm5(r.end_time) });
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
/** Supabase は1回1000行までなので、範囲指定で全部取る */
async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += 1000) { const r = must(await q(i, i + 999)); out.push(...r); if (r.length < 1000) break; }
  return out;
}
function must<T>(r: { data: T | null; error: { message: string } | null }): T { if (r.error) throw new Error(r.error.message); return r.data as T; }

async function loadSale(id: string): Promise<Sale> {
  const s = must(await sb().from('sales').select('*').eq('id', id).single()) as Sale;
  s.lines = must(await sb().from('sale_lines').select('*').eq('sale_id', id)) as SaleLine[];
  s.payments = must(await sb().from('payments').select('*').eq('sale_id', id)) as Payment[];
  return s;
}
async function loadSales(rows: Sale[]): Promise<Sale[]> {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const lines = must(await sb().from('sale_lines').select('*').in('sale_id', ids)) as SaleLine[];
  const pays = must(await sb().from('payments').select('*').in('sale_id', ids)) as Payment[];
  return rows.map(r => ({ ...r, lines: lines.filter(l => l.sale_id === r.id), payments: pays.filter(p => p.sale_id === r.id) }));
}

// ---- カルテの画像（0010：Supabase Storage の非公開バケット karte。パスは <会社ID>/... ）----
const KARTE_BUCKET = 'karte';
const isUrl = (p: string) => p.startsWith('data:') || /^https?:/.test(p);
const SIGNED = new Map<string, { url: string; exp: number }>();
async function upload(path: string, blob: Blob) {
  const r = await sb().storage.from(KARTE_BUCKET).upload(path, blob, { contentType: blob.type || 'image/png', upsert: true, cacheControl: '3600' });
  if (r.error) throw new Error(/row-level security|Unauthorized|403/i.test(r.error.message) ? '画像を保存する権限がありません（DB更新 0010 が流れているか、ログイン中の会社を確認してください）' : `画像を保存できませんでした：${r.error.message}`);
}
async function removeFiles(paths: string[]) { const ps = paths.filter(p => p && !isUrl(p)); if (ps.length) await sb().storage.from(KARTE_BUCKET).remove(ps).catch(() => {}); ps.forEach(p => SIGNED.delete(p)); }
const extOf = (b: Blob) => (b.type === 'image/jpeg' ? 'jpg' : b.type === 'image/webp' ? 'webp' : 'png');
const rlsMsg = (m: string, what: string) => (/row-level security|permission denied/i.test(m) ? `${what}はオーナー・店長だけができます` : m);

export const supabaseRepo: Repo = {
  mode: 'supabase',
  async store() { return normStore(must(await sb().from('stores').select('*').eq('id', STORE_ID).single()) as StoreRow); },
  async stores() { return (must(await sb().from('stores').select('*, companies(name)').order('name')) as StoreRow[]).map(normStore); },
  switchStore(id) { try { localStorage.setItem(CUR_KEY, id); } catch {} },
  async lanes() { return must(await sb().from('lanes').select('*').eq('store_id', STORE_ID).eq('active', true).order('sort_order')) as Lane[]; },
  // 予約台帳・シフト・会計に出す人：この店舗（所属＋ヘルプ）・在籍・台帳に表示。表示順（0008 未適用なら名前順）
  async staff() { const ss = must(await sb().from('staff_stores').select('staff_id').eq('store_id', STORE_ID)) as { staff_id: string }[]; return (must(await sb().from('staff').select('*').in('id', ss.map(x => x.staff_id)).eq('active', true)) as Staff[]).filter(onLedger).sort(byStaffOrder); },
  async resources() { return must(await sb().from('resources').select('*').eq('store_id', STORE_ID).eq('active', true).order('sort_order')); },
  async menus() { return (must(await sb().from('menus').select('*').eq('store_id', STORE_ID).eq('active', true).order('sort_order')) as Menu[]).map(normMenu); },
  async products() { return must(await sb().from('products').select('*').eq('store_id', STORE_ID).eq('active', true).order('name')); },
  async customers(q) { let r = sb().from('customers').select('*').eq('company_id', COMPANY_ID).is('merged_into', null).order('created_at', { ascending: false }).limit(200); if (q) r = r.or(`name.ilike.%${q}%,kana.ilike.%${q}%,phone.ilike.%${q}%`); return must(await r); },
  async customer(id) { return must(await sb().from('customers').select('*').eq('id', id).maybeSingle()) ?? undefined; },
  async upsertCustomer(c) {
    if (!c.company_id) c.company_id = COMPANY_ID;
    return must(await sb().from('customers').upsert(c).select().single());
  },
  async bookingsOn(date) { const [s, e] = dayRange(date); return must(await sb().from('bookings').select('*').eq('store_id', STORE_ID).gte('start_at', s).lt('start_at', e).order('start_at')); },
  async bookingsOfCustomer(id) { return must(await sb().from('bookings').select('*').eq('customer_id', id).order('start_at', { ascending: false })); },
  async bookingsBetween(from, to) { const [s, e] = periodRange(from, to); return all<Booking>((a, b) => sb().from('bookings').select('*').eq('store_id', STORE_ID).gte('start_at', s).lt('start_at', e).order('start_at').range(a, b)); },
  async createBookings(list) { for (const c of chunk(list, 500)) must(await sb().from('bookings').insert(c.map(b => ({ ...b, store_id: STORE_ID })))); return list.length; },
  async deleteBookings(ids) { for (const c of chunk(ids, 200)) must(await sb().from('bookings').delete().in('id', c)); },
  async booking(id) { return must(await sb().from('bookings').select('*').eq('id', id).maybeSingle()) ?? undefined; },
  async createBooking(b) { return must(await sb().from('bookings').insert({ ...b, store_id: STORE_ID }).select().single()) as Booking; },
  async updateBooking(id, patch) { return must(await sb().from('bookings').update(patch).eq('id', id).select().single()) as Booking; },
  async deleteBooking(id) { must(await sb().from('bookings').delete().eq('id', id)); },
  async salesOn(date) { const [s, e] = dayRange(date); return (must(await sb().from('sales').select(SALE_SELECT).eq('store_id', STORE_ID).gte('sold_at', s).lt('sold_at', e).order('sold_at')) as Sale[]).map(fixSale); },
  async salesOfCustomer(id) { return loadSales(must(await sb().from('sales').select('*').eq('customer_id', id).order('sold_at', { ascending: false }))); },
  async salesBetween(from, to) { const [s, e] = periodRange(from, to); return (await all<Sale>((a, b) => sb().from('sales').select(SALE_SELECT).eq('store_id', STORE_ID).gte('sold_at', s).lt('sold_at', e).order('sold_at').range(a, b))).map(fixSale); },
  async firstVisits(ids) { return firstVisitsFor(STORE_ID, ids); },
  async createSale(input) {
    const subtotal = input.lines.reduce((a, l) => a + l.unit_price * l.qty, 0);
    const total = subtotal - input.discount; const tax = Math.floor(total - total / 1.1);
    const sale_no = must(await sb().rpc('next_sale_no', { p_store: STORE_ID })) as string;
    const extra = input.coupon_id && (await caps()).phaseC ? { coupon_id: input.coupon_id } : {};
    const sale = must(await sb().from('sales').insert({ store_id: STORE_ID, booking_id: input.booking_id, customer_id: input.customer_id, main_staff_id: input.main_staff_id, sale_no, subtotal, discount: input.discount, tax, total, discount_reason: input.discount_reason, note: input.note, ...extra }).select().single()) as Sale;
    must(await sb().from('sale_lines').insert(input.lines.map(l => ({ ...l, sale_id: sale.id, amount: l.unit_price * l.qty }))));
    must(await sb().from('payments').insert(input.payments.map(p => ({ ...p, sale_id: sale.id }))));
    if (input.booking_id) await sb().from('bookings').update({ status: 'done' }).eq('id', input.booking_id);
    return loadSale(sale.id);
  },
  async reverseSale(id, reason) {
    if ((await caps()).phaseC) {
      // 0007：サーバ側で権限チェック（締め後は owner・manager だけ）＋修正履歴（audit_logs）に記録
      const r = await sb().rpc('reverse_sale', { p_sale: id, p_reason: reason });
      if (r.error) throw new Error(REVERSE_ERR[Object.keys(REVERSE_ERR).find(k => r.error!.message.includes(k)) || ''] || r.error.message);
      return loadSale(r.data as string);
    }
    const orig = await loadSale(id);
    if (orig.closed_on) throw new Error('締め済みの伝票は赤伝にできません');
    must(await sb().from('sales').update({ status: 'voided' }).eq('id', id));
    const rev = must(await sb().from('sales').insert({ store_id: STORE_ID, booking_id: orig.booking_id, customer_id: orig.customer_id, main_staff_id: orig.main_staff_id, sale_no: orig.sale_no + '-R', status: 'reversal', reverses_sale_id: id, subtotal: -orig.subtotal, discount: -orig.discount, tax: -orig.tax, total: -orig.total, note: `赤伝：${reason}` }).select().single()) as Sale;
    must(await sb().from('sale_lines').insert(orig.lines.map(l => ({ sale_id: rev.id, kind: l.kind, menu_id: l.menu_id, product_id: l.product_id, name: l.name, unit_price: l.unit_price, qty: -l.qty, tax_rate: l.tax_rate, staff_id: l.staff_id, amount: -l.amount }))));
    must(await sb().from('payments').insert(orig.payments.map(p => ({ sale_id: rev.id, method: p.method, amount: -p.amount }))));
    return loadSale(rev.id);
  },
  async closing(date) { return must(await sb().from('register_closings').select('*').eq('store_id', STORE_ID).eq('date', date).maybeSingle()) ?? undefined; },
  async saveClosing(c) {
    const r = must(await sb().from('register_closings').upsert({ ...c, store_id: STORE_ID }, { onConflict: 'store_id,date' }).select().single()) as RegisterClosing;
    if (c.closed_at) { const [s, e] = dayRange(c.date); await sb().from('sales').update({ closed_on: c.date }).eq('store_id', STORE_ID).gte('sold_at', s).lt('sold_at', e).is('closed_on', null); }
    return r;
  },
  async adjustStock(product_id, qty, reason) {
    must(await sb().from('inventory_moves').insert({ product_id, store_id: STORE_ID, qty, reason }));
    const p = must<Product>(await sb().from('products').select('*').eq('id', product_id).single());
    return must(await sb().from('products').update({ stock: p.stock + qty }).eq('id', product_id).select().single());
  },
  async inventoryMoves(product_id) { return must(await sb().from('inventory_moves').select('*').eq('product_id', product_id).order('moved_at', { ascending: false })) as InventoryMove[]; },
  async kartes(customer_id) { return must(await sb().from('karte_entries').select('*').eq('customer_id', customer_id).order('visited_on', { ascending: false })); },
  async addKarte(k) { return must(await sb().from('karte_entries').insert({ ...k, store_id: STORE_ID, photos: k.photos ?? [], health: k.health ?? null }).select().single()); },
  // ---- シフト（0005_shifts.sql） ----
  async shiftPatterns() { return (must(await sb().from('shift_patterns').select('*').eq('store_id', STORE_ID).eq('active', true).order('sort_order')) as ShiftPattern[]).map(normPattern); },
  async saveShiftPattern(p) { return normPattern(must(await sb().from('shift_patterns').upsert({ ...p, store_id: STORE_ID }).select().single()) as ShiftPattern); },
  async deleteShiftPattern(id) { must(await sb().from('shift_patterns').update({ active: false }).eq('id', id)); },
  async shiftsBetween(from, to) { return (await all<Shift>((a, b) => sb().from('shifts').select('*').eq('store_id', STORE_ID).gte('date', from).lt('date', to).not('staff_id', 'is', null).order('date').range(a, b))).map(normShift); },
  async saveShifts(rows) {
    const { shiftBreaks } = await caps();
    const clean = rows.map(r => { const { break_start, break_end, ...rest } = r; return shiftBreaks ? { ...rest, break_start: rest.kind === 'work' ? break_start ?? null : null, break_end: rest.kind === 'work' ? break_end ?? null : null, store_id: STORE_ID } : { ...rest, store_id: STORE_ID }; });
    for (const c of chunk(clean, 500)) must(await sb().from('shifts').upsert(c, { onConflict: 'store_id,staff_id,date' }));
  },
  async deleteShifts(keys) {
    const byDate: Record<string, ID[]> = {};
    keys.forEach(k => (byDate[k.date] ??= []).push(k.staff_id));
    for (const [d, ids] of Object.entries(byDate)) must(await sb().from('shifts').delete().eq('store_id', STORE_ID).eq('date', d).in('staff_id', ids));
  },
  async shiftMonth(ym) { return must(await sb().from('shift_months').select('*').eq('store_id', STORE_ID).eq('ym', ym).maybeSingle()) as ShiftMonth ?? undefined; },
  // ---- フェーズB ----
  capabilities: caps,
  async updateStoreSettings(patch) {
    const c = await caps();
    const keys = Object.keys(patch);
    if (keys.includes('last_order_offset_min') && !c.lastOrder) throw new Error('この設定はDB更新（0006）の後に使えます');
    if (keys.some(k => (STORE_V11_COLS as readonly string[]).includes(k)) && !c.v11) throw new Error('部屋数・開始時刻の刻みはDB更新（0009）の後に使えます');
    if (keys.some(k => k !== 'last_order_offset_min' && !(STORE_V11_COLS as readonly string[]).includes(k)) && !c.phaseC) throw new Error('この設定はDB更新（0007）の後に使えます');
    return normStore(must(await sb().from('stores').update(patch).eq('id', STORE_ID).select().single()) as StoreRow);
  },
  async reportBundle(storeIds, from, salesTo, bookingsTo) {
    const [s, se] = periodRange(from, salesTo); const [, be] = periodRange(from, bookingsTo);
    const stores = (must(await sb().from('stores').select('*, companies(name)').in('id', storeIds)) as StoreRow[]).map(normStore);
    const companyIds = [...new Set(stores.map(x => x.company_id))];
    const [sales, bookings, shifts, menus, staff] = await Promise.all([
      all<Sale>((a, b) => sb().from('sales').select(SALE_SELECT).in('store_id', storeIds).gte('sold_at', s).lt('sold_at', se).order('sold_at').range(a, b)),
      all<Booking>((a, b) => sb().from('bookings').select('*').in('store_id', storeIds).gte('start_at', s).lt('start_at', be).order('start_at').range(a, b)),
      all<Shift>((a, b) => sb().from('shifts').select('*').in('store_id', storeIds).gte('date', from).lt('date', bookingsTo).not('staff_id', 'is', null).order('date').range(a, b)),
      all<Menu>((a, b) => sb().from('menus').select('*').in('store_id', storeIds).range(a, b)),
      all<Staff>((a, b) => sb().from('staff').select('*').in('company_id', companyIds).range(a, b)),
    ]);
    const fixed = sales.map(fixSale);
    const custIds = [...new Set(fixed.map(x => x.customer_id).filter(Boolean) as ID[])];
    const firstVisits: Record<ID, Record<ID, string>> = {};
    for (const st of stores) { const ids = [...new Set(fixed.filter(x => x.store_id === st.id && x.customer_id).map(x => x.customer_id!))]; firstVisits[st.id] = ids.length ? await firstVisitsFor(st.id, ids) : {}; }
    const customers = await supabaseRepo.customersByIds(custIds);
    return { stores, sales: fixed, bookings, shifts: shifts.map(normShift), menus, staff, customers, firstVisits };
  },
  async customersByIds(ids) {
    const out: Customer[] = [];
    for (const c of chunk([...new Set(ids)], 100)) out.push(...(must(await sb().from('customers').select('*').in('id', c)) as Customer[]));
    return out;
  },
  async goals(storeIds, fromYm, toYm) {
    if (!(await caps()).goals) return null;
    return must(await sb().from('store_goals').select('store_id, ym, target_sales').in('store_id', storeIds).gte('ym', fromYm).lte('ym', toYm)) as StoreGoal[];
  },
  async saveGoal(store_id, ym, target_sales) {
    if (!(await caps()).goals) throw new Error('目標の入力はDB更新（0006）の後に使えます');
    if (target_sales === null) must(await sb().from('store_goals').delete().eq('store_id', store_id).eq('ym', ym));
    else must(await sb().from('store_goals').upsert({ store_id, ym, target_sales, updated_at: new Date().toISOString() }, { onConflict: 'store_id,ym' }));
  },
  async markShiftMonth(ym) { return must(await sb().from('shift_months').upsert({ store_id: STORE_ID, ym, confirmed_at: new Date().toISOString() }, { onConflict: 'store_id,ym' }).select().single()) as ShiftMonth; },
  // ---- フェーズC（0007） ----
  async me() {
    const { data } = await sb().auth.getUser(); const uid = data.user?.id; if (!uid) return null;
    const rows = must(await sb().from('staff').select('*').eq('auth_user_id', uid).eq('company_id', COMPANY_ID)) as Staff[];
    const rank = { owner: 0, manager: 1, staff: 2, viewer: 3 } as const;
    return rows.sort((a, b) => rank[a.role] - rank[b.role])[0] ?? null;
  },
  async allMenus() { return (must(await sb().from('menus').select('*').eq('store_id', STORE_ID).order('sort_order')) as Menu[]).map(normMenu); },
  async saveMenu(m) {
    const row: Record<string, unknown> = { ...m, store_id: STORE_ID };
    const cc = await caps();
    if (!cc.phaseC) for (const k of MENU_C_COLS) delete row[k];
    if (!cc.v11) for (const k of MENU_V11_COLS) delete row[k];
    if (!m.id) { const mx = must(await sb().from('menus').select('sort_order').eq('store_id', STORE_ID).order('sort_order', { ascending: false }).limit(1)) as { sort_order: number }[]; row.sort_order = (mx[0]?.sort_order ?? 0) + 1; }
    return normMenu(must(await sb().from('menus').upsert(row).select().single()) as Menu);
  },
  async reorderMenus(ids) { await Promise.all(ids.map((id, i) => sb().from('menus').update({ sort_order: i + 1 }).eq('id', id).then(must))); },
  async coupons() {
    if (!(await caps()).phaseC) return null;
    return (must(await sb().from('coupons').select('*').eq('store_id', STORE_ID).order('sort_order')) as Coupon[]).map(normCoupon);
  },
  async saveCoupon(c) {
    if (!(await caps()).phaseC) throw new Error('クーポンはDB更新（0007）の後に使えます');
    const row: Record<string, unknown> = { ...c, store_id: STORE_ID };
    if (!(await caps()).v11) delete row.option_group_ids;
    if (!c.id) { const mx = must(await sb().from('coupons').select('sort_order').eq('store_id', STORE_ID).order('sort_order', { ascending: false }).limit(1)) as { sort_order: number }[]; row.sort_order = (mx[0]?.sort_order ?? 0) + 1; }
    return normCoupon(must(await sb().from('coupons').upsert(row).select().single()) as Coupon);
  },
  async reorderCoupons(ids) { await Promise.all(ids.map((id, i) => sb().from('coupons').update({ sort_order: i + 1 }).eq('id', id).then(must))); },
  async couponUsage() {
    if (!(await caps()).phaseC) return {};
    const out: Record<ID, number> = {};
    const bs = await all<{ id: ID; coupon_id: ID }>((a, b) => sb().from('bookings').select('id, coupon_id').eq('store_id', STORE_ID).not('coupon_id', 'is', null).not('customer_id', 'is', null).in('status', ['booked', 'arrived', 'done']).range(a, b));
    bs.forEach(x => (out[x.coupon_id] = (out[x.coupon_id] || 0) + 1));
    const withB = new Set(bs.map(x => x.id));
    const ss = await all<{ coupon_id: ID; booking_id: ID | null }>((a, b) => sb().from('sales').select('coupon_id, booking_id').eq('store_id', STORE_ID).eq('status', 'confirmed').not('coupon_id', 'is', null).range(a, b));
    ss.filter(x => !x.booking_id || !withB.has(x.booking_id)).forEach(x => (out[x.coupon_id] = (out[x.coupon_id] || 0) + 1));
    return out;
  },
  async notifications(onlyUnread) {
    if (!(await caps()).phaseC) return null;
    let q = sb().from('notifications').select('*').eq('store_id', STORE_ID).in('kind', ['new_booking', 'cancel_booking', 'hpb_booking', 'hpb_change', 'hpb_cancel', 'hpb_attention']).order('created_at', { ascending: false }).limit(100);
    if (onlyUnread) q = q.is('read_at', null);
    return must(await q) as AppNotification[];
  },
  async markNotificationsRead(ids) { for (const c of chunk(ids, 200)) must(await sb().from('notifications').update({ read_at: new Date().toISOString() }).in('id', c).is('read_at', null)); },
  async auditLogs(from, to) {
    if (!(await caps()).phaseC) return null;
    const [s, e] = periodRange(from, to);
    return must(await sb().from('audit_logs').select('*').eq('store_id', STORE_ID).gte('at', s).lt('at', e).order('at', { ascending: false }).limit(500)) as AuditLog[];
  },
  // ---- 設定＞スタッフ（0008。未適用でも名前・役割・指名料・在籍・店舗は保存できる） ----
  async allStaff() {
    const rows = must(await sb().from('staff').select('*').eq('company_id', COMPANY_ID)) as Staff[];
    const links = rows.length ? must(await sb().from('staff_stores').select('staff_id, store_id').in('staff_id', rows.map(r => r.id))) as { staff_id: ID; store_id: ID }[] : [];
    return rows.map(r => ({ ...r, store_ids: links.filter(l => l.staff_id === r.id).map(l => l.store_id) })).sort(byStaffOrder);
  },
  async saveStaff(input) {
    const c = await caps();
    const { store_ids, id, ...rest } = input;
    const row: Record<string, unknown> = { ...rest, name: input.name.trim() };
    delete row.email; delete row.auth_user_id; delete row.company_id;
    if (!c.staffSettings) for (const k of STAFF_8_COLS) delete row[k];
    // 店舗は同じ会社の店舗だけ
    const myStores = (must(await sb().from('stores').select('id').eq('company_id', COMPANY_ID)) as { id: ID }[]).map(x => x.id);
    const want = [...new Set(store_ids)].filter(x => myStores.includes(x));
    if (c.staffSettings && row.home_store_id && !want.includes(row.home_store_id as ID)) row.home_store_id = want[0] ?? null;
    let saved: Staff;
    if (id) {
      const r = await sb().from('staff').update(row).eq('id', id).select().single();
      if (r.error) throw staffErr(r.error); saved = r.data as Staff;
    } else {
      if (c.staffSettings) { const mx = must(await sb().from('staff').select('sort_order').eq('company_id', COMPANY_ID).order('sort_order', { ascending: false }).limit(1)) as { sort_order: number }[]; row.sort_order = (mx[0]?.sort_order ?? 0) + 1; }
      const r = await sb().from('staff').insert({ ...row, company_id: COMPANY_ID }).select().single();
      if (r.error) throw staffErr(r.error); saved = r.data as Staff;
    }
    // 所属・ヘルプ店舗（staff_stores）を合わせる
    const cur = (must(await sb().from('staff_stores').select('store_id').eq('staff_id', saved.id)) as { store_id: ID }[]).map(x => x.store_id).filter(x => myStores.includes(x));
    const add = want.filter(x => !cur.includes(x)), del = cur.filter(x => !want.includes(x));
    if (add.length) { const r = await sb().from('staff_stores').insert(add.map(store_id => ({ staff_id: saved.id, store_id }))); if (r.error) throw staffErr(r.error); }
    if (del.length) { const r = await sb().from('staff_stores').delete().eq('staff_id', saved.id).in('store_id', del); if (r.error) throw staffErr(r.error); }
    return { ...saved, store_ids: want };
  },
  async reorderStaff(ids) {
    if (!(await caps()).staffSettings) throw new Error('表示順はDB更新（0008）の後に使えます');
    await Promise.all(ids.map((id, i) => sb().from('staff').update({ sort_order: i + 1 }).eq('id', id).then(r => { if (r.error) throw staffErr(r.error); })));
  },
  async deleteStaff(id) {
    // 履歴がある人は外部キーで止まる（＝退職にする）。staff_stores は一緒に消える
    const r = await sb().from('staff').delete().eq('id', id).select('id');
    if (r.error) throw staffErr(r.error);
    if (!r.data?.length) throw new Error('削除できませんでした（権限がないか、すでに削除されています）');
  },
  // ---- v1.1（0009）：オプショングループ ----
  async optionGroups() {
    if (!(await caps()).v11) return null;
    return must(await sb().from('option_groups').select('*').eq('store_id', STORE_ID).order('sort_order')) as OptionGroup[];
  },
  async saveOptionGroup(g) {
    if (!(await caps()).v11) throw new Error('オプショングループはDB更新（0009）の後に使えます');
    const row: Record<string, unknown> = { ...g, name: g.name.trim(), store_id: STORE_ID };
    if (!g.id) { const mx = must(await sb().from('option_groups').select('sort_order').eq('store_id', STORE_ID).order('sort_order', { ascending: false }).limit(1)) as { sort_order: number }[]; row.sort_order = (mx[0]?.sort_order ?? 0) + 1; }
    const r = await sb().from('option_groups').upsert(row).select().single();
    if (r.error) throw new Error(/row-level security/.test(r.error.message) ? 'この操作の権限がありません（オーナー・店長だけ）' : r.error.message);
    return r.data as OptionGroup;
  },
  async deleteOptionGroup(id) {
    // 中のオプションはグループなし（menus.option_group_id は on delete set null）。メニュー・クーポンのひも付けも外す
    for (const t of ['menus', 'coupons'] as const) {
      const rows = must(await sb().from(t).select('id, option_group_ids').eq('store_id', STORE_ID).contains('option_group_ids', [id])) as { id: ID; option_group_ids: ID[] }[];
      for (const x of rows) must(await sb().from(t).update({ option_group_ids: x.option_group_ids.filter(y => y !== id) }).eq('id', x.id));
    }
    must(await sb().from('option_groups').delete().eq('id', id));
  },
  // ---- カルテの手書き（0010） ----
  async kartePages(ids) {
    if (!(await caps()).karte10) return null;
    const out: KartePage[] = [];
    for (const c of chunk([...new Set(ids)], 100)) if (c.length) out.push(...(must(await sb().from('karte_pages').select('*').in('karte_entry_id', c).order('page_no')) as KartePage[]));
    return out;
  },
  async saveKartePages(entryId, drafts) {
    if (!(await caps()).karte10) throw new Error('手書きページの保存はDB更新（0010）の後に使えます');
    const old = must(await sb().from('karte_pages').select('*').eq('karte_entry_id', entryId)) as KartePage[];
    const base = `${COMPANY_ID}/karte/${entryId}`; const ts = Date.now(); const now = new Date().toISOString();
    const made: string[] = []; const drop: string[] = []; const rows: KartePage[] = [];
    try {
      for (const [i, d] of drafts.entries()) {
        const prev = old.find(p => p.id === d.id);
        let background_path: string|null = null;
        if (d.bg.kind === 'photo') {
          if (d.bg.blob) { background_path = `${base}/${d.id}-bg-${ts}.${extOf(d.bg.blob)}`; await upload(background_path, d.bg.blob); made.push(background_path); }
          else background_path = d.bg.path ?? null;
        }
        const png_path = `${base}/${d.id}-${ts}.${extOf(d.image)}`; await upload(png_path, d.image); made.push(png_path);
        if (prev?.png_path && prev.png_path !== png_path) drop.push(prev.png_path);
        if (prev?.background_path && prev.background_path !== background_path) drop.push(prev.background_path);
        rows.push({ id: d.id, karte_entry_id: entryId, page_no: i + 1, strokes: d.strokes, png_path, background_path,
          background_template_id: d.bg.kind === 'template' ? d.bg.id : null, background_builtin: d.bg.kind === 'builtin' ? d.bg.key : null,
          background_opacity: Math.round(Math.max(0.05, Math.min(1, d.opacity)) * 100) / 100, updated_at: now });
      }
      const gone = old.filter(p => !drafts.some(d => d.id === p.id));
      if (rows.length) must(await sb().from('karte_pages').upsert(rows));
      if (gone.length) must(await sb().from('karte_pages').delete().in('id', gone.map(p => p.id)));
      gone.forEach(p => { if (p.png_path) drop.push(p.png_path); if (p.background_path) drop.push(p.background_path); });
    } catch (e) { await removeFiles(made); throw e; }
    await removeFiles(drop);
    return rows;
  },
  async karteBackgrounds(all) {
    if (!(await caps()).karte10) return null;
    let q = sb().from('karte_backgrounds').select('*').eq('company_id', COMPANY_ID).order('sort_order').order('name');
    if (!all) q = q.or(`store_id.is.null,store_id.eq.${STORE_ID}`);
    return must(await q) as KarteBackground[];
  },
  async saveKarteBackground(b, image) {
    if (!(await caps()).karte10) throw new Error('カルテの背景はDB更新（0010）の後に使えます');
    const row: Record<string, unknown> = { ...b, name: b.name.trim(), company_id: COMPANY_ID };
    delete row.created_at;
    if (!row.id) {
      row.id = crypto.randomUUID();
      const mx = must(await sb().from('karte_backgrounds').select('sort_order').eq('company_id', COMPANY_ID).order('sort_order', { ascending: false }).limit(1)) as { sort_order: number }[];
      row.sort_order = (mx[0]?.sort_order ?? 0) + 1;
    }
    let prevPath: string|null = null; let made: string|null = null;
    if (image) {
      if (b.id) prevPath = ((must(await sb().from('karte_backgrounds').select('image_path').eq('id', b.id).maybeSingle()) as { image_path: string|null } | null)?.image_path) ?? null;
      made = `${COMPANY_ID}/templates/${row.id}-${Date.now()}.${extOf(image)}`; await upload(made, image); row.image_path = made;
    }
    const r = await sb().from('karte_backgrounds').upsert(row).select().single();
    if (r.error) { if (made) await removeFiles([made]); throw new Error(rlsMsg(r.error.message, 'カルテの背景の変更')); }
    if (prevPath && prevPath !== made) await removeFiles([prevPath]);
    return r.data as KarteBackground;
  },
  async karteFileUrls(paths) {
    const out: Record<string, string> = {}; const need: string[] = []; const t = Date.now();
    for (const p of [...new Set(paths)]) { if (!p) continue; if (isUrl(p)) { out[p] = p; continue; } const c = SIGNED.get(p); if (c && c.exp > t + 60_000) out[p] = c.url; else need.push(p); }
    for (const c of chunk(need, 100)) {
      const r = await sb().storage.from(KARTE_BUCKET).createSignedUrls(c, 3600);
      if (r.error) throw new Error(r.error.message);
      for (const x of r.data ?? []) if (x.signedUrl && x.path) { out[x.path] = x.signedUrl; SIGNED.set(x.path, { url: x.signedUrl, exp: t + 3600_000 }); }
    }
    return out;
  },
  async karteFileBlob(path) {
    if (isUrl(path)) return (await fetch(path)).blob();
    const r = await sb().storage.from(KARTE_BUCKET).download(path);
    if (r.error || !r.data) throw new Error('画像を読み込めませんでした');
    return r.data;
  },
  // ---- HPBの予約メール取り込み（0011） ----
  async hpbSettings() {
    if (!(await caps()).hpb11) return null;
    const r = await sb().from('hpb_settings').select('*').eq('store_id', STORE_ID).maybeSingle();
    if (r.error) throw new Error(rlsMsg(r.error.message, 'HPB連携の設定'));
    return (r.data as HpbSettings | null) ?? { store_id: STORE_ID, enabled: false, secret_hash: null, plus_address: null, default_menu_id: null, parser_config: {} };
  },
  async saveHpbSettings(patch) {
    if (!(await caps()).hpb11) throw new Error('HPB連携はDB更新（0011）の後に使えます');
    const r = await sb().from('hpb_settings').upsert({ ...patch, store_id: STORE_ID, updated_at: new Date().toISOString() }).select().single();
    if (r.error) throw new Error(rlsMsg(r.error.message, 'HPB連携の設定の変更'));
    return r.data as HpbSettings;
  },
  async hpbMappings() {
    if (!(await caps()).hpb11) return null;
    return must(await sb().from('hpb_mappings').select('*').eq('store_id', STORE_ID).order('kind').order('sort_order')) as HpbMapping[];
  },
  async saveHpbMapping(m) {
    if (!(await caps()).hpb11) throw new Error('HPB連携はDB更新（0011）の後に使えます');
    const row: Record<string, unknown> = { ...m, pattern: m.pattern.trim(), store_id: STORE_ID };
    delete row.created_at;
    if (!m.id) { const mx = must(await sb().from('hpb_mappings').select('sort_order').eq('store_id', STORE_ID).order('sort_order', { ascending: false }).limit(1)) as { sort_order: number }[]; row.sort_order = (mx[0]?.sort_order ?? 0) + 1; }
    const r = await sb().from('hpb_mappings').upsert(row).select().single();
    if (r.error) throw new Error(rlsMsg(r.error.message, '対応表の変更'));
    return r.data as HpbMapping;
  },
  async deleteHpbMapping(id) { const r = await sb().from('hpb_mappings').delete().eq('id', id); if (r.error) throw new Error(rlsMsg(r.error.message, '対応表の変更')); },
  async inboundMails(limit = 100) {
    if (!(await caps()).hpb11) return null;
    const r = await sb().from('inbound_mails').select('*').eq('store_id', STORE_ID).order('created_at', { ascending: false }).limit(limit);
    if (r.error) throw new Error(rlsMsg(r.error.message, '受信ログを見ること'));
    return r.data as InboundMail[];
  },
  async hpbAction(a) {
    // 本番はサーバ（サービスキー）で処理する。ログイン中の人のトークンを渡して、サーバで役割を確かめる
    const { data } = await sb().auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('ログインの期限が切れています。もう一度ログインしてください');
    const res = await fetch('/api/inbound/hpb/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...a, store_id: STORE_ID }) });
    const j = (await res.json().catch(() => ({}))) as HpbActionResult;
    if (!res.ok || !j.ok) throw new Error(j.message || `うまくいきませんでした（${res.status}）`);
    return j;
  },
};

/** 0008 が無いDBに送ってはいけない列（スタッフ） */
const STAFF_8_COLS = ['display_name', 'name_en', 'color', 'sort_order', 'show_on_ledger', 'web_nominatable', 'home_store_id'] as const;
const STAFF_ERR: Record<string, string> = {
  staff_owner_only: 'オーナーの登録・変更はオーナーだけができます',
  staff_cannot_change_self: '自分の役割・在籍は自分では変えられません（別のオーナー・店長に頼んでください）',
  staff_login_link_locked: 'ログインの紐づけはこの画面では変えられません',
  staff_email_locked: 'ログインのメールはこの画面では変えられません',
  staff_cannot_delete_login: 'ログインできる人は削除できません。「退職」にしてください',
  staff_store_mismatch: '別の会社の店舗は選べません',
  staff_names_check: '名前は40文字まで（英語名は60文字まで）にしてください',
  staff_color_check: '色の指定が正しくありません',
  'row-level security': 'この操作の権限がありません（オーナー・店長だけ）',
};
function staffErr(e: { message: string; code?: string }): Error {
  if (e.code === '23503' || /foreign key/i.test(e.message)) return new Error('過去の予約・売上・シフト・カルテにこの人の名前が残っているため削除できません。「退職」にしてください（過去の記録には名前が残ります）。');
  const k = Object.keys(STAFF_ERR).find(x => e.message.includes(x));
  return new Error(k ? STAFF_ERR[k] : e.message);
}

const REVERSE_ERR: Record<string, string> = {
  closed_owner_only: '締め済みの伝票の赤伝は、オーナー・店長だけができます',
  already_reversed: 'この伝票はすでに赤伝済みです',
  reason_required: '理由を入れてください',
  forbidden: 'この操作の権限がありません',
  not_found: '伝票が見つかりません',
};

// ---- 公式ネット予約（お客様用）：anon キーで public_* 関数だけを呼ぶ ----
async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const r = await sb().rpc(fn, args);
  if (r.error) {
    if (r.error.code === 'PGRST202' || /Could not find the function|does not exist/.test(r.error.message)) throw new Error('not_ready');
    throw new Error(r.error.message);
  }
  return r.data as T;
}
export const supabasePublicApi: PublicApi = {
  mode: 'supabase',
  storeInfo: slug => rpc('public_store_info', { p_slug: slug }),
  menus: (slug, code) => rpc('public_menus', { p_slug: slug, p_code: code || null }),
  // オプションは選んだときだけ送る（0009 より前の関数にも同じ呼び方で届くように）
  availability: (slug, menuId, from, to, couponId, staffId, optionIds) => rpc('public_availability', { p_slug: slug, p_menu: menuId, p_from: from, p_to: to, p_coupon: couponId || null, p_staff: staffId || null, ...(optionIds?.length ? { p_options: optionIds } : {}) }),
  createBooking: i => rpc('public_create_booking', { p_slug: i.slug, p_menu: i.menu_id, p_start: i.start_at, p_name: i.name, p_kana: i.kana, p_phone: i.phone, p_email: i.email, p_intake: i.intake, p_coupon: i.coupon_id || null, p_code: i.code || null, p_staff: i.staff_id || null, p_lang: i.lang, ...(i.option_ids?.length ? { p_options: i.option_ids } : {}) }),
  bookingByToken: token => rpc('public_booking_by_token', { p_token: token }),
  cancelBooking: token => rpc('public_cancel_booking', { p_token: token }),
};

/** その店舗での初来店＝会計済み予約・確定伝票の全期間で一番古い日時 */
async function firstVisitsFor(storeId: ID, ids: ID[]): Promise<Record<ID, string>> {
  const out: Record<ID, string> = {};
    const put = (cid: ID|null|undefined, t: string) => { if (cid && (!out[cid] || t < out[cid])) out[cid] = t; };
    for (const c of chunk([...new Set(ids)], 100)) {
      const ss = must(await sb().from('sales').select('customer_id, sold_at').eq('store_id', storeId).eq('status', 'confirmed').in('customer_id', c)) as { customer_id: ID; sold_at: string }[];
      ss.forEach(x => put(x.customer_id, x.sold_at));
      const bs = must(await sb().from('bookings').select('customer_id, start_at').eq('store_id', storeId).eq('status', 'done').in('customer_id', c)) as { customer_id: ID; start_at: string }[];
      bs.forEach(x => put(x.customer_id, x.start_at));
    }
    return out;
}
