import { describe, it, expect } from "vitest";
import type { Booking, Customer, Menu, Sale } from "@/lib/db/types";
import { lineSignature, verifyLineSignature } from "@/lib/line/signature";
import { checkTemplate, renderTemplate, DEFAULT_TEMPLATES, parsePostback, postbackData, previewText, optKeyword } from "@/lib/line/templates";
import { handleEvents, planConfirm, planRevisit, processQueue, revisitDays, quotaState, type LineSender } from "@/lib/line/engine";
import { memoryLineIO, emptyLineState, type MemoryLineSource } from "@/lib/line/memoryIO";
import { defaultLineSettings } from "@/lib/line/types";

const SECRET = "0123456789abcdef0123456789abcdef";
describe("署名（X-Line-Signature）", () => {
  const body = JSON.stringify({ destination: "U1", events: [] });
  it("正しい署名は通る", () => expect(verifyLineSignature(body, SECRET, lineSignature(body, SECRET))).toBe(true));
  it("本文が1文字違う・鍵が違う・無い → 通らない", () => {
    const sig = lineSignature(body, SECRET);
    expect(verifyLineSignature(body + " ", SECRET, sig)).toBe(false);
    expect(verifyLineSignature(body, "f".repeat(32), sig)).toBe(false);
    expect(verifyLineSignature(body, SECRET, null)).toBe(false);
    expect(verifyLineSignature(body, null, sig)).toBe(false);
    expect(verifyLineSignature(body, SECRET, sig.slice(0, -2))).toBe(false);
  });
  it("openssl で計算した値と一致", () => expect(lineSignature("test", "secret")).toBe("Aymga2LNFrM+tnkr6MYLFY2Jou46h2/Omogeu0iMCRQ="));
});

describe("文面", () => {
  it("差し込み・空の差し込みの行は消す", () => {
    expect(renderTemplate("{name}様\n◆電話　{phone}\nよろしく", { name: "山田", phone: "" })).toBe("山田様\nよろしく");
  });
  it("既定の文面は決まりを守っている", () => { for (const [k, t] of Object.entries(DEFAULT_TEMPLATES)) expect(checkTemplate(t, k as never).errors).toEqual([]); });
  it("区切り線・急がせる言葉・リンク2つ・使えない差し込みは保存できない", () => {
    expect(checkTemplate("ご案内\nーーーーー\nです").errors.join()).toContain("区切り線");
    expect(checkTemplate("今だけ限定のご案内").errors.join()).toContain("急がせる");
    expect(checkTemplate("▶ {url}\nhttps://x.example/a").errors.join()).toContain("1つだけ");
    expect(checkTemplate("{foo}様", "ack").errors.join()).toContain("{foo}");
    expect(checkTemplate("★ご案内", "ack").warnings.join()).toContain("◆");
  });
  it("前日確認のボタン", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    expect(parsePostback(postbackData("ok", id))).toEqual({ answer: "ok", bookingId: id });
    expect(parsePostback("a=hack&b=" + id)).toBeNull();
    expect(parsePostback("a=ok&b=1;drop")).toBeNull();
  });
  it("配信停止・再開の言葉", () => { expect(optKeyword(" 配信停止 ")).toBe("stop"); expect(optKeyword("再開")).toBe("resume"); expect(optKeyword("停止したいです")).toBeNull(); });
  it("再来案内の日数の既定", () => {
    expect(revisitDays({ name: "90分サブリミックヘッドスパ" }, "headspa")).toBe(45);
    expect(revisitDays({ name: "90分育毛ヘッドスパ" }, "headspa")).toBe(30);
    expect(revisitDays({ name: "まつげパーマ" }, "eyelash")).toBe(42);
    expect(revisitDays({ name: "マツエク 120本" }, "eyelash")).toBe(24);
    expect(revisitDays({ name: "なんでも", revisit_days: 60 }, "eyelash")).toBe(60);
  });
  it("通数：80%で注意・100%で止める", () => { expect(quotaState(159, 200).level).toBe("ok"); expect(quotaState(160, 200).level).toBe("warn"); expect(quotaState(200, 200).level).toBe("stop"); });
});

// ---- 店・お客様・予約 ----
const STORE = "aaaaaaaa-0000-0000-0000-000000000001";
const U1 = "U" + "1".repeat(32), U2 = "U" + "2".repeat(32);
const menu: Menu = { id: "m1", store_id: STORE, name: "90分ヘッドスパ", category: "technical", price: 13200, tax_rate: 0.1, duration_min: 90, interval_min: 0, sort_order: 1, active: true };
const cust = (id: string, name: string): Customer => ({ id, company_id: "c", name, created_at: "" });
// 2026-11-07 18:05 JST
const NOW = new Date("2026-11-07T09:05:00Z");
const bk = (id: string, cid: string | null, startIso: string, o: Partial<Booking> = {}): Booking => ({ id, store_id: STORE, customer_id: cid, start_at: startIso, end_at: new Date(Date.parse(startIso) + 5400_000).toISOString(), status: "booked", channel: "own", menu_ids: ["m1"], nominated: false, created_at: "", updated_at: "", ...o });
function world(over: Partial<ReturnType<typeof defaultLineSettings>> = {}) {
  const settings = { ...defaultLineSettings(STORE), enabled: true, confirm_enabled: true, revisit_enabled: true, ...over };
  const bookings = [
    bk("11111111-1111-1111-1111-111111111111", "c1", "2026-11-08T05:00:00Z"),        // 明日 14:00 JST
    bk("22222222-2222-2222-2222-222222222222", "c2", "2026-11-08T06:00:00Z"),        // 明日（c2 はお知らせ停止）
    bk("33333333-3333-3333-3333-333333333333", "c3", "2026-11-09T06:00:00Z"),        // あさって
  ];
  const sales: Sale[] = [
    { id: "s1", store_id: STORE, customer_id: "c4", sale_no: "1", sold_at: "2026-09-20T05:00:00Z", status: "confirmed", subtotal: 0, discount: 0, tax: 0, total: 0, lines: [{ id: "l", sale_id: "s1", kind: "menu", menu_id: "m1", name: "", unit_price: 0, qty: 1, tax_rate: 0.1, amount: 0 }], payments: [] },  // 48日前
    { id: "s2", store_id: STORE, customer_id: "c5", sale_no: "2", sold_at: "2026-06-01T05:00:00Z", status: "confirmed", subtotal: 0, discount: 0, tax: 0, total: 0, lines: [], payments: [] },   // 159日前（幅の外）
  ];
  const line = emptyLineState();
  line.links.push({ id: "L1", store_id: STORE, customer_id: "c1", line_user_id: U1, followed: true, opted_out: false },
    { id: "L2", store_id: STORE, customer_id: "c2", line_user_id: U2, followed: true, opted_out: true, opt_out_reason: "customer" },
    { id: "L4", store_id: STORE, customer_id: "c4", line_user_id: "U" + "4".repeat(32), followed: true, opted_out: false },
    { id: "L5", store_id: STORE, customer_id: "c5", line_user_id: "U" + "5".repeat(32), followed: true, opted_out: false });
  const src: MemoryLineSource = { store: { id: STORE, name: "KOKAGE西五反田", phone: "03-0000-0000", business_type: "headspa" }, settings, menus: [menu], bookings,
    customers: [cust("c1", "山田"), cust("c2", "佐藤"), cust("c4", "鈴木"), cust("c5", "田中")], sales, line, now: () => NOW, bookingUrl: "https://example.test/r/kokage-gotanda" };
  const sent: { to: string; key: string; text: string }[] = []; const replies: string[] = [];
  const sender: LineSender = { async push(to, msgs, key) { sent.push({ to, key, text: previewText(msgs) }); }, async reply(_t, msgs) { replies.push(previewText(msgs)); } };
  return { io: memoryLineIO(src), src, sent, replies, sender, line };
}

describe("前日確認：送信待ちは1回だけ・停止した人には送らない", () => {
  it("明日の予約・つながっていて停止していない人だけ", async () => {
    const w = world();
    const r = await planConfirm(w.io);
    expect(r.queued).toBe(1);
    expect(w.line.queue[0].dedupe_key).toBe("confirm:11111111-1111-1111-1111-111111111111");
    expect(w.line.queue[0].payload.preview).toContain("山田様");
    expect(w.line.queue[0].payload.preview).toContain("11月8日（日） 14:00〜");
    expect(w.line.queue[0].payload.preview).toContain("［予定どおり伺います］");
  });
  it("何度動いても二重にならない（送信待ち・送信とも）", async () => {
    const w = world();
    await planConfirm(w.io); await planConfirm(w.io);
    expect(w.line.queue.length).toBe(1);
    expect(await processQueue(w.io, w.sender)).toMatchObject({ sent: 1 });
    await planConfirm(w.io);
    expect(await processQueue(w.io, w.sender)).toMatchObject({ sent: 0 });
    expect(w.sent.length).toBe(1); expect(w.sent[0].key).toBe(w.line.queue[0].id);
  });
  it("送る時刻の前・夜・オフは送らない", async () => {
    expect((await planConfirm(world({ confirm_time: "19:00" }).io)).skipped).toContain("前");
    expect((await planConfirm(world({ enabled: false }).io)).skipped).toContain("オフ");
    expect((await planConfirm(world({ confirm_enabled: false }).io)).skipped).toContain("オフ");
  });
  it("送る直前にお知らせ停止になったら送らない", async () => {
    const w = world();
    await planConfirm(w.io);
    w.line.links[0].opted_out = true;
    expect(await processQueue(w.io, w.sender)).toMatchObject({ sent: 0, skipped: 1 });
    expect(w.sent.length).toBe(0);
  });
  it("失敗は3回まで（そのあと failed）", async () => {
    const w = world(); await planConfirm(w.io);
    const bad: LineSender = { async push() { throw new Error("500"); }, async reply() {} };
    for (let i = 0; i < 4; i++) await processQueue(w.io, bad);
    expect(w.line.queue[0].status).toBe("failed"); expect(w.line.queue[0].attempts).toBe(3);
  });
});

describe("再来案内", () => {
  it("日数を過ぎて30日以内・この先の予約なし・停止していない人だけ", async () => {
    const w = world({ revisit_time: "11:00" });
    const r = await planRevisit(w.io);
    expect(r.queued).toBe(1);
    expect(w.line.queue[0].customer_id).toBe("c4");
    expect(w.line.queue[0].payload.preview).toContain("48日");
    expect((w.line.queue[0].payload.preview.match(/https:\/\//g) || []).length).toBe(1);
    await planRevisit(w.io); expect(w.line.queue.length).toBe(1);   // 同じ回は1回だけ
  });
  it("通数が上限なら止める", async () => {
    const w = world({ plan_limit: 0 });
    expect((await planRevisit(w.io)).skipped).toContain("上限");
  });
  it("空き率が低ければ見送り", async () => {
    const w = world({ revisit_vacancy_only: true, vacancy_threshold: 50 });
    w.src.vacancy = () => 0.2; expect((await planRevisit(memoryLineIO(w.src))).skipped).toContain("見送り");
    w.src.vacancy = () => 0.7; expect((await planRevisit(memoryLineIO(w.src))).queued).toBe(1);
  });
});

describe("Webhook のイベント", () => {
  it("友だち追加・ブロック（停止）・追加し直し（再開）", async () => {
    const w = world(); const U9 = "U" + "9".repeat(32);
    await handleEvents(w.io, w.sender, [{ type: "follow", webhookEventId: "e1", source: { type: "user", userId: U9 } }]);
    expect(w.line.links.find(l => l.line_user_id === U9)?.followed).toBe(true);
    await handleEvents(w.io, w.sender, [{ type: "unfollow", webhookEventId: "e2", source: { type: "user", userId: U9 } }]);
    expect(w.line.links.find(l => l.line_user_id === U9)).toMatchObject({ followed: false, opted_out: true, opt_out_reason: "unfollow" });
    await handleEvents(w.io, w.sender, [{ type: "follow", webhookEventId: "e3", source: { type: "user", userId: U9 } }]);
    expect(w.line.links.find(l => l.line_user_id === U9)).toMatchObject({ followed: true, opted_out: false });
  });
  it("前日確認のボタン：本人の予約だけ記録・変更希望はスタッフへ通知・同じイベントは1回", async () => {
    const w = world(); const b = w.src.bookings[0];
    const ev = { type: "postback", webhookEventId: "p1", replyToken: "r", source: { type: "user", userId: U1 }, postback: { data: postbackData("change", b.id) } };
    await handleEvents(w.io, w.sender, [ev, ev]);
    expect(b.line_confirm).toBe("change");
    expect(w.line.notices.filter(n => n.kind === "line_change").length).toBe(1);
    expect(w.replies.length).toBe(1);
    // ほかの人の予約は押せない
    const other = w.src.bookings[1];
    await handleEvents(w.io, w.sender, [{ type: "postback", webhookEventId: "p2", source: { type: "user", userId: U1 }, postback: { data: postbackData("ok", other.id) } }]);
    expect(other.line_confirm).toBeUndefined();
  });
  it("メッセージは受信箱へ。自動のお礼は既定オフ。オフの店は返事しない", async () => {
    const w = world();
    await handleEvents(w.io, w.sender, [{ type: "message", webhookEventId: "m1", replyToken: "r", source: { type: "user", userId: U1 }, message: { type: "text", text: "明日遅れます" } }]);
    expect(w.line.messages.some(m => m.direction === "in" && m.text === "明日遅れます")).toBe(true);
    expect(w.replies.length).toBe(0);
    const w2 = world({ ack_enabled: true });
    await handleEvents(w2.io, w2.sender, [{ type: "message", webhookEventId: "m2", replyToken: "r", source: { type: "user", userId: U1 }, message: { type: "text", text: "a" } }, { type: "message", webhookEventId: "m3", replyToken: "r2", source: { type: "user", userId: U1 }, message: { type: "text", text: "b" } }]);
    expect(w2.replies.length).toBe(1);   // 12時間に1回
    const w3 = world({ enabled: false, ack_enabled: true });
    await handleEvents(w3.io, w3.sender, [{ type: "message", webhookEventId: "m4", replyToken: "r", source: { type: "user", userId: U1 }, message: { type: "text", text: "a" } }]);
    expect(w3.replies.length).toBe(0);
  });
  it("「配信停止」で停止・「配信再開」で再開", async () => {
    const w = world();
    await handleEvents(w.io, w.sender, [{ type: "message", webhookEventId: "s1", source: { type: "user", userId: U1 }, message: { type: "text", text: "配信停止" } }]);
    expect(w.line.links[0]).toMatchObject({ opted_out: true, opt_out_reason: "customer" });
    expect((await planConfirm(w.io)).queued).toBe(0);
    await handleEvents(w.io, w.sender, [{ type: "message", webhookEventId: "s2", source: { type: "user", userId: U1 }, message: { type: "text", text: "配信再開" } }]);
    expect(w.line.links[0].opted_out).toBe(false);
  });
});
