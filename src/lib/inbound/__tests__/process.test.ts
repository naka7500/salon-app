import { beforeAll, describe, expect, it } from "vitest";
import type { Booking, Menu, Shift, Staff, Store } from "@/lib/db/types";
import { ingestHpbMail, processStoredMail, ALERT_DOUBLE, resolveMenu, type InboundIO, type InboundMail, type HpbMapping, type HpbSettings } from "../process";
import { makeTestMail } from "../testMail";
import { ensureJst } from "../tz";
import * as F from "./fixtures";

beforeAll(() => ensureJst());

const S = "store-1";
const store: Store = { id: S, company_id: "c1", name: "テスト店舗（練習用）", business_type: "eyelash", open_time: "10:00", close_time: "19:00", slot_minutes: 15, room_count: 2, start_step_min: 30 };
const staff: Staff[] = [
  { id: "sA", company_id: "c1", name: "練習A", role: "manager", active: true, sort_order: 1 },
  { id: "sB", company_id: "c1", name: "練習B", role: "staff", active: true, sort_order: 2 },
];
const menus: Menu[] = [
  { id: "m1", store_id: S, name: "まつ毛パーマ", category: "technical", price: 6600, tax_rate: 0.1, duration_min: 60, interval_min: 10, sort_order: 1, active: true },
  { id: "m2", store_id: S, name: "マツエク 100本", category: "technical", price: 7700, tax_rate: 0.1, duration_min: 75, interval_min: 10, sort_order: 2, active: true },
  { id: "m4", store_id: S, name: "ペア まつ毛パーマ（2名様）", category: "technical", price: 13200, tax_rate: 0.1, duration_min: 60, interval_min: 10, sort_order: 4, active: true, people: 2 },
];
let n = 0;
function makeIO(opts: { shifts?: boolean; settings?: Partial<HpbSettings>; mappings?: HpbMapping[] } = {}) {
  const bookings: Booking[] = []; const mails: InboundMail[] = []; const notes: { kind: string; subject: string }[] = []; const customers: { id: string; name: string; kana: string | null; phone: string | null }[] = [];
  const shift = (sid: string, date: string): Shift => ({ id: `${sid}${date}`, store_id: S, staff_id: sid, date, kind: "work", start_time: "10:00", end_time: "19:00", is_store_closed: false, break_missed: false });
  const day = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
  const io: InboundIO = {
    store, staff, lanes: [], menus, mappings: opts.mappings || [],
    settings: { store_id: S, enabled: true, ...opts.settings },
    async shiftsOn(date) { return opts.shifts === false ? [] : staff.map(s => shift(s.id, date)); },
    async bookingsOn(date) { return bookings.filter(b => day(b.start_at) === date); },
    async bookingsByRef(ref) { return bookings.filter(b => b.external_ref === ref && b.channel === "hpb"); },
    async findCustomer(phone, kana) { return customers.find(c => (phone && c.phone === phone) || (!phone && kana && c.kana === kana))?.id ?? null; },
    async createCustomer(c) { const id = `cu${++n}`; customers.push({ id, ...c }); return id; },
    async insertBookings(rows) { const made = rows.map(r => ({ ...r, id: `b${++n}`, created_at: "", updated_at: "" } as Booking)); bookings.push(...made); return made; },
    async updateBooking(id, patch) { const b = bookings.find(x => x.id === id)!; Object.assign(b, patch); },
    async notify(x) { notes.push(x); },
    newId: () => `g${++n}`,
    async findMail(mid) { return mails.find(m => m.message_id === mid) ?? null; },
    async getMail(id) { return mails.find(m => m.id === id) ?? null; },
    async insertMail(m) { if (mails.some(x => x.message_id === m.message_id)) throw new Error("dup"); const r = { ...m, id: `mail${++n}`, created_at: new Date().toISOString() } as InboundMail; mails.push(r); return r; },
    async updateMail(id, patch) { Object.assign(mails.find(m => m.id === id)!, patch); },
  };
  return { io, bookings, mails, notes, customers };
}
const tm = (o: Parameters<typeof makeTestMail>[0]) => { const m = makeTestMail(o); return { ...m, messageId: `msg-${m.reservationNo}-${o.kind}-${++n}` }; };

describe("HPB取り込みの反映", () => {
  it("新規 → HPBの予約が1件入る（担当は空いている人）", async () => {
    const { io, bookings, notes, customers } = makeIO();
    const m = tm({ kind: "new", date: "2026-11-20", start: "13:00", minutes: 60, coupon: "【新規】まつ毛パーマ" });
    const r = await ingestHpbMail(io, m);
    expect(r.mail.status).toBe("done");
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ channel: "hpb", external_ref: m.reservationNo, menu_ids: ["m1"], status: "booked", alert: null });
    expect(new Date(bookings[0].start_at).toISOString()).toBe("2026-11-20T04:00:00.000Z");
    expect(new Date(bookings[0].end_at).getTime() - new Date(bookings[0].start_at).getTime()).toBe(70 * 60000);
    expect(["sA", "sB"]).toContain(bookings[0].staff_id);
    expect(customers).toHaveLength(1);
    expect(notes[0].kind).toBe("hpb_booking");
  });

  it("同じメール（messageId）は2回目は何もしない・同じ予約番号の新規も重複", async () => {
    const { io, bookings } = makeIO();
    const m = tm({ kind: "new", date: "2026-11-20", start: "13:00", minutes: 60, coupon: "まつ毛パーマ" });
    await ingestHpbMail(io, m);
    const r2 = await ingestHpbMail(io, m);
    expect(r2.duplicate).toBe(true);
    const r3 = await ingestHpbMail(io, { ...m, messageId: "other-id" });
    expect(r3.mail.status).toBe("duplicate");
    expect(bookings).toHaveLength(1);
  });

  it("ペアのクーポン → 2行・担当2人・同じ pair_group", async () => {
    const { io, bookings } = makeIO();
    await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-20", start: "15:00", minutes: 60, coupon: "【ペア】ペア まつ毛パーマ（2名様）" }));
    expect(bookings).toHaveLength(2);
    expect(new Set(bookings.map(b => b.staff_id)).size).toBe(2);
    expect(bookings[0].pair_group).toBeTruthy();
    expect(bookings[0].pair_group).toBe(bookings[1].pair_group);
    expect(bookings[1].customer_name).toContain("同行者");
    expect(bookings[0].menu_ids).toEqual(["m4"]);
  });

  it("空きが無い時間 → それでも入れて赤い印（ダブルブッキングの可能性）", async () => {
    const { io, bookings, notes } = makeIO();
    await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-20", start: "15:00", minutes: 60, coupon: "ペア まつ毛パーマ（2名様）" }));
    const r = await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-20", start: "15:30", minutes: 60, coupon: "まつ毛パーマ" }));
    expect(r.mail.status).toBe("warn");
    expect(r.outcome?.conflict).toBe(true);
    expect(bookings).toHaveLength(3);
    expect(bookings[2].alert).toBe(ALERT_DOUBLE);
    expect(bookings[2].staff_id).toBeTruthy();
    expect(notes.at(-1)!.subject).toContain("ダブルブッキング");
  });

  it("指名スタッフが空いていない → 指名の人に入れて赤い印", async () => {
    const { io, bookings } = makeIO();
    await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-20", start: "11:00", minutes: 60, coupon: "まつ毛パーマ", staff: "練習A" }));
    const r = await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-20", start: "11:30", minutes: 60, coupon: "まつ毛パーマ", staff: "練習A" }));
    expect(bookings[1].staff_id).toBe("sA");
    expect(bookings[1].nominated).toBe(true);
    expect(bookings[1].alert).toBe(ALERT_DOUBLE);
    expect(r.outcome?.warnings.join()).toContain("指名");
  });

  it("変更 → 同じ予約を移動（新しい行は作らない）、キャンセル → キャンセルに", async () => {
    const { io, bookings, notes } = makeIO();
    const n1 = tm({ kind: "new", date: "2026-11-20", start: "13:00", minutes: 60, coupon: "まつ毛パーマ" });
    await ingestHpbMail(io, n1);
    const r = await ingestHpbMail(io, tm({ kind: "change", date: "2026-11-21", start: "16:00", minutes: 60, coupon: "まつ毛パーマ", reservationNo: n1.reservationNo, prevDate: "2026-11-20", prevStart: "13:00" }));
    expect(r.mail.status).toBe("done");
    expect(bookings).toHaveLength(1);
    expect(new Date(bookings[0].start_at).toISOString()).toBe("2026-11-21T07:00:00.000Z");
    expect(bookings[0].note).toContain("HPB変更");
    const c = await ingestHpbMail(io, tm({ kind: "cancel", date: "2026-11-21", start: "16:00", minutes: 60, coupon: "x", reservationNo: n1.reservationNo }));
    expect(c.mail.status).toBe("done");
    expect(bookings[0].status).toBe("cancelled");
    expect(notes.map(x => x.kind)).toEqual(["hpb_booking", "hpb_change", "hpb_cancel"]);
    const c2 = await ingestHpbMail(io, tm({ kind: "cancel", date: "2026-11-21", start: "16:00", minutes: 60, coupon: "x", reservationNo: n1.reservationNo }));
    expect(c2.mail.status).toBe("duplicate");
  });

  it("S2：予約番号だけ合っていて、名前・電話が違うキャンセル・変更は反映しない（要確認）", async () => {
    const { io, bookings } = makeIO();
    const n1 = tm({ kind: "new", date: "2026-11-20", start: "13:00", minutes: 60, coupon: "まつ毛パーマ" });
    await ingestHpbMail(io, n1);
    const fake = await ingestHpbMail(io, tm({ kind: "cancel", date: "2026-11-20", start: "13:00", minutes: 60, coupon: "x", reservationNo: n1.reservationNo, name: "偽物 太郎", kana: "ニセモノ タロウ", phone: "080-1111-2222" }));
    expect(fake.mail.status).toBe("review");
    expect(bookings[0].status).toBe("booked");
    const mv = await ingestHpbMail(io, tm({ kind: "change", date: "2026-11-25", start: "10:00", minutes: 60, coupon: "まつ毛パーマ", reservationNo: n1.reservationNo, name: "偽物 太郎", kana: "ニセモノ タロウ", phone: "080-1111-2222" }));
    expect(mv.mail.status).toBe("review");
    expect(new Date(bookings[0].start_at).toISOString()).toBe("2026-11-20T04:00:00.000Z");
    // 新規として同じ予約番号・別の日時で送っても、名前・電話が違えば動かさない
    const nw = await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-26", start: "10:00", minutes: 60, coupon: "まつ毛パーマ", reservationNo: n1.reservationNo, name: "偽物 太郎", kana: "ニセモノ タロウ", phone: "080-1111-2222" }));
    expect(nw.mail.status).toBe("review");
    expect(bookings).toHaveLength(1);
    // 本人（電話一致）のキャンセルは反映
    const ok = await ingestHpbMail(io, tm({ kind: "cancel", date: "2026-11-20", start: "13:00", minutes: 60, coupon: "x", reservationNo: n1.reservationNo }));
    expect(ok.mail.status).toBe("done");
    expect(bookings[0].status).toBe("cancelled");
  });

  it("S2：customerInfo がある口では、電話が違っても名前（カナ）が合えば本人とみなす。名前も電話も無いメールは動かさない", async () => {
    const { io, bookings, customers } = makeIO();
    io.customerInfo = async id => { const c = customers.find(x => x.id === id); return c ? { name: c.name, kana: c.kana, phone: c.phone } : null; };
    const n1 = tm({ kind: "new", date: "2026-11-20", start: "13:00", minutes: 60, coupon: "まつ毛パーマ" });
    await ingestHpbMail(io, n1);
    const r = await ingestHpbMail(io, tm({ kind: "change", date: "2026-11-22", start: "11:00", minutes: 60, coupon: "まつ毛パーマ", reservationNo: n1.reservationNo, phone: "070-0000-0000" }));
    expect(r.mail.status).toBe("done");
    expect(new Date(bookings[0].start_at).toISOString()).toBe("2026-11-22T02:00:00.000Z");
  });

  it("S2：HPB以外（ネット予約など）の予約は、予約番号が同じでも触らない", async () => {
    const { io, bookings } = makeIO();
    io.bookingsByRef = async ref => bookings.filter(b => b.external_ref === ref);   // わざと channel を見ない口
    bookings.push({ id: "web1", store_id: S, customer_id: null, customer_name: "テスト 花子", staff_id: "sA", lane_id: null, start_at: "2026-11-20T04:00:00.000Z", end_at: "2026-11-20T05:00:00.000Z", status: "booked", channel: "own", external_ref: "BE99999999", menu_ids: [], nominated: false, created_at: "", updated_at: "" } as Booking);
    const r = await ingestHpbMail(io, tm({ kind: "cancel", date: "2026-11-20", start: "13:00", minutes: 60, coupon: "x", reservationNo: "BE99999999" }));
    expect(r.mail.status).toBe("warn");
    expect(bookings[0].status).toBe("booked");
  });

  it("ペアの予約をキャンセル → 2行ともキャンセル", async () => {
    const { io, bookings } = makeIO();
    const p = tm({ kind: "new", date: "2026-11-20", start: "15:00", minutes: 60, coupon: "ペア まつ毛パーマ（2名様）" });
    await ingestHpbMail(io, p);
    await ingestHpbMail(io, tm({ kind: "cancel", date: "2026-11-20", start: "15:00", minutes: 60, coupon: "x", reservationNo: p.reservationNo }));
    expect(bookings.every(b => b.status === "cancelled")).toBe(true);
  });

  it("読めないメールは要確認（台帳に入れない）→ 手で直すと入る", async () => {
    const { io, bookings, notes } = makeIO();
    const r = await ingestHpbMail(io, { messageId: "j1", ...F.J_NO_NUMBER });
    expect(r.mail.status).toBe("review");
    expect(bookings).toHaveLength(0);
    expect(notes.at(-1)!.kind).toBe("hpb_attention");
    const r2 = await processStoredMail(io, r.mail, { reservationNo: "BE12121212", menu_id: "m2" });
    expect(r2.mail.status).toBe("done");
    expect(bookings).toHaveLength(1);
    expect(bookings[0].menu_ids).toEqual(["m2"]);
  });

  it("予約ではないメールは要確認", async () => {
    const { io, bookings } = makeIO();
    const r = await ingestHpbMail(io, { messageId: "i1", ...F.I_UNKNOWN });
    expect(r.mail.status).toBe("review");
    expect(bookings).toHaveLength(0);
  });

  it("連携オフのときは取り込まず「無視」で残す", async () => {
    const { io, bookings, mails } = makeIO({ settings: { enabled: false } });
    await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-20", start: "13:00", minutes: 60, coupon: "まつ毛パーマ" }));
    expect(bookings).toHaveLength(0);
    expect(mails[0].status).toBe("ignored");
  });

  it("メニューが分からない → 予約は入れて「取込済・要確認」", async () => {
    const { io, bookings } = makeIO();
    const r = await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-20", start: "13:00", minutes: 45, coupon: "【新規】ラッシュリフト特別" }));
    expect(r.mail.status).toBe("warn");
    expect(bookings).toHaveLength(1);
    expect(bookings[0].menu_ids).toEqual([]);
    expect(new Date(bookings[0].end_at).getTime() - new Date(bookings[0].start_at).getTime()).toBe(45 * 60000);
  });

  it("対応表のルールが自動より優先・人数も指定できる", () => {
    const rules: HpbMapping[] = [{ id: "r1", store_id: S, kind: "menu", pattern: "ラッシュリフト", menu_id: "m1", people: null, sort_order: 1, active: true }, { id: "r2", store_id: S, kind: "menu", pattern: "親子", menu_id: "m1", people: 2, sort_order: 2, active: true }];
    expect(resolveMenu({ coupon: "【新規】ラッシュリフト特別", menu: null }, menus, rules).menu?.id).toBe("m1");
    expect(resolveMenu({ coupon: "親子でまつパ", menu: null }, menus, rules)).toMatchObject({ via: "rule", people: 2 });
    expect(resolveMenu({ coupon: "マツエク 100本 新規", menu: null }, menus, []).menu?.id).toBe("m2");
    expect(resolveMenu({ coupon: "なにか", menu: null }, menus, [], "m2")).toMatchObject({ via: "default" });
  });

  it("シフトが無い日でも、重なりが無ければ赤い印はつけない", async () => {
    const { io, bookings } = makeIO({ shifts: false });
    const r = await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-20", start: "13:00", minutes: 60, coupon: "まつ毛パーマ" }));
    expect(r.mail.status).toBe("done");
    expect(bookings[0].alert).toBeNull();
    expect(r.mail.action).toContain("シフトが入っていない");
  });

  it("同じお客様（電話が同じ）は名簿を増やさない", async () => {
    const { io, customers } = makeIO();
    await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-20", start: "11:00", minutes: 60, coupon: "まつ毛パーマ", phone: "090-1234-5678" }));
    await ingestHpbMail(io, tm({ kind: "new", date: "2026-11-27", start: "11:00", minutes: 60, coupon: "まつ毛パーマ", phone: "09012345678" }));
    expect(customers).toHaveLength(1);
  });
});
