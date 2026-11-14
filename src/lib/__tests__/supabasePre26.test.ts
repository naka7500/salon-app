// 0026 がまだ流れていない本番DBでも、今までどおり動くこと（列が無いDBに新しい列を送らない・読めなくても落ちない）。
// 偽の Supabase（表ごとの「ある列」を決めて、無い列を読む・書くと本物と同じようにエラーを返す）で確かめる。
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const STORE = "aaaaaaaa-0000-0000-0000-000000000001";
let SCHEMA: Record<string, string[]> = {};
let ROWS: Record<string, Row[]> = {};
const writes: { table: string; op: string; body: Row }[] = [];
const rpcCalls: { fn: string; args: Row }[] = [];
let rpcResult: (fn: string, args: Row) => { data: unknown; error: { code?: string; message: string } | null } = () => ({ data: null, error: null });

function from(table: string) {
  let op: "select" | "update" | "insert" = "select"; let cols = "*"; let body: Row = {}; let single = false;
  const missing = (names: string[]) => names.find(c => c !== "*" && !(SCHEMA[table] || []).includes(c));
  const b = {
    select(c = "*") { if (op === "select") cols = c; return b; }, update(p: Row) { op = "update"; body = p; return b; }, insert(p: Row) { op = "insert"; body = p; return b; },
    eq() { return b; }, limit() { return b; }, order() { return b; }, maybeSingle() { single = true; return b; }, single() { single = true; return b; },
    then(res: (v: unknown) => unknown) {
      if (!SCHEMA[table]) return Promise.resolve({ data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } }).then(res);
      if (op === "select") {
        const bad = missing(cols.split(",").map(x => x.trim()));
        if (bad) return Promise.resolve({ data: null, error: { code: "42703", message: `column ${table}.${bad} does not exist` } }).then(res);
        const rows = ROWS[table] || [];
        return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null }).then(res);
      }
      const bad = missing(Object.keys(body));
      if (bad) return Promise.resolve({ data: null, error: { code: "PGRST204", message: `Could not find the '${bad}' column of '${table}' in the schema cache` } }).then(res);
      writes.push({ table, op, body });
      const row = (ROWS[table] ||= [{}])[0]; Object.assign(row, body);
      return Promise.resolve({ data: single ? row : [row], error: null }).then(res);
    },
  };
  return b;
}
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ from, rpc: (fn: string, args: Row) => { rpcCalls.push({ fn, args }); return Promise.resolve(rpcResult(fn, args)); } }) }));

const BASE: Record<string, string[]> = {
  coupons: ["id"], shifts: ["break_start"], staff: ["show_on_ledger"], option_groups: ["id"], store_goals: ["store_id"], companies: ["legal_name"],
  stores: ["id", "company_id", "name", "last_order_offset_min", "ledger_menu_ids", "web_booking_enabled", "slug", "phone", "cancel_deadline_time"],
  line_channels: ["store_id", "enabled", "channel_id", "login_channel_id", "liff_id", "confirm_enabled", "confirm_time", "revisit_enabled", "revisit_time", "revisit_vacancy_only", "vacancy_threshold", "ack_enabled", "templates", "plan_limit", "updated_at"],
};
async function load(with26: boolean) {
  vi.resetModules();
  SCHEMA = JSON.parse(JSON.stringify(BASE));
  if (with26) { SCHEMA.stores.push("web_booking_line_only"); SCHEMA.line_channels.push("booked_enabled"); }
  ROWS = { stores: [{ id: STORE, name: "ラシエル箱崎", web_booking_enabled: true, ...(with26 ? { web_booking_line_only: false } : {}) }], line_channels: [{ store_id: STORE, enabled: false, confirm_time: "18:00:00", revisit_time: "11:00:00", ...(with26 ? { booked_enabled: false } : {}) }] };
  writes.length = 0; rpcCalls.length = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://fake"; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "fake"; process.env.NEXT_PUBLIC_STORE_ID = STORE;
  return import("@/lib/db/supabase");
}
beforeEach(() => { rpcResult = () => ({ data: null, error: null }); });

describe("0026 がまだ流れていない本番DB", () => {
  it("「0026 はまだ」と分かる（設定画面は切り替えを「準備中」にする）", async () => {
    const { supabaseRepo } = await load(false);
    expect((await supabaseRepo.capabilities()).v26).toBe(false);
    expect((await supabaseRepo.capabilities()).v15).toBe(true);
  });
  it("店舗設定の保存：今までの項目はそのまま保存できる（新しい列は送らない）", async () => {
    const { supabaseRepo } = await load(false);
    await supabaseRepo.updateStoreSettings({ web_booking_enabled: true, phone: "092-000-0000" });
    expect(writes).toEqual([{ table: "stores", op: "update", body: { web_booking_enabled: true, phone: "092-000-0000" } }]);
  });
  it("「LINEの中だけ」を保存しようとしたら、DB に送る前に分かる文で止める", async () => {
    const { supabaseRepo } = await load(false);
    await expect(supabaseRepo.updateStoreSettings({ web_booking_line_only: true })).rejects.toThrow("DB更新（0026）の後に使えます");
    expect(writes).toEqual([]);
  });
  it("LINE設定の保存：予約完了のお知らせがオフのままなら、今までどおり保存できる（booked_enabled は送らない）", async () => {
    const { supabaseRepo } = await load(false);
    const r = await supabaseRepo.saveLineSettings({ confirm_enabled: true, booked_enabled: false, templates: {} });
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ confirm_enabled: true }); expect(writes[0].body).not.toHaveProperty("booked_enabled");
    expect(r.confirm_enabled).toBe(true); expect(r.booked_enabled).toBeFalsy();
  });
  it("予約完了のお知らせをオンにしようとしたら、分かる文で止める（何も保存しない）", async () => {
    const { supabaseRepo } = await load(false);
    await expect(supabaseRepo.saveLineSettings({ booked_enabled: true })).rejects.toThrow("DB更新（0026）の後に使えます");
    expect(writes).toEqual([]);
  });
  it("LINE設定を読む：booked_enabled が無くても落ちない（オフ扱い）", async () => {
    const { supabaseRepo } = await load(false);
    const s = await supabaseRepo.lineSettings();
    expect(s).toMatchObject({ store_id: STORE, enabled: false, confirm_time: "18:00" }); expect(s!.booked_enabled).toBeFalsy();
  });
  it("予約ページ：店舗の情報に line_only が無い → 今までどおり（LINEとWebの両方）。ブラウザの予約は今までと同じ関数・同じ引数", async () => {
    const { supabasePublicApi } = await load(false);
    rpcResult = fn => fn === "public_store_info" ? { data: { slug: "laciel-hakozaki", name: "ラシエル箱崎", today: "2026-11-15" }, error: null } : { data: { booking_no: "W1" }, error: null };
    const st = await supabasePublicApi.storeInfo("laciel-hakozaki");
    expect(st).not.toHaveProperty("line_only"); expect(!!st!.line_only).toBe(false);
    await supabasePublicApi.createBooking({ slug: "laciel-hakozaki", menu_id: "m", start_at: "2026-12-01T15:00:00+09:00", name: "a", kana: "b", phone: "c", email: "d", intake: [], lang: "ja" });
    expect(rpcCalls[1]).toEqual({ fn: "public_create_booking", args: { p_slug: "laciel-hakozaki", p_menu: "m", p_start: "2026-12-01T15:00:00+09:00", p_name: "a", p_kana: "b", p_phone: "c", p_email: "d", p_intake: [], p_coupon: null, p_code: null, p_staff: null, p_lang: "ja" } });
  });
});

describe("0026 を流したあと", () => {
  it("受け方（LINEの中だけ）と予約完了のお知らせを保存できる", async () => {
    const { supabaseRepo } = await load(true);
    expect((await supabaseRepo.capabilities()).v26).toBe(true);
    await supabaseRepo.updateStoreSettings({ web_booking_enabled: true, web_booking_line_only: true });
    const r = await supabaseRepo.saveLineSettings({ booked_enabled: true });
    expect(writes[0]).toEqual({ table: "stores", op: "update", body: { web_booking_enabled: true, web_booking_line_only: true } });
    expect(writes[1].body).toMatchObject({ booked_enabled: true }); expect(r.booked_enabled).toBe(true);
  });
  it("DB が「LINEの中だけ」で断ったとき、予約ページは分かる文を出す", async () => {
    const { supabasePublicApi } = await load(true);
    const { errorText } = await import("@/lib/web");
    rpcResult = () => ({ data: null, error: { code: "P0001", message: "line_only" } });
    const e = await supabasePublicApi.createBooking({ slug: "laciel-hakozaki", menu_id: "m", start_at: "2026-12-01T15:00:00+09:00", name: "a", kana: "b", phone: "c", email: "d", intake: [], lang: "ja" }).catch(x => x);
    expect(errorText(e, "ja")).toContain("LINE公式アカウントからだけ");
  });
});
