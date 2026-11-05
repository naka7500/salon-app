// 本番用：Supabase。NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / NEXT_PUBLIC_STORE_ID を .env.local に置く。
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Repo, Sale, SaleLine, Payment, Booking, InventoryMove, RegisterClosing, Product, Lane, Store, ShiftPattern, Shift, ShiftMonth, ID } from './types';

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
const normShift = (r: Shift): Shift => ({ ...r, start_time: hm5(r.start_time), end_time: hm5(r.end_time) });
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

export const supabaseRepo: Repo = {
  mode: 'supabase',
  async store() { return must(await sb().from('stores').select('*').eq('id', STORE_ID).single()); },
  async stores() { return must(await sb().from('stores').select('*').order('name')) as Store[]; },
  switchStore(id) { try { localStorage.setItem(CUR_KEY, id); } catch {} },
  async lanes() { return must(await sb().from('lanes').select('*').eq('store_id', STORE_ID).eq('active', true).order('sort_order')) as Lane[]; },
  async staff() { const ss = must(await sb().from('staff_stores').select('staff_id').eq('store_id', STORE_ID)) as { staff_id: string }[]; return must(await sb().from('staff').select('*').in('id', ss.map(x => x.staff_id)).eq('active', true)); },
  async resources() { return must(await sb().from('resources').select('*').eq('store_id', STORE_ID).eq('active', true).order('sort_order')); },
  async menus() { return must(await sb().from('menus').select('*').eq('store_id', STORE_ID).eq('active', true).order('sort_order')); },
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
  async salesOn(date) { const [s, e] = dayRange(date); return loadSales(must(await sb().from('sales').select('*').eq('store_id', STORE_ID).gte('sold_at', s).lt('sold_at', e).order('sold_at'))); },
  async salesOfCustomer(id) { return loadSales(must(await sb().from('sales').select('*').eq('customer_id', id).order('sold_at', { ascending: false }))); },
  async salesBetween(from, to) { const [s, e] = periodRange(from, to); return loadSales(await all<Sale>((a, b) => sb().from('sales').select('*').eq('store_id', STORE_ID).gte('sold_at', s).lt('sold_at', e).order('sold_at').range(a, b))); },
  async firstVisits(ids) {
    // この店舗での初来店＝会計済み予約・確定伝票の全期間で一番古い日時
    const out: Record<ID, string> = {};
    const put = (cid: ID|null|undefined, t: string) => { if (cid && (!out[cid] || t < out[cid])) out[cid] = t; };
    for (const c of chunk([...new Set(ids)], 100)) {
      const ss = must(await sb().from('sales').select('customer_id, sold_at').eq('store_id', STORE_ID).eq('status', 'confirmed').in('customer_id', c)) as { customer_id: ID; sold_at: string }[];
      ss.forEach(x => put(x.customer_id, x.sold_at));
      const bs = must(await sb().from('bookings').select('customer_id, start_at').eq('store_id', STORE_ID).eq('status', 'done').in('customer_id', c)) as { customer_id: ID; start_at: string }[];
      bs.forEach(x => put(x.customer_id, x.start_at));
    }
    return out;
  },
  async createSale(input) {
    const subtotal = input.lines.reduce((a, l) => a + l.unit_price * l.qty, 0);
    const total = subtotal - input.discount; const tax = Math.floor(total - total / 1.1);
    const sale_no = must(await sb().rpc('next_sale_no', { p_store: STORE_ID })) as string;
    const sale = must(await sb().from('sales').insert({ store_id: STORE_ID, booking_id: input.booking_id, customer_id: input.customer_id, main_staff_id: input.main_staff_id, sale_no, subtotal, discount: input.discount, tax, total, discount_reason: input.discount_reason, note: input.note }).select().single()) as Sale;
    must(await sb().from('sale_lines').insert(input.lines.map(l => ({ ...l, sale_id: sale.id, amount: l.unit_price * l.qty }))));
    must(await sb().from('payments').insert(input.payments.map(p => ({ ...p, sale_id: sale.id }))));
    if (input.booking_id) await sb().from('bookings').update({ status: 'done' }).eq('id', input.booking_id);
    return loadSale(sale.id);
  },
  async reverseSale(id, reason) {
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
  async addKarte(k) { return must(await sb().from('karte_entries').insert({ ...k, store_id: STORE_ID }).select().single()); },
  // ---- シフト（0005_shifts.sql） ----
  async shiftPatterns() { return (must(await sb().from('shift_patterns').select('*').eq('store_id', STORE_ID).eq('active', true).order('sort_order')) as ShiftPattern[]).map(normPattern); },
  async saveShiftPattern(p) { return normPattern(must(await sb().from('shift_patterns').upsert({ ...p, store_id: STORE_ID }).select().single()) as ShiftPattern); },
  async deleteShiftPattern(id) { must(await sb().from('shift_patterns').update({ active: false }).eq('id', id)); },
  async shiftsBetween(from, to) { return (await all<Shift>((a, b) => sb().from('shifts').select('*').eq('store_id', STORE_ID).gte('date', from).lt('date', to).not('staff_id', 'is', null).order('date').range(a, b))).map(normShift); },
  async saveShifts(rows) { for (const c of chunk(rows, 500)) must(await sb().from('shifts').upsert(c.map(r => ({ ...r, store_id: STORE_ID })), { onConflict: 'store_id,staff_id,date' })); },
  async deleteShifts(keys) {
    const byDate: Record<string, ID[]> = {};
    keys.forEach(k => (byDate[k.date] ??= []).push(k.staff_id));
    for (const [d, ids] of Object.entries(byDate)) must(await sb().from('shifts').delete().eq('store_id', STORE_ID).eq('date', d).in('staff_id', ids));
  },
  async shiftMonth(ym) { return must(await sb().from('shift_months').select('*').eq('store_id', STORE_ID).eq('ym', ym).maybeSingle()) as ShiftMonth ?? undefined; },
  async markShiftMonth(ym) { return must(await sb().from('shift_months').upsert({ store_id: STORE_ID, ym, confirmed_at: new Date().toISOString() }, { onConflict: 'store_id,ym' }).select().single()) as ShiftMonth; },
};
