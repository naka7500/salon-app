// LINE連携のメモリ版の IO（単体テストとデモで使う）。本番はサーバ（line/server.ts）がサービスキーで同じことをする。
import type { Booking, Customer, HistVisit, ID, Menu, Sale } from "@/lib/db/types";
import type { LineIO, LineStoreInfo } from "./engine";
import { jst } from "./engine";
import type { LineLink, LineMessage, LineQueueItem, LineSettings } from "./types";

export interface LineMemState {
  links: LineLink[]; messages: LineMessage[]; queue: LineQueueItem[];
  notices: { booking_id?: ID | null; kind: string; subject: string; body: string; at: string }[];
}
export const emptyLineState = (): LineMemState => ({ links: [], messages: [], queue: [], notices: [] });

export interface MemoryLineSource {
  store: LineStoreInfo; settings: LineSettings; menus: Menu[];
  bookings: Booking[]; customers: Customer[]; sales: Sale[]; hist?: HistVisit[];
  line: LineMemState; now?: () => Date; bookingUrl?: string | null;
  /** 空き率（デモは月の空き率の計算を渡す） */ vacancy?: (from: string, days: number) => number | null;
  newId?: () => string;
}

let seq = 0;
const defId = () => (typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto ? globalThis.crypto.randomUUID() : `id-${Date.now()}-${++seq}`);

export function memoryLineIO(src: MemoryLineSource): LineIO {
  const now = src.now ?? (() => new Date());
  const L = src.line; const nid = src.newId ?? defId;
  const jstDate = (iso: string) => jst(new Date(iso)).date;
  return {
    store: src.store, settings: src.settings, menus: src.menus, now,
    bookingUrl: () => src.bookingUrl ?? null,
    async linkByUser(uid) { return L.links.find(l => l.store_id === src.store.id && l.line_user_id === uid) ?? null; },
    async linkOfCustomer(cid) { return L.links.find(l => l.store_id === src.store.id && l.customer_id === cid) ?? null; },
    async saveLink(p) {
      let l = L.links.find(x => x.store_id === src.store.id && x.line_user_id === p.line_user_id);
      if (p.customer_id) for (const o of L.links) if (o !== l && o.store_id === src.store.id && o.customer_id === p.customer_id) o.customer_id = null;   // 1人のお客様に1つ
      if (!l) { l = { id: nid(), store_id: src.store.id, line_user_id: p.line_user_id, followed: true, opted_out: false, created_at: now().toISOString() }; L.links.push(l); }
      Object.assign(l, p, { updated_at: now().toISOString() });
      return l;
    },
    async booking(id) { return src.bookings.find(b => b.id === id) ?? null; },
    async setBookingConfirm(b, a) {
      const at = now().toISOString();
      for (const x of src.bookings) if (x.id === b.id || (b.pair_group && x.pair_group === b.pair_group)) { x.line_confirm = a; x.line_confirm_at = at; }
    },
    async customerName(cid) { return src.customers.find(c => c.id === cid)?.name ?? null; },
    async bookingsOn(date) { return src.bookings.filter(b => b.store_id === src.store.id && jstDate(b.start_at) === date); },
    async lastVisits(ids) {
      const want = new Set(ids); const best = new Map<ID, { date: string; menu_ids: ID[] }>();
      const put = (cid: ID | null | undefined, date: string, menu_ids: ID[]) => { if (!cid || !want.has(cid)) return; const cur = best.get(cid); if (!cur || date > cur.date) best.set(cid, { date, menu_ids }); };
      for (const s of src.sales) if (s.store_id === src.store.id && s.status === "confirmed") put(s.customer_id, jstDate(s.sold_at), s.lines.filter(l => l.menu_id).map(l => l.menu_id!) );
      for (const b of src.bookings) if (b.store_id === src.store.id && b.status === "done") put(b.customer_id, jstDate(b.start_at), b.menu_ids);
      for (const h of src.hist ?? []) if (h.store_id === src.store.id) { const d = h.visited_on || h.last_visit_on; if (d) put(h.customer_id, d, []); }
      return [...best.entries()].map(([customer_id, v]) => ({ customer_id, ...v }));
    },
    async futureBookingCustomers(ids) { const want = new Set(ids); const t = now().getTime(); return new Set(src.bookings.filter(b => b.store_id === src.store.id && b.customer_id && want.has(b.customer_id) && (b.status === "booked" || b.status === "arrived") && Date.parse(b.start_at) > t).map(b => b.customer_id!)); },
    async sendableLinks() { return L.links.filter(l => l.store_id === src.store.id && l.followed && !l.opted_out && l.customer_id); },
    async vacancyRate(from, days) { return src.vacancy ? src.vacancy(from, days) : null; },
    async hasEvent(eid) { return L.messages.some(m => m.store_id === src.store.id && m.event_id === eid); },
    async logMessage(m) { L.messages.push({ ...m, id: nid(), created_at: now().toISOString() } as LineMessage); },
    async notifyStaff(n) { L.notices.push({ ...n, at: now().toISOString() }); },
    async lastOutAt(uid, kind) { const xs = L.messages.filter(m => m.store_id === src.store.id && m.line_user_id === uid && m.direction === "out" && m.kind === kind && m.status !== "failed"); return xs.length ? xs[xs.length - 1].created_at : null; },
    async enqueue(items) { let n = 0; for (const it of items) { if (L.queue.some(q => q.dedupe_key === it.dedupe_key)) continue; L.queue.push({ ...it, id: nid(), status: "queued", attempts: 0, created_at: now().toISOString() }); n++; } return n; },
    async queued(limit) { return L.queue.filter(q => q.store_id === src.store.id && q.status === "queued").slice(0, limit); },
    async claim(id) { const q = L.queue.find(x => x.id === id); if (!q || q.status !== "queued") return false; q.status = "sending"; return true; },
    async finish(id, p) { const q = L.queue.find(x => x.id === id); if (q) Object.assign(q, p); },
    async monthCount() { const ym = jst(now()).date.slice(0, 7); return L.messages.filter(m => m.store_id === src.store.id && m.direction === "out" && m.counted && jst(new Date(m.created_at)).date.slice(0, 7) === ym).length; },
  };
}
