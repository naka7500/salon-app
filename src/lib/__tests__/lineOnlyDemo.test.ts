import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { errorText } from "@/lib/web";

// 0026・監査 2026-11-15 S1/S4（デモ＝メモリ）：
//  ・店舗設定「LINEの中だけ」→ LINE以外のブラウザからの予約（createBooking）は断る。LINEの中の予約（lineBook）は通る
//  ・既定（設定なし）は今までどおり両方で受ける
//  ・予約完了のお知らせは既定オフ。オンにすると LINE受信箱に「デモ」として1件（実際には送らない）
//  ・LINEの中で開き直すと、自分の「ご予約中」が見える
const store: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; }, key: i => Object.keys(store)[i] ?? null, get length() { return Object.keys(store).length; },
  } as Storage;
});
afterAll(() => { delete (globalThis as { window?: unknown }).window; delete (globalThis as { localStorage?: unknown }).localStorage; });

const SLUG = "kokage-gotanda";
async function slotFor(dayOffset: number) {
  const { memoryPublicApi } = await import("@/lib/db/memory");
  const cat = (await memoryPublicApi.menus(SLUG))!;
  const menu = cat.menus.find(m => m.target !== "repeat" && m.people === 1 && !(m.option_group_ids?.length))!;
  const from = new Date(Date.now() + (3 + dayOffset) * 86400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + (12 + dayOffset) * 86400_000).toISOString().slice(0, 10);
  const av = (await memoryPublicApi.availability(SLUG, menu.id, from, to))!;
  const [date, times] = Object.entries(av.days).find(([, t]) => t.length)!;
  return { menu, start: new Date(`${date}T${times[0]}:00`).toISOString() };   // デモは端末の時刻で数える
}
const input = async (dayOffset: number, phone: string) => { const { menu, start } = await slotFor(dayOffset); return { slug: SLUG, menu_id: menu.id, start_at: start, name: "予約 花子", kana: "ヨヤク ハナコ", phone, email: "hanako@example.com", intake: [], lang: "ja" as const }; };

describe("デモ：ネット予約の受け方（0026）", () => {
  it("既定（設定なし）：今までどおり、LINE以外のブラウザからも予約できる。予約ページには line_only=false", async () => {
    const { memoryPublicApi } = await import("@/lib/db/memory");
    expect((await memoryPublicApi.storeInfo(SLUG))!.line_only).toBe(false);
    const r = await memoryPublicApi.createBooking(await input(0, "080-1000-0001"));
    expect(r.booking_no).toMatch(/^W/);
    expect(r).not.toHaveProperty("customer_id"); expect(r).not.toHaveProperty("booking_id");
  });
  it("「LINEの中だけ」にすると、LINE以外のブラウザからの予約は断る（予約もお客様も増えない）", async () => {
    const { memoryPublicApi, memoryRepo } = await import("@/lib/db/memory");
    await memoryRepo.updateStoreSettings({ web_booking_line_only: true });
    expect((await memoryPublicApi.storeInfo(SLUG))!.line_only).toBe(true);
    const n = (await memoryRepo.customers()).length;
    await expect(memoryPublicApi.createBooking(await input(1, "080-1000-0002"))).rejects.toThrow("line_only");
    expect((await memoryRepo.customers()).length).toBe(n);
    expect(errorText(new Error("line_only"), "ja")).toContain("LINE公式アカウントからだけ");
  });
  it("「LINEの中だけ」でも、LINEの中の予約は通る。予約完了のお知らせは既定オフ（何も送らない・返す形は今までどおり）", async () => {
    const { memoryPublicApi, memoryRepo } = await import("@/lib/db/memory");
    await memoryRepo.saveLineSettings({ enabled: true });
    expect((await memoryRepo.lineSettings())!.booked_enabled).toBeFalsy();
    const r = await memoryPublicApi.lineBook!({ ...(await input(2, "080-1000-0003")), idToken: "demo" });
    expect(r.line).toEqual({ linked: true, customer_created: true });
    expect(((await memoryRepo.lineMessages(200)) || []).filter(m => m.kind === "booked")).toEqual([]);
  });
  it("予約完了のお知らせをオン → 予約のたびに1件（デモ＝送らずに受信箱に残る・通数に数えない）。文面に日時とキャンセルのリンク", async () => {
    const { memoryPublicApi, memoryRepo } = await import("@/lib/db/memory");
    await memoryRepo.saveLineSettings({ booked_enabled: true });
    const r = await memoryPublicApi.lineBook!({ ...(await input(3, "080-1000-0003")), idToken: "demo" });
    expect(r.line).toEqual({ linked: true, customer_created: false, notice: "sent" });
    const logs = ((await memoryRepo.lineMessages(200)) || []).filter(m => m.kind === "booked");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ direction: "out", status: "demo", counted: false });
    expect(logs[0].text).toContain("ご予約ありがとうございます"); expect(logs[0].text).toContain(r.booking_no); expect(logs[0].text).toContain(`/r/${SLUG}/cancel/${r.cancel_token}`);
  });
  it("LINEの中で開き直すと、自分の「ご予約中」が見える（ほかの人の予約は出ない）。キャンセルするとリストから消える", async () => {
    const { memoryPublicApi } = await import("@/lib/db/memory");
    const mine = (await memoryPublicApi.lineMyBookings!({ slug: SLUG, idToken: "demo" })).bookings;
    expect(mine).toHaveLength(2);
    expect(mine.every(b => !!b.cancel_token && b.cancellable)).toBe(true);
    expect(mine[0].start_at < mine[1].start_at).toBe(true);
    await memoryPublicApi.cancelBooking(mine[0].cancel_token!);
    expect((await memoryPublicApi.lineMyBookings!({ slug: SLUG, idToken: "demo" })).bookings).toHaveLength(1);
    store["salon-app-demo-line-uid"] = "U" + "9".repeat(32);   // 別の人の LINE
    expect((await memoryPublicApi.lineMyBookings!({ slug: SLUG, idToken: "demo" })).bookings).toEqual([]);
  });
  it("「両方」に戻すと、ブラウザからも予約できる。「受け付けない」は準備中", async () => {
    const { memoryPublicApi, memoryRepo } = await import("@/lib/db/memory");
    await memoryRepo.updateStoreSettings({ web_booking_line_only: false });
    expect((await memoryPublicApi.createBooking(await input(4, "080-1000-0004"))).booking_no).toMatch(/^W/);
    const next = await input(5, "080-1000-0005");
    await memoryRepo.updateStoreSettings({ web_booking_enabled: false });
    expect(await memoryPublicApi.storeInfo(SLUG)).toBeNull();
    await expect(memoryPublicApi.createBooking(next)).rejects.toThrow("store_not_found");
    await memoryRepo.updateStoreSettings({ web_booking_enabled: true });
  });
});

describe("お客様向けのエラー文（監査 2026-11-15）", () => {
  it("通信が切れたとき：英語の内部の文言を出さず、電波の案内にする", () => {
    for (const m of ["Failed to fetch", "NetworkError when attempting to fetch resource.", "Load failed"]) {
      expect(errorText(new TypeError(m), "ja")).toBe("通信がうまくいきませんでした。電波の良いところで、もう一度お試しください。");
      expect(errorText(new TypeError(m), "en")).not.toContain(m);
    }
  });
  it("知らないエラー：英字だけの内部の文言は付けない。サーバの日本語の案内は添える", () => {
    expect(errorText(new Error("PGRST301 JWT expired"), "ja")).toBe("うまくいきませんでした。もう一度お試しください。");
    expect(errorText(new Error("この店舗のLINE連携は準備中です"), "ja")).toContain("（この店舗のLINE連携は準備中です）");
  });
  it("LINEの確認の期限切れは、開き直しを案内する", () => {
    expect(errorText(new Error("line_expired"), "ja")).toContain("LINEからこのページを開き直してください");
  });
  it("今までの文言は変わらない", () => {
    expect(errorText(new Error("slot_taken"), "ja")).toContain("たった今埋まりました");
    expect(errorText(new Error("too_many"), "ja")).toContain("お電話でご予約ください");
  });
});
