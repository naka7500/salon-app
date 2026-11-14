// 0026・監査 2026-11-15：予約完了のお知らせ（S4）と、前日確認の「1日遅れ」を送らない（M7）。メモリ版の IO で確かめる（本物の LINE には送らない）
import { describe, it, expect } from "vitest";
import type { Booking, Customer, Menu } from "@/lib/db/types";
import { buildBooked, planConfirm, processQueue, sampleMessages, sendBookedNotice, type LineSender } from "@/lib/line/engine";
import { memoryLineIO, emptyLineState, type MemoryLineSource } from "@/lib/line/memoryIO";
import { checkTemplate, DEFAULT_TEMPLATES, TEMPLATE_VARS, previewText } from "@/lib/line/templates";
import { defaultLineSettings } from "@/lib/line/types";

const STORE = "s1", UID = "U" + "1".repeat(32), CUST = "c1", BK = "11111111-1111-4111-8111-111111111111";
const menus = [{ id: "m1", store_id: STORE, name: "まつげエクステ80本", category: "technical", price: 6000, duration_min: 60 }] as unknown as Menu[];
function setup(over: Partial<ReturnType<typeof defaultLineSettings>> = {}, now = "2026-12-01T03:00:00Z") {
  const src: MemoryLineSource = {
    store: { id: STORE, name: "ラシエル箱崎", phone: "092-000-0000", slug: "laciel-hakozaki", business_type: "eyelash" },
    settings: { ...defaultLineSettings(STORE), ...over }, menus,
    bookings: [{ id: BK, store_id: STORE, customer_id: CUST, start_at: "2026-12-03T05:00:00Z", end_at: "2026-12-03T06:00:00Z", status: "booked", channel: "own", menu_ids: ["m1"], nominated: false, created_at: now, updated_at: now } as Booking],
    customers: [{ id: CUST, company_id: "co", name: "山田 花子", created_at: now } as Customer], sales: [], line: emptyLineState(), now: () => new Date(now),
  };
  src.line.links.push({ id: "l1", store_id: STORE, line_user_id: UID, customer_id: CUST, followed: true, opted_out: false, linked_via: "line_id", linked_at: now });
  const sent: { to: string; text: string; key: string }[] = [];
  const sender: LineSender = { async push(to, msgs, key) { sent.push({ to, text: previewText(msgs), key }); }, async reply() {} };
  return { src, io: memoryLineIO(src), sender, sent };
}
const V = { booking_id: BK, customer_id: CUST, line_user_id: UID, name: "山田 花子", start_at: "2026-12-03T05:00:00Z", menu: "まつげエクステ80本", no: "W261201-ABCDE", url: "https://app.example/r/laciel-hakozaki/cancel/" + "f".repeat(64) };

describe("予約完了のお知らせ（0026）", () => {
  it("既定の設定（全部オフ）では送らない", async () => {
    const { io, sender, sent, src } = setup();
    expect(defaultLineSettings(STORE).booked_enabled).toBeUndefined();
    expect(await sendBookedNotice(io, sender, V)).toBe("off");
    expect(sent).toEqual([]); expect(src.line.messages).toEqual([]);
  });
  it("「LINE連携を使う」だけオン（予約完了のお知らせはオフ）→ 送らない", async () => {
    const { io, sender, sent } = setup({ enabled: true });
    expect(await sendBookedNotice(io, sender, V)).toBe("off"); expect(sent).toEqual([]);
  });
  it("「予約完了のお知らせ」だけオン（LINE連携がオフ）→ 送らない", async () => {
    const { io, sender, sent } = setup({ enabled: false, booked_enabled: true });
    expect(await sendBookedNotice(io, sender, V)).toBe("off"); expect(sent).toEqual([]);
  });
  it("両方オン → その人の LINE に1通。日時（日本時間）・メニュー・店名・予約番号・キャンセルのリンク・電話が入る", async () => {
    const { io, sender, sent, src } = setup({ enabled: true, booked_enabled: true });
    expect(await sendBookedNotice(io, sender, V)).toBe("sent");
    expect(sent).toHaveLength(1); expect(sent[0].to).toBe(UID); expect(sent[0].key).toBe(BK);
    const t = sent[0].text;
    expect(t).toContain("山田 花子様"); expect(t).toContain("12月3日（木） 14:00〜"); expect(t).toContain("まつげエクステ80本"); expect(t).toContain("ラシエル箱崎");
    expect(t).toContain("W261201-ABCDE"); expect(t).toContain(V.url); expect(t).toContain("キャンセル"); expect(t).toContain("092-000-0000");
    expect(src.line.messages).toHaveLength(1);
    expect(src.line.messages[0]).toMatchObject({ kind: "booked", direction: "out", status: "sent", counted: true, booking_id: BK, customer_id: CUST });
  });
  it("同じ予約には1回だけ（2回目は送らない・通数も増えない）", async () => {
    const { io, sender, sent, src } = setup({ enabled: true, booked_enabled: true });
    expect(await sendBookedNotice(io, sender, V)).toBe("sent");
    expect(await sendBookedNotice(io, sender, V)).toBe("already");
    expect(sent).toHaveLength(1); expect(src.line.messages).toHaveLength(1); expect(await io.monthCount()).toBe(1);
  });
  it("友だちでない・お知らせを止めた・別のお客様のLINE → 送らない", async () => {
    const a = setup({ enabled: true, booked_enabled: true }); a.src.line.links[0].followed = false;
    expect(await sendBookedNotice(a.io, a.sender, V)).toBe("not_friend");
    const b = setup({ enabled: true, booked_enabled: true }); b.src.line.links[0].opted_out = true;
    expect(await sendBookedNotice(b.io, b.sender, V)).toBe("not_friend");
    const c = setup({ enabled: true, booked_enabled: true });
    expect(await sendBookedNotice(c.io, c.sender, { ...V, customer_id: "someone-else" })).toBe("not_friend");
    expect([...a.sent, ...b.sent, ...c.sent]).toEqual([]);
  });
  it("今月の通数が上限 → 送らない", async () => {
    const { io, sender, sent } = setup({ enabled: true, booked_enabled: true, plan_limit: 0 });
    expect(await sendBookedNotice(io, sender, V)).toBe("quota"); expect(sent).toEqual([]);
  });
  it("LINE が受け付けなかった → failed（例外にしない・通数に数えない・次は送り直せる）", async () => {
    const { io, src } = setup({ enabled: true, booked_enabled: true });
    const bad: LineSender = { async push() { throw new Error("LINE push 400: x"); }, async reply() {} };
    expect(await sendBookedNotice(io, bad, V)).toBe("failed");
    expect(src.line.messages[0]).toMatchObject({ kind: "booked", status: "failed", counted: false });
    expect(await io.sentForBooking(BK, "booked")).toBe(false);
  });
  it("アクセストークンが無い（送る人がいない）→ 送らない", async () => {
    const { io } = setup({ enabled: true, booked_enabled: true });
    expect(await sendBookedNotice(io, null, V)).toBe("off");
  });
  it("文面：既定は決まりを守っている・店舗ごとの文面が使われる・急がせる言葉や区切り線は保存できない", () => {
    expect(checkTemplate(DEFAULT_TEMPLATES.booked, "booked")).toEqual({ errors: [], warnings: [] });
    expect(TEMPLATE_VARS.booked).toEqual(expect.arrayContaining(["name", "date", "time", "menu", "store", "no", "url", "phone"]));
    const { io } = setup({ enabled: true, booked_enabled: true, templates: { booked: "{name}様\nご予約を承りました。\n◆日時　{date} {time}〜\n▶{url}" } });
    expect(buildBooked(io, V).preview).toBe(`山田 花子様\nご予約を承りました。\n◆日時　12月3日（木） 14:00〜\n▶${V.url}`);
    expect(checkTemplate("今だけ限定！ご予約ありがとうございます {url}", "booked").errors.join()).toContain("急がせる");
    expect(checkTemplate("ご予約ありがとうございます\n━━━━━━\n{url}", "booked").errors.join()).toContain("区切り線");
    expect(checkTemplate("{url}\n{url}", "booked").errors.join()).toContain("1つだけ");
    expect(checkTemplate("{days}日", "booked").errors.join()).toContain("{days}");
  });
  it("電話が未登録の店舗：「◆電話」の行ごと消える", () => {
    const { src } = setup({ enabled: true, booked_enabled: true }); src.store.phone = null;
    const t = buildBooked(memoryLineIO(src), V).preview;
    expect(t).not.toContain("◆電話"); expect(t).toContain("お電話でお知らせください");
  });
  it("設定画面の見本（試し送信・プレビュー）が作れる", () => {
    const { io } = setup();
    expect(previewText(sampleMessages(io, "booked", null))).toContain("ご予約ありがとうございます");
  });
});

describe("前日確認：1日遅れでは送らない（監査 M7）", () => {
  const sets = { enabled: true, confirm_enabled: true, confirm_time: "18:00" };
  it("前日の18時に送信待ちに入り、その日のうちの送り直しは送る", async () => {
    const x = setup(sets, "2026-12-02T09:30:00Z");   // 12/2 18:30（日本時間）。予約は 12/3 14:00
    expect((await planConfirm(x.io)).queued).toBe(1);
    expect(await processQueue(x.io, x.sender)).toMatchObject({ sent: 1, skipped: 0 });
  });
  it("送信に失敗して翌日（予約の当日）に持ち越した分は、送らずに止める", async () => {
    const x = setup(sets, "2026-12-02T09:30:00Z");
    expect((await planConfirm(x.io)).queued).toBe(1);
    const bad: LineSender = { async push() { throw new Error("LINE push 500"); }, async reply() {} };
    expect(await processQueue(x.io, bad)).toMatchObject({ sent: 0, failed: 1 });
    expect(x.src.line.queue[0].status).toBe("queued");
    const next = memoryLineIO({ ...x.src, now: () => new Date("2026-12-03T09:30:00Z") });   // 翌日 18:30（もう来店後）
    expect(await processQueue(next, x.sender)).toMatchObject({ sent: 0, skipped: 1 });
    expect(x.sent).toEqual([]);
    expect(x.src.line.queue[0]).toMatchObject({ status: "skipped", error: "前日を過ぎた（明日の予約ではない）" });
  });
});
