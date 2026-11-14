// 本番用：Supabase。NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / NEXT_PUBLIC_STORE_ID を .env.local に置く。
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { BookingHistoryEntry, RepeatSource, RepeatVisit, RepeatSummary, RepeatRules, HpbSettings, HpbMapping, InboundMail, HpbActionResult, Repo, ImportLog, ImportPreset, HistVisit, HistSummaryInput, ImportSource, Sale, SaleLine, Payment, Booking, InventoryMove, RegisterClosing, Product, Lane, Store, ShiftPattern, Shift, ShiftMonth, ID, Capabilities, Customer, Menu, Staff, StoreGoal, Coupon, AppNotification, AuditLog, OptionGroup, KartePage, KartePageImage, KarteBackground, ConsentTemplate, ConsentDocument } from './types';
import { KARTE_PAGE_IMAGES_MAX } from './types';
import { sha256Hex } from '../consent/hash';
import { consentErrMsg } from '../consent/errors';
import type { PublicApi, PublicBookingResult, PublicLineResult, PublicMyBooking } from '../web';
import { validateSale, saleTotals } from '../pos';
import { defaultLineSettings, type LineLink, type LineSettings } from '../line/types';
import { checkTemplate } from '../line/templates';
import type { DirectSendResult, ManualSendResult } from '../line/manual';
import { MERGE_ERR, REQUEST_TTL_DAYS, type LineLinkRequest } from '../line/linkPolicy';
import { onLedger, byStaffOrder, DEFAULT_REPEAT_RULES } from './types';
import { normRules } from '../repeat';
import type { StaffLoginResult, StaffLoginStatusResult } from '../staffLogin';

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
  if (!CAPS) CAPS = (async () => { const [goals, shiftBreaks, lastOrder, phaseC, staffSettings, v11, karte10, hpb11, import12, v13, v14, v15, v18, v20, v22, karte24, consent25, v26] = await Promise.all([probe('store_goals', 'store_id'), probe('shifts', 'break_start'), probe('stores', 'last_order_offset_min'), probe('coupons', 'id'), probe('staff', 'show_on_ledger'), probe('option_groups', 'id'), probe('karte_pages', 'id'), probe('hpb_mappings', 'id'), probe('import_logs', 'id'), probe('store_report_settings', 'store_id'), probe('stores', 'ledger_menu_ids'), probe('line_channels', 'store_id'), probe('menus', 'coupon_only'), probe('line_link_requests', 'id'), probe('companies', 'legal_name'), probe('karte_pages', 'images'), probe('consent_documents', 'id'), probe('stores', 'web_booking_line_only')]); return { goals, shiftBreaks, lastOrder, phaseC, staffSettings, v11, karte10, hpb11, import12, v13, v14, v15, v18, v20, v22, karte24, consent25, v26 }; })();
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
/** 検索語：PostgREST のフィルタ文字列を壊す記号（, ( ) * % \ : "）を除く */
export const searchTerm = (q?: string|null) => (q || '').replace(/[,()*%\\:"]/g, ' ').trim().slice(0, 40);
/** create_sale（0014）のエラー → 日本語 */
const SALE_ERR: Record<string, string> = {
  forbidden: 'この操作の権限がありません（閲覧のみの方・退職した方は会計できません）',
  booking_already_paid: 'この予約はもう会計済みです（伝票の一覧を確認してください）',
  invalid_qty: '数量は1以上の整数にしてください（取消は赤伝で）', invalid_discount: '値引が正しくありません（0円〜小計まで）',
  noncash_over_total: '現金以外の支払が合計を超えています。お釣りが出るのは現金だけです', paid_short: 'お預かりが足りません',
  invalid_payment: '支払の内容が正しくありません', invalid_line: '明細の内容が正しくありません', no_lines: '明細がありません',
  menu_store_mismatch: 'ほかの店舗のメニューが入っています', product_store_mismatch: 'ほかの店舗の商品が入っています',
  booking_store_mismatch: 'ほかの店舗の予約です', line_staff_company: '明細担当がこの会社のスタッフではありません', main_lane_store_mismatch: '主担当の受付枠がこの店舗のものではありません',
};
function must<T>(r: { data: T | null; error: { message: string } | null }): T { if (r.error) throw new Error(r.error.message); return r.data as T; }
/** ログイン中の人のトークンをつけてサーバのAPIを呼ぶ（本文はログに出さない） */
async function staffApi(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: { message?: string } & Record<string, unknown> }> {
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('ログインの期限が切れています。もう一度ログインしてください');
  const res = await fetch(path, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as { message?: string } & Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

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
/** 0025：同意書・問診票（テンプレと署名済みPDF）の非公開バケット */
const CONSENT_BUCKET = 'consents';
const isUrl = (p: string) => p.startsWith('data:') || /^https?:/.test(p);
const SIGNED = new Map<string, { url: string; exp: number }>();
/** ファイルを上げる。カルテ（karte）は同じ場所への差し替えあり（今までどおり）。
 *  同意書（consents）は上書きしない（upsert: false）：テンプレも署名済みPDFも毎回ちがう名前で上げる。署名済みPDFは差し替え不可（監査 2026-11-11 M3・M6） */
async function upload(path: string, blob: Blob, bucket = KARTE_BUCKET) {
  const r = await sb().storage.from(bucket).upload(path, blob, { contentType: blob.type || 'image/png', upsert: bucket !== CONSENT_BUCKET, cacheControl: '3600' });
  const mig = bucket === CONSENT_BUCKET ? '0025' : '0010';
  if (r.error) throw new Error(/row-level security|Unauthorized|403/i.test(r.error.message) ? `ファイルを保存する権限がありません（DB更新 ${mig} が流れているか、ログイン中の会社・役割を確認してください）` : `ファイルを保存できませんでした：${r.error.message}`);
}
async function removeFiles(paths: string[], bucket = KARTE_BUCKET) { const ps = paths.filter(p => p && !isUrl(p)); if (ps.length) await sb().storage.from(bucket).remove(ps).catch(() => {}); ps.forEach(p => SIGNED.delete(`${bucket}:${p}`)); }
/** 期限つきURL（1時間。同じパスは使い回す） */
async function signedUrls(paths: string[], bucket: string) {
  const out: Record<string, string> = {}; const need: string[] = []; const t = Date.now();
  for (const p of [...new Set(paths)]) { if (!p) continue; if (isUrl(p)) { out[p] = p; continue; } const c = SIGNED.get(`${bucket}:${p}`); if (c && c.exp > t + 60_000) out[p] = c.url; else need.push(p); }
  for (const c of chunk(need, 100)) {
    const r = await sb().storage.from(bucket).createSignedUrls(c, 3600);
    if (r.error) throw new Error(r.error.message);
    for (const x of r.data ?? []) if (x.signedUrl && x.path) { out[x.path] = x.signedUrl; SIGNED.set(`${bucket}:${x.path}`, { url: x.signedUrl, exp: t + 3600_000 }); }
  }
  return out;
}
async function downloadBlob(path: string, bucket: string) {
  if (isUrl(path)) return (await fetch(path)).blob();
  const r = await sb().storage.from(bucket).download(path);
  if (r.error || !r.data) throw new Error('ファイルを読み込めませんでした');
  return r.data;
}
const extOf = (b: Blob) => (b.type === 'image/jpeg' ? 'jpg' : b.type === 'image/webp' ? 'webp' : b.type === 'application/pdf' ? 'pdf' : 'png');
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
  async customers(q, opt) {
    const limit = Math.min(1000, Math.max(1, opt?.limit ?? 200)), offset = Math.max(0, opt?.offset ?? 0);
    let r = sb().from('customers').select('*').eq('company_id', COMPANY_ID).is('merged_into', null).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    const k = searchTerm(q);
    if (k) { const digits = k.replace(/[^0-9]/g, ''); r = r.or([`name.ilike.*${k}*`, `kana.ilike.*${k}*`, ...(digits.length >= 3 ? [`phone.ilike.*${digits}*`] : [`phone.ilike.*${k}*`])].join(',')); }
    return must(await r);
  },
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
    const bad = validateSale(input); if (bad) throw new Error(bad);
    const cc = await caps();
    if (cc.v14) {
      // 0014：1回の RPC で伝票・明細・支払・予約の「会計済」を1つのトランザクションで書く。
      // 同じ client_key でやり直しても伝票は1枚（通信が切れて押し直したときも二重にならない）
      const key = input.client_key || crypto.randomUUID();
      const body = { booking_id: input.booking_id ?? null, customer_id: input.customer_id ?? null, main_staff_id: input.main_staff_id ?? null, main_label: input.main_staff_id ? null : input.main_label ?? null, main_lane_id: input.main_staff_id ? null : input.main_lane_id ?? null,
        discount: input.discount, discount_reason: input.discount_reason ?? null, note: input.note ?? null, coupon_id: input.coupon_id ?? null, partner_booking_ids: input.partner_booking_ids ?? [],
        lines: input.lines.map(l => ({ kind: l.kind, menu_id: l.menu_id ?? null, product_id: l.product_id ?? null, name: l.name, unit_price: l.unit_price, qty: l.qty, tax_rate: l.tax_rate, staff_id: l.staff_id ?? null })),
        payments: input.payments.map(p => ({ method: p.method, amount: p.amount })) };
      let lastErr: unknown = null;
      for (let i = 0; i < 3; i++) {
        const r = await sb().rpc('create_sale', { p_store: STORE_ID, p_input: body, p_client_key: key });
        if (!r.error) return loadSale(r.data as string);
        lastErr = r.error;
        const m = r.error.message || '';
        const known = Object.keys(SALE_ERR).find(k => m.includes(k));
        if (known) throw new Error(SALE_ERR[known]);
        if (!/fetch|network|timeout|Failed/i.test(m)) break;   // 通信の失敗だけ、同じ合言葉でやり直す
        await new Promise(res => setTimeout(res, 600 * (i + 1)));
      }
      throw new Error(`会計を保存できませんでした：${(lastErr as { message?: string })?.message || lastErr}（もう一度押しても二重にはなりません）`);
    }
    const { subtotal, total, tax } = saleTotals(input.lines, input.discount);
    const sale_no = must(await sb().rpc('next_sale_no', { p_store: STORE_ID })) as string;
    const extra: Record<string, unknown> = input.coupon_id && cc.phaseC ? { coupon_id: input.coupon_id } : {};
    // 0013：主担当が受付枠・フリーのとき（0013 より前は主担当なしで保存。売上は明細担当で数えるので金額には影響しない）
    if (cc.v13 && !input.main_staff_id && input.main_label) { extra.main_label = input.main_label.slice(0, 60); extra.main_lane_id = input.main_lane_id ?? null; }
    const sale = must(await sb().from('sales').insert({ store_id: STORE_ID, booking_id: input.booking_id, customer_id: input.customer_id, main_staff_id: input.main_staff_id, sale_no, subtotal, discount: input.discount, tax, total, discount_reason: input.discount_reason, note: input.note, ...extra }).select().single()) as Sale;
    must(await sb().from('sale_lines').insert(input.lines.map(l => ({ ...l, sale_id: sale.id, amount: l.unit_price * l.qty }))));
    must(await sb().from('payments').insert(input.payments.map(p => ({ ...p, sale_id: sale.id }))));
    for (const id of [input.booking_id, ...(input.partner_booking_ids ?? [])].filter(Boolean) as ID[]) await sb().from('bookings').update({ status: 'done' }).eq('id', id);
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
    if ((await caps()).v14) {
      // 0014：締めはスタッフ以上、締め後の修正はオーナー・店長だけ（サーバで確認）。あるべき現金はサーバで計算し、締めたら伝票をロック。締め後の修正は修正履歴に残る
      const r = await sb().rpc('save_register_closing', { p_store: STORE_ID, p_date: c.date, p_opening: c.opening_float ?? 0, p_counted: c.counted_cash ?? null, p_note: c.note ?? null, p_lock: !!c.closed_at });
      if (r.error) throw new Error(r.error.message.includes('closed_owner_only') ? '締めた後の修正はオーナー・店長だけができます。店長に依頼してください' : r.error.message.includes('forbidden') ? 'レジ締めの保存はスタッフ以上ができます（閲覧のみの方はできません）' : r.error.message);
      return r.data as RegisterClosing;
    }
    const r = must(await sb().from('register_closings').upsert({ ...c, store_id: STORE_ID }, { onConflict: 'store_id,date' }).select().single()) as RegisterClosing;
    if (c.closed_at) { const [s, e] = dayRange(c.date); must(await sb().from('sales').update({ closed_on: c.date }).eq('store_id', STORE_ID).gte('sold_at', s).lt('sold_at', e).is('closed_on', null)); }
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
    if (keys.includes('ledger_menu_ids') && !c.v14) throw new Error('台帳に出すメニューの保存はDB更新（0014）の後に使えます');
    if (keys.includes('web_booking_line_only') && !c.v26) throw new Error('ネット予約の受け方（LINEの中だけ）はDB更新（0026）の後に使えます');
    if (keys.some(k => k !== 'last_order_offset_min' && k !== 'ledger_menu_ids' && !(STORE_V11_COLS as readonly string[]).includes(k)) && !c.phaseC) throw new Error('この設定はDB更新（0007）の後に使えます');
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
    if (!cc.v15) delete row.revisit_days;
    if (!cc.v18) delete row.coupon_only;
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
    const c0 = await caps(); if (!c0.phaseC) return null; const cc15 = !!c0.v15;
    let q = sb().from('notifications').select('*').eq('store_id', STORE_ID).in('kind', ['new_booking', 'cancel_booking', 'hpb_booking', 'hpb_change', 'hpb_cancel', 'hpb_attention', ...(cc15 ? ['line_change'] : [])]).order('created_at', { ascending: false }).limit(100);
    if (onlyUnread) q = q.is('read_at', null);
    return must(await q) as AppNotification[];
  },
  async markNotificationsRead(ids) { for (const c of chunk(ids, 200)) must(await sb().from('notifications').update({ read_at: new Date().toISOString() }).in('id', c).is('read_at', null)); },
  async auditLogs(from, to) {
    if (!(await caps()).phaseC) return null;
    const [s, e] = periodRange(from, to);
    // ログインの操作（staff_login）は 設定＞スタッフ に出す。LINE連携の記録（line_link＝0020）も売上台帳の修正履歴には出さない
    return must(await sb().from('audit_logs').select('*').eq('store_id', STORE_ID).not('table_name', 'in', '(staff_login,line_link)').gte('at', s).lt('at', e).order('at', { ascending: false }).limit(500)) as AuditLog[];
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
    const cp = await caps();
    if (!cp.karte10) throw new Error('手書きページの保存はDB更新（0010）の後に使えます');
    if (!cp.karte24 && drafts.some(d => d.images?.length)) throw new Error('ページに置いた画像の保存はDB更新（0024）の後に使えます。画像を消すか、DB更新のあとにもう一度保存してください');
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
        // 0024：置いた画像（新しい物だけ上げる。消えた物はあとで片づける）
        const images: KartePageImage[] = [];
        for (const im of (d.images ?? []).slice(0, KARTE_PAGE_IMAGES_MAX)) {
          let path = im.path ?? null;
          if (im.blob) { path = `${base}/${d.id}-img-${im.id}-${ts}.${extOf(im.blob)}`; await upload(path, im.blob); made.push(path); }
          if (path) images.push({ id: im.id, path, x: im.x, y: im.y, w: im.w, h: im.h });
        }
        for (const pi of prev?.images ?? []) if (!images.some(x => x.path === pi.path)) drop.push(pi.path);
        rows.push({ id: d.id, karte_entry_id: entryId, page_no: i + 1, strokes: d.strokes, png_path, background_path,
          background_template_id: d.bg.kind === 'template' ? d.bg.id : null, background_builtin: d.bg.kind === 'builtin' ? d.bg.key : null,
          background_opacity: Math.round(Math.max(0.05, Math.min(1, d.opacity)) * 100) / 100, ...(cp.karte24 ? { images } : {}), updated_at: now });
      }
      const gone = old.filter(p => !drafts.some(d => d.id === p.id));
      if (rows.length) must(await sb().from('karte_pages').upsert(rows));
      if (gone.length) must(await sb().from('karte_pages').delete().in('id', gone.map(p => p.id)));
      gone.forEach(p => { if (p.png_path) drop.push(p.png_path); if (p.background_path) drop.push(p.background_path); for (const pi of p.images ?? []) drop.push(pi.path); });
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
  async karteFileUrls(paths) { return signedUrls(paths, KARTE_BUCKET); },
  async karteFileBlob(path) { return downloadBlob(path, KARTE_BUCKET); },
  // ---- 同意書・問診票（0025）。ファイルは非公開バケット consents。<会社ID>/consent-templates/…（owner・manager が書く）／<会社ID>/consents/<書類ID>.pdf（viewer 以外が上げる。上書き・差し替え不可） ----
  async consentTemplates(all) {
    if (!(await caps()).consent25) return null;
    let q = sb().from('consent_templates').select('*').eq('company_id', COMPANY_ID).order('sort_order').order('title');
    if (!all) q = q.or(`store_id.is.null,store_id.eq.${STORE_ID}`);
    return must(await q) as ConsentTemplate[];
  },
  async saveConsentTemplate(t, file) {
    if (!(await caps()).consent25) throw new Error('同意書・問診票はDB更新（0025）の後に使えます');
    const row: Record<string, unknown> = { ...t, title: t.title.trim(), company_id: COMPANY_ID };
    delete row.created_at;
    if (!row.id) {
      if (!file) throw new Error('PDF か画像を選んでください');
      row.id = crypto.randomUUID();
      const mx = must(await sb().from('consent_templates').select('sort_order').eq('company_id', COMPANY_ID).order('sort_order', { ascending: false }).limit(1)) as { sort_order: number }[];
      row.sort_order = (mx[0]?.sort_order ?? 0) + 1;
    }
    let prevPath: string|null = null; let made: string|null = null;
    if (file) {
      if (t.id) prevPath = ((must(await sb().from('consent_templates').select('file_path').eq('id', t.id).maybeSingle()) as { file_path: string } | null)?.file_path) ?? null;
      made = `${COMPANY_ID}/consent-templates/${row.id}-${Date.now()}.${extOf(file)}`; await upload(made, file, CONSENT_BUCKET);
      row.file_path = made; row.mime = file.type || 'application/pdf'; row.kind = row.mime === 'application/pdf' ? 'pdf' : 'image';
    }
    const r = await sb().from('consent_templates').upsert(row).select().single();
    if (r.error) { if (made) await removeFiles([made], CONSENT_BUCKET); throw new Error(rlsMsg(r.error.message, '同意書・問診票のテンプレの変更')); }
    if (prevPath && prevPath !== made) await removeFiles([prevPath], CONSENT_BUCKET);
    return r.data as ConsentTemplate;
  },
  async consentDocuments(customerId) {
    if (!(await caps()).consent25) return null;
    return must(await sb().from('consent_documents').select('*').eq('customer_id', customerId).order('signed_at', { ascending: false })) as ConsentDocument[];
  },
  // 署名日時・担当・会社・テンプレ名は DB（0025 のトリガー）が決める。ここから送るのは「どのお客様・どのテンプレ・お名前・PDFの場所と指紋」だけ。
  // PDF の場所は <会社ID>/consents/<書類ID>.pdf（署名ごとに新しい名前。お客様IDは入れない＝統合しても場所は変わらない）
  async addConsentDocument(d, pdf) {
    if (!(await caps()).consent25) throw new Error('同意書・問診票はDB更新（0025）の後に使えます');
    const me = await this.me(); if (!me) throw new Error('ログインしてください');
    const id = crypto.randomUUID();
    const file_path = `${COMPANY_ID}/consents/${id}.pdf`;
    const file_sha256 = await sha256Hex(pdf);
    await upload(file_path, pdf, CONSENT_BUCKET);
    const row = { id, store_id: STORE_ID, customer_id: d.customer_id, template_id: d.template_id, signer_name: d.signer_name.trim().slice(0, 60), file_path, file_sha256, file_size: pdf.size };
    const r = await sb().from('consent_documents').insert(row).select().single();
    if (r.error) {
      await removeFiles([file_path], CONSENT_BUCKET);   // 記録の無いPDFは片づける（記録ができた後は、だれも消せない）
      throw new Error(consentErrMsg(r.error.message) ?? (/row-level security|permission denied/i.test(r.error.message) ? '署名の保存は閲覧のみの方にはできません' : r.error.message));
    }
    return r.data as ConsentDocument;
  },
  async voidConsentDocument(id, reason) {
    if (!(await caps()).consent25) throw new Error('同意書・問診票はDB更新（0025）の後に使えます');
    const r = await sb().rpc('void_consent_document', { p_id: id, p_reason: reason });
    if (r.error) throw new Error(consentErrMsg(r.error.message) ?? r.error.message);
    return r.data as ConsentDocument;
  },
  async consentFileUrls(paths) { return signedUrls(paths, CONSENT_BUCKET); },
  async consentFileBlob(path) { return downloadBlob(path, CONSENT_BUCKET); },
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
  // ---- 顧客CSV取り込み（0012）。お客様の中身はログに出さない ----
  async importIndex() {
    return all<Customer>((a, b) => sb().from('customers').select(IMPORT_INDEX_COLS).eq('company_id', COMPANY_ID).order('created_at').range(a, b));
  },
  async histKeys(source) {
    const rows = await all<{ dedupe_key: string }>((a, b) => sb().from('historical_visits').select('dedupe_key').eq('store_id', STORE_ID).eq('source', source).eq('kind', 'visit').range(a, b));
    return new Set(rows.map(r => r.dedupe_key));
  },
  async runCustomerImport(req, onProgress) {
    await needImport12();
    const log = await newImportLog('customers', req.source, req.file_name, req.mode);
    const total = req.creates.length + req.updates.length + req.sames.length; let done = 0; let created = 0, updated = 0;
    const summaries: Omit<HistVisit, 'id'>[] = [];
    try {
      for (const c of chunk(req.creates, 200)) {
        const rows = c.map(x => ({ id: newId(), company_id: COMPANY_ID, ...x.data, import_source: req.source, import_id: log.id }));
        must(await sb().from('customers').insert(rows));
        rows.forEach((r, i) => { const sm = c[i].summary; if (sm) summaries.push(summaryRow(r.id, req.source, sm, log.id)); });
        created += rows.length; done += rows.length; onProgress?.(done, total);
      }
      // 更新は1人ずつ（項目がそろっていないので）。6本ずつ並べて送る
      const ups = [...req.updates];
      while (ups.length) {
        const part = ups.splice(0, 6);
        await Promise.all(part.map(async u => {
          const patch = { ...u.patch, ...(u.patch.external_id ? { import_source: req.source } : {}) };
          must(await sb().from('customers').update(patch).eq('id', u.id).eq('company_id', COMPANY_ID));
          if (u.summary) summaries.push(summaryRow(u.id, req.source, u.summary, log.id));
        }));
        updated += part.length; done += part.length; onProgress?.(done, total);
      }
      for (const x of req.sames) if (x.summary) summaries.push(summaryRow(x.id, req.source, x.summary, log.id));
      for (const c of chunk(summaries, 500)) must(await sb().from('historical_visits').upsert(c, { onConflict: 'company_id,store_id,source,dedupe_key' }));
      done = total; onProgress?.(done, total);
    } catch (e) {
      await sb().from('import_logs').update({ counts: { created, updated, same: req.same, skipped: req.skipped, errors: req.errors, failed: true } }).eq('id', log.id);
      throw new Error(`途中で止まりました（登録 ${created}件・更新 ${updated}件までは入っています。同じファイルをもう一度取り込むと続きから入ります）：${(e as Error).message}`);
    }
    return normLog(must(await sb().from('import_logs').update({ counts: { created, updated, same: req.same, skipped: req.skipped, errors: req.errors, visits: summaries.length } }).eq('id', log.id).select().single()));
  },
  async runVisitImport(req, onProgress) {
    await needImport12();
    const log = await newImportLog('visits', req.source, req.file_name, 'fill');
    let added = 0, done = 0;
    try {
      for (const c of chunk(req.rows, 500)) {
        const rows = c.map(r => ({ company_id: COMPANY_ID, store_id: STORE_ID, kind: 'visit', source: req.source, import_id: log.id, ...r }));
        const ins = must(await sb().from('historical_visits').upsert(rows, { onConflict: 'company_id,store_id,source,dedupe_key', ignoreDuplicates: true }).select('id')) as { id: ID }[];
        added += ins.length; done += c.length; onProgress?.(done, req.rows.length);
      }
    } catch (e) {
      await sb().from('import_logs').update({ counts: { created: added, updated: 0, same: 0, skipped: req.skipped, errors: req.errors, visits: added, failed: true } }).eq('id', log.id);
      throw new Error(`途中で止まりました（${added}件までは入っています。同じファイルをもう一度取り込むと続きから入ります）：${(e as Error).message}`);
    }
    return normLog(must(await sb().from('import_logs').update({ counts: { created: added, updated: 0, same: 0, skipped: req.skipped + (req.rows.length - added), errors: req.errors, visits: added } }).eq('id', log.id).select().single()));
  },
  async importLogs() {
    if (!(await caps()).import12) return null;
    return (must(await sb().from('import_logs').select('*').eq('company_id', COMPANY_ID).order('created_at', { ascending: false }).limit(100)) as ImportLog[]).map(normLog);
  },
  async undoImport(id) {
    const r = await sb().rpc('undo_import', { p_import: id });
    if (r.error) throw new Error(/not_allowed/.test(r.error.message) ? '取り消しはオーナー・店長だけができます' : /already_undone/.test(r.error.message) ? 'この取り込みはすでに取り消しています' : r.error.message);
    return r.data as { removed: number; kept: number; visits: number };
  },
  async importPresets() {
    if (!(await caps()).import12) return null;
    return must(await sb().from('import_presets').select('source, kind, mapping, updated_at').eq('company_id', COMPANY_ID)) as ImportPreset[];
  },
  async saveImportPreset(p) {
    await needImport12();
    must(await sb().from('import_presets').upsert({ company_id: COMPANY_ID, source: p.source, kind: p.kind, mapping: p.mapping, updated_at: new Date().toISOString() }, { onConflict: 'company_id,source,kind' }));
  },
  async historicalVisits(customerId) {
    if (!(await caps()).import12) return null;
    return must(await sb().from('historical_visits').select('*').eq('customer_id', customerId).order('visited_on', { ascending: false, nullsFirst: false }).limit(500)) as HistVisit[];
  },
  // ---- 0013 ----
  async bookingHistory(bookingId) {
    if (!(await caps()).v13) return null;
    const rows = must(await sb().from('booking_history').select('id, booking_id, changed_at, op, source, actor_name, before, after').eq('booking_id', bookingId).order('changed_at').order('id').limit(500)) as { id: number; booking_id: ID; changed_at: string; op: string|null; source: string|null; actor_name: string|null; before: Booking|null; after: Booking|null }[];
    return rows.map(r => ({ id: r.id, booking_id: r.booking_id, at: r.changed_at, op: (r.op || (r.after ? 'update' : 'delete')) as BookingHistoryEntry['op'], source: (r.source || 'system') as BookingHistoryEntry['source'],
      actor_name: r.actor_name, snapshot: (r.after || r.before || {}) as Partial<Booking>, before: r.op === 'insert' ? null : r.before }));
  },
  async repeatSource(storeIds, to) {
    const c = await caps();
    const stores = (must(await sb().from('stores').select('*, companies(name)').in('id', storeIds)) as StoreRow[]).map(normStore);
    const companyIds = [...new Set(stores.map(x => x.company_id))];
    const end = periodRange(to, to)[0];
    type SRow = { id: ID; store_id: ID; customer_id: ID; sold_at: string; main_staff_id: ID|null; booking_id: ID|null; lines: { kind: string; staff_id: ID|null }[] };
    const [sales, staff] = await Promise.all([
      all<SRow>((a, b) => sb().from('sales').select('id, store_id, customer_id, sold_at, main_staff_id, booking_id, lines:sale_lines(kind, staff_id)').in('store_id', storeIds).eq('status', 'confirmed').not('customer_id', 'is', null).lt('sold_at', end).order('sold_at').range(a, b)),
      all<Staff>((a, b) => sb().from('staff').select('*').in('company_id', companyIds).range(a, b)),
    ]);
    const bIds = [...new Set(sales.map(x => x.booking_id).filter(Boolean) as ID[])];
    const nom = new Map<ID, boolean>();
    for (const ch of chunk(bIds, 200)) (must(await sb().from('bookings').select('id, nominated').in('id', ch)) as { id: ID; nominated: boolean }[]).forEach(x => nom.set(x.id, !!x.nominated));
    const visits: RepeatVisit[] = sales.map(x => {
      const tech = (x.lines || []).filter(l => l.kind !== 'product');
      const ids = [...new Set((tech.length ? tech : x.lines || []).map(l => l.staff_id || x.main_staff_id).filter((v): v is ID => !!v))];
      if (!ids.length && x.main_staff_id) ids.push(x.main_staff_id);
      const d = new Date(x.sold_at); const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return { store_id: x.store_id, customer_id: x.customer_id, date, staff_ids: ids, nominated: x.booking_id ? nom.get(x.booking_id) ?? null : null, src: 'sale' as const };
    });
    const summaries: RepeatSummary[] = [];
    if (c.import12) {
      type HRow = { store_id: ID; customer_id: ID; kind: string; visited_on: string|null; first_visit_on: string|null; last_visit_on: string|null; visit_count: number|null; staff_name: string|null };
      const hs = await all<HRow>((a, b) => sb().from('historical_visits').select('store_id, customer_id, kind, visited_on, first_visit_on, last_visit_on, visit_count, staff_name').in('store_id', storeIds).range(a, b));
      const key = (n: string) => n.replace(/\s/g, '');
      for (const h of hs) {
        if (h.kind === 'summary') { summaries.push({ store_id: h.store_id, customer_id: h.customer_id, visit_count: h.visit_count, first_visit_on: h.first_visit_on, last_visit_on: h.last_visit_on }); continue; }
        if (!h.visited_on || h.visited_on >= to) continue;
        const st = h.staff_name ? staff.find(x => key(x.name) === key(h.staff_name!) || (x.display_name && key(x.display_name) === key(h.staff_name!))) : undefined;
        visits.push({ store_id: h.store_id, customer_id: h.customer_id, date: h.visited_on, staff_ids: st ? [st.id] : [], nominated: null, src: 'hist' });
      }
    }
    const custIds = [...new Set(visits.map(v => v.customer_id))];
    const genders: Record<ID, string|null> = {};
    for (const ch of chunk(custIds, 150)) (must(await sb().from('customers').select('id, gender').in('id', ch)) as { id: ID; gender: string|null }[]).forEach(x => (genders[x.id] = x.gender));
    const rules: Record<ID, RepeatRules> = {};
    stores.forEach(st => (rules[st.id] = DEFAULT_REPEAT_RULES));
    if (c.v13) (must(await sb().from('store_report_settings').select('store_id, repeat_rules').in('store_id', storeIds)) as { store_id: ID; repeat_rules: RepeatRules|null }[]).forEach(r => (rules[r.store_id] = normRules(r.repeat_rules)));
    return { stores, staff, visits, summaries, genders, rules, rulesReady: !!c.v13 } satisfies RepeatSource;
  },
  async saveRepeatRules(storeId, rules) {
    if (!(await caps()).v13) throw new Error('区分の決め方の保存はDB更新（0013）の後に使えます（今は既定の決め方で数えています）');
    const r = await sb().from('store_report_settings').upsert({ store_id: storeId, repeat_rules: normRules(rules), updated_at: new Date().toISOString() }, { onConflict: 'store_id' });
    if (r.error) throw new Error(rlsMsg(r.error.message, '区分の決め方の変更'));
  },
  // ---- LINE連携（0015）。秘密は書くだけ（line_set_credentials）。送信・接続テストはサーバ（/api/line/admin） ----
  async lineSettings() {
    if (!(await caps()).v15) return null;
    const r = must(await sb().from('line_channels').select('*').eq('store_id', STORE_ID).maybeSingle()) as LineSettings | null;
    return r ? { ...defaultLineSettings(STORE_ID), ...r, confirm_time: (r.confirm_time || '18:00').slice(0, 5), revisit_time: (r.revisit_time || '11:00').slice(0, 5) } : defaultLineSettings(STORE_ID);
  },
  async saveLineSettings(p) {
    if (!(await caps()).v15) throw new Error('LINE連携はDB更新（0015）の後に使えます');
    for (const [k, t] of Object.entries(p.templates || {})) if (t && t.trim()) { const c = checkTemplate(t, k as never); if (c.errors.length) throw new Error(c.errors.join('／')); }
    // 書ける列だけ送る（0015で列ごとに権限を付けている。store_id は更新できないので upsert は使わない）
    const COLS = ['enabled', 'channel_id', 'login_channel_id', 'liff_id', 'confirm_enabled', 'confirm_time', 'revisit_enabled', 'revisit_time', 'revisit_vacancy_only', 'vacancy_threshold', 'ack_enabled', 'templates', 'plan_limit'] as const;
    const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const k of COLS) if (k in p) body[k] = (p as Record<string, unknown>)[k];
    // 0026：予約完了のお知らせ。列が無い DB（0026 未適用）には送らない（オンにしようとしたときだけ知らせる。ほかの設定の保存は止めない）
    if ('booked_enabled' in p) { if ((await caps()).v26) body.booked_enabled = !!p.booked_enabled; else if (p.booked_enabled) throw new Error('予約完了のお知らせはDB更新（0026）の後に使えます'); }
    const up = must(await sb().from('line_channels').update(body).eq('store_id', STORE_ID).select('*')) as LineSettings[];
    const r = (up && up[0]) || must(await sb().from('line_channels').insert({ ...body, store_id: STORE_ID }).select('*').single()) as LineSettings;
    return { ...defaultLineSettings(STORE_ID), ...r, confirm_time: (r.confirm_time || '18:00').slice(0, 5), revisit_time: (r.revisit_time || '11:00').slice(0, 5) };
  },
  async saveLineCredentials(c) {
    if (!(await caps()).v15) throw new Error('LINE連携はDB更新（0015）の後に使えます');
    const r = await sb().rpc('line_set_credentials', { p_store: STORE_ID, p_secret: c.channel_secret ?? null, p_token: c.access_token ?? null });
    if (r.error) throw new Error(r.error.message.includes('invalid_secret') ? 'チャネルシークレットは英数字32文字です（LINE Developers の「チャネル基本設定」）' : r.error.message.includes('invalid_token') ? 'チャネルアクセストークン（長期）が正しくありません' : r.error.message.includes('forbidden') ? 'オーナー・店長だけができます' : r.error.message);
    return (await this.lineSettings())!;
  },
  // ---- スタッフのログイン（サーバの /api/staff/login。サービスキーが無ければ 501 → server:false） ----
  async staffLoginStatus() {
    const res = await staffApi('/api/staff/login', { kind: 'status', store_id: STORE_ID });
    if (res.status === 501) return { server: false, invite_enabled: false, items: [], message: res.json.message };
    if (!res.ok) throw new Error(res.json.message || `ログインの状態を読めませんでした（${res.status}）`);
    return res.json as unknown as StaffLoginStatusResult;
  },
  async staffLoginAction(a) {
    const res = await staffApi('/api/staff/login', { ...a, store_id: STORE_ID });
    if (!res.ok) throw Object.assign(new Error(res.json.message || `うまくいきませんでした（${res.status}）`), { status: res.status });
    return res.json as unknown as StaffLoginResult;
  },
  async changeOwnPassword(password) {
    const res = await staffApi('/api/staff/password', { password });
    if (!res.ok) throw new Error(res.json.message || `パスワードを変えられませんでした（${res.status}）`);
    await sb().auth.refreshSession();   // 「仮パスワードのまま」の印が消えた新しいトークンにする
  },
  async lineAction(a) {
    if (a.kind !== 'test_connection' && a.kind !== 'test_send') throw new Error('デモの操作は本番では使えません');
    const { data } = await sb().auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('ログインの期限が切れています。もう一度ログインしてください');
    const res = await fetch('/api/line/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ ...a, store_id: STORE_ID }) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!res.ok) throw new Error(j.message || `うまくいきませんでした（${res.status}）`);
    return { ok: !!j.ok, message: j.message };
  },
  async lineContact(items) {
    if (!(await caps()).v15) throw new Error('LINE連携はDB更新（0015）の後に使えます');
    const { data } = await sb().auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('ログインの期限が切れています。もう一度ログインしてください');
    const res = await fetch('/api/line/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ kind: 'push_customer', items, store_id: STORE_ID }) });
    const j = (await res.json().catch(() => ({}))) as Partial<ManualSendResult>;
    if (!res.ok) throw new Error(j.message || `うまくいきませんでした（${res.status}）`);
    return { ok: !!j.ok, message: j.message || '', results: j.results || [], used: j.used, limit: j.limit };
  },
  async lineContactCustomer(customerId, text) {
    if (!(await caps()).v15) throw new Error('LINE連携はDB更新（0015）の後に使えます');
    const { data } = await sb().auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('ログインの期限が切れています。もう一度ログインしてください');
    const res = await fetch('/api/line/admin', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ kind: 'push_customer_direct', customer_id: customerId, text, store_id: STORE_ID }) });
    const j = (await res.json().catch(() => ({}))) as Partial<DirectSendResult>;
    if (!res.ok) throw new Error(j.message || `うまくいきませんでした（${res.status}）`);
    return { ok: !!j.ok, message: j.message || '', used: j.used, limit: j.limit };
  },
  // 0020：LINE連携の確認待ち（見るのは同じ会社のスタッフ＝RLS。決めるのはサーバ /api/line/link-request）
  async lineLinkRequests(ids) {
    if (!(await caps()).v20) return null;
    const since = new Date(Date.now() - REQUEST_TTL_DAYS * 86400_000).toISOString();
    const q = () => sb().from('line_link_requests').select('*').eq('store_id', STORE_ID).eq('status', 'pending').gte('created_at', since).order('created_at', { ascending: false });
    if (!ids) return must(await q().limit(500)) as LineLinkRequest[];
    const out: LineLinkRequest[] = [];
    for (const c of chunk([...new Set(ids)], 100)) out.push(...(must(await q().in('customer_id', c)) as LineLinkRequest[]));
    return out;
  },
  async decideLineLinkRequest(requestId, decision) {
    if (!(await caps()).v20) throw new Error('LINE連携の確認はDB更新（0020）の後に使えます');
    const { data } = await sb().auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error('ログインの期限が切れています。もう一度ログインしてください');
    const res = await fetch('/api/line/link-request', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ request_id: requestId, decision }) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!res.ok) throw new Error(j.message || `うまくいきませんでした（${res.status}）`);
    return { ok: !!j.ok, message: j.message || '' };
  },
  // 0022（案B）：同じ電話番号のお客様（SQL の customers_same_phone。同じ会社のスタッフだけ）と統合（merge_customers。在籍の owner・manager・staff）
  async customersSamePhone(customerId) {
    if (!(await caps()).v22) return null;
    const r = await sb().rpc('customers_same_phone', { p_customer: customerId });
    if (r.error) throw new Error(r.error.message);
    return (r.data ?? []) as Customer[];
  },
  async mergeCustomers(keepId, mergeId) {
    if (!(await caps()).v22) throw new Error('お客様の統合はDB更新（0022）の後に使えます');
    const r = await sb().rpc('merge_customers', { p_keep: keepId, p_merge: mergeId, p_store: STORE_ID });
    if (r.error) { const k = Object.keys(MERGE_ERR).find(x => r.error!.message.includes(x)); throw new Error(k ? MERGE_ERR[k] : rlsMsg(r.error.message, 'お客様の統合')); }
    const d = r.data as { kept_id: string; line: 'moved'|'kept'|'none'; bookings: number; sales: number; kartes: number; consents?: number };
    return { ok: true, message: `統合しました（予約 ${d.bookings}件・お会計 ${d.sales}件・カルテ ${d.kartes}件${d.consents ? `・同意書 ${d.consents}件` : ''}を移しました${d.line === 'moved' ? '・LINEのつながりも移しました' : d.line === 'kept' ? '・LINEは残す側のものを残しました' : ''}）`, kept_id: d.kept_id, line: d.line };
  },
  async lineLinks(ids) {
    if (!(await caps()).v15) return null;
    if (!ids) return must(await sb().from('line_links').select('*').eq('store_id', STORE_ID).order('created_at', { ascending: false }).limit(1000)) as LineLink[];
    const out: LineLink[] = [];
    for (const c of chunk([...new Set(ids)], 100)) out.push(...(must(await sb().from('line_links').select('*').eq('store_id', STORE_ID).in('customer_id', c)) as LineLink[]));
    return out;
  },
  async lineMessages(limit = 200) { if (!(await caps()).v15) return null; return must(await sb().from('line_messages').select('*').eq('store_id', STORE_ID).order('created_at', { ascending: false }).limit(limit)); },
  async lineQueue(limit = 200) { if (!(await caps()).v15) return null; return must(await sb().from('line_send_queue').select('*').eq('store_id', STORE_ID).order('created_at', { ascending: false }).limit(limit)); },
  async lineMonthUsage() {
    if (!(await caps()).v15) return 0;
    const d = new Date(Date.now() + 9 * 3600000); const start = new Date(`${d.toISOString().slice(0, 7)}-01T00:00:00+09:00`).toISOString();
    const r = await sb().from('line_messages').select('id', { count: 'exact', head: true }).eq('store_id', STORE_ID).eq('direction', 'out').eq('counted', true).gte('created_at', start);
    if (r.error) throw new Error(r.error.message); return r.count ?? 0;
  },
  async markLineHandled(ids) { must(await sb().rpc('line_mark_handled', { p_ids: ids.map(Number) })); },
  async setLineOptOut(linkId, opt) { const r = await sb().rpc('line_set_opt_out', { p_link: linkId, p_opt: opt }); if (r.error) throw new Error(r.error.message.includes('forbidden') ? (opt ? 'この操作の権限がありません' : 'お知らせの再開はオーナー・店長だけができます') : r.error.message); },
  async setLineTestTarget(u) { const r = await sb().rpc('line_set_test_target', { p_store: STORE_ID, p_line_user_id: u }); if (r.error) throw new Error(r.error.message.includes('forbidden') ? 'オーナーだけができます' : r.error.message); },
  async createLineLinkToken(customerId) {
    const st = await this.lineSettings();
    if (!st) throw new Error('LINE連携はDB更新（0015）の後に使えます');
    if (!st.enabled) throw new Error('この店舗のLINE連携がオフです（設定＞LINE連携）');
    if (!st.liff_id) throw new Error('LIFF ID が未設定です（設定＞LINE連携）');
    const r = await sb().rpc('line_create_link_token', { p_store: STORE_ID, p_customer: customerId });
    if (r.error) throw new Error(r.error.message.includes('forbidden') ? 'この操作の権限がありません' : r.error.message.includes('too_many') ? '短い時間に作りすぎです。少し待ってください' : r.error.message);
    return { token: r.data as string, url: `https://liff.line.me/${st.liff_id}?link=${r.data as string}` };
  },
};

// ---- 顧客CSV取り込みの部品 ----
const IMPORT_INDEX_COLS = 'id, company_id, name, kana, phone, email, birthday, birth_month, gender, postal_code, address, note, import_source, external_id, merged_into, created_at';
const newId = () => crypto.randomUUID();
async function needImport12() { if (!(await caps()).import12) throw new Error('顧客CSV取り込みは準備中です（DB更新 0012 の後に使えます）'); }
async function newImportLog(kind: 'customers'|'visits', source: ImportSource, file_name: string, mode: 'fill'|'overwrite'): Promise<ImportLog> {
  const r = await sb().from('import_logs').insert({ company_id: COMPANY_ID, store_id: STORE_ID, kind, source, file_name: file_name.slice(0, 300), mode, counts: {} }).select().single();
  if (r.error) throw new Error(rlsMsg(r.error.message, '取り込み'));
  return normLog(r.data as ImportLog);
}
const LOG_ZERO = { created: 0, updated: 0, same: 0, skipped: 0, errors: 0 };
const normLog = (l: ImportLog): ImportLog => ({ ...l, counts: Object.assign({}, LOG_ZERO, l.counts || {}) });
function summaryRow(customer_id: ID, source: ImportSource, sm: HistSummaryInput, import_id: ID): Omit<HistVisit, 'id'> {
  return { company_id: COMPANY_ID, store_id: STORE_ID, customer_id, kind: 'summary', visited_on: null, first_visit_on: sm.first_visit_on ?? null, last_visit_on: sm.last_visit_on ?? null,
    visit_count: sm.visit_count ?? null, staff_name: sm.staff_name ?? null, menu_text: null, amount: null, slip_no: null, source, dedupe_key: `summary:${customer_id}`, import_id };
}

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
  // LINE連携（0015）。関数が無い（0015 未適用）ときは null
  async lineInfo(slug) { try { return await rpc<{ liff_id: string; basic_id?: string | null } | null>('public_line_info', { p_slug: slug }); } catch { return null; } },
  async lineMe(body) {
    try {
      const res = await fetch('/api/line/me', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { found?: boolean; name?: string; kana?: string; phone?: string; email?: string };
      return res.ok && j.found ? { found: true, name: j.name, kana: j.kana, phone: j.phone, email: j.email } : { found: false };
    } catch { return { found: false }; }
  },
  async linkLine(body) {
    const res = await fetch('/api/line/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; name?: string | null; basic_id?: string | null; message?: string };
    return res.ok ? { ok: !!j.ok, name: j.name, basic_id: j.basic_id } : { ok: false, message: j.message || `うまくいきませんでした（${res.status}）` };
  },
  // 0022（案B）：LINEの中の予約はサーバ経由（IDトークン → LINEのユーザーIDが本人）。失敗はブラウザの予約と同じ文言（errorText）で出せるように、DBのエラー名をそのまま投げる
  async lineBook(i) {
    const res = await fetch('/api/line/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      slug: i.slug, idToken: i.idToken, menu_id: i.menu_id, start_at: i.start_at, name: i.name, kana: i.kana, phone: i.phone, email: i.email, intake: i.intake,
      coupon_id: i.coupon_id || null, code: i.code || null, staff_id: i.staff_id || null, lang: i.lang, option_ids: i.option_ids?.length ? i.option_ids : undefined }) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; booking?: PublicBookingResult; line?: PublicLineResult };
    // 401＝LINE の本人確認（IDトークン）の期限切れなど。開き直しを案内する（監査 2026-11-15 M4 の文言だけ）
    if (res.status === 401) throw new Error('line_expired');
    if (!res.ok || !j.ok || !j.booking) throw new Error(j.message || (res.status === 503 ? 'not_ready' : `うまくいきませんでした（${res.status}）`));
    return { ...j.booking, line: j.line ?? { linked: true, customer_created: false } };
  },
  async lineMyBookings(body) {
    try {
      const res = await fetch('/api/line/my-bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; bookings?: PublicMyBooking[]; phone?: string | null };
      return res.ok && j.ok ? { bookings: j.bookings || [], phone: j.phone ?? null } : { bookings: [] };
    } catch { return { bookings: [] }; }
  },
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
      // 0012：旧POSから取り込んだ来店も「初来店」に数える（その日の12:00として扱う）
      if ((await caps()).import12) {
        const hs = must(await sb().from('historical_visits').select('customer_id, visited_on, first_visit_on, last_visit_on').eq('store_id', storeId).in('customer_id', c)) as { customer_id: ID; visited_on: string|null; first_visit_on: string|null; last_visit_on: string|null }[];
        hs.forEach(x => { for (const d of [x.visited_on, x.first_visit_on, x.last_visit_on]) if (d) put(x.customer_id, new Date(`${d}T12:00:00`).toISOString()); });
      }
    }
    return out;
}
