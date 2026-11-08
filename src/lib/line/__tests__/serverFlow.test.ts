// 本番の流れ（server.ts の handleBook・handleLink・handleLinkRequest）を、偽の Supabase（メモリの表＋偽の service_create_booking）と偽の LINE（fetch）で通す。
//  ・案B（0022）：LINE予約は LINE のユーザーIDが本人。知らない LINE が既存のお客様の電話番号で予約 → 新しいお客様・被害者には触れない
//  ・同じ LINE の2回目 → 同じお客様・前回入力が出る
//  ・残っている確認待ちの承認・却下（0020 の仕組み）はそのまま動く／会計のQR（token）も同じ
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const T: Record<string, Row[]> = {};
let seq = 0;
const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

/** supabase-js の使う形だけ（select/insert/update/upsert＋eq/neq/is/gt/gte/lt/in/not/limit/order/maybeSingle/single） */
function q(table: string) {
  const f: ((r: Row) => boolean)[] = [];
  let op: "select" | "insert" | "update" | "upsert" = "select", payload: Row | Row[] | null = null, conflict = "", head = false, count = false, one: "maybe" | "single" | null = null, lim = Infinity, returning = false;
  const rows = () => (T[table] ??= []);
  const b = {
    select(_c?: string, o?: { count?: string; head?: boolean }) { if (op === "select") { head = !!o?.head; count = !!o?.count; } else returning = true; return b; },
    insert(p: Row | Row[]) { op = "insert"; payload = p; return b; },
    update(p: Row) { op = "update"; payload = p; return b; },
    upsert(p: Row, o: { onConflict: string }) { op = "upsert"; payload = p; conflict = o.onConflict; return b; },
    eq(k: string, v: unknown) { f.push(r => r[k] === v); return b; },
    neq(k: string, v: unknown) { f.push(r => r[k] !== v); return b; },
    is(k: string, v: unknown) { f.push(r => (r[k] ?? null) === v); return b; },
    gt(k: string, v: string) { f.push(r => String(r[k]) > v); return b; },
    gte(k: string, v: string) { f.push(r => String(r[k]) >= v); return b; },
    lt(k: string, v: string) { f.push(r => String(r[k]) < v); return b; },
    lte(k: string, v: string) { f.push(r => String(r[k]) <= v); return b; },
    in(k: string, v: unknown[]) { f.push(r => v.includes(r[k])); return b; },
    not(k: string, _o: string, v: unknown) { f.push(r => (r[k] ?? null) !== v); return b; },
    order() { return b; }, limit(n: number) { lim = n; return b; },
    maybeSingle() { one = "maybe"; return b; }, single() { one = "single"; return b; },
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
  };
  function run(): { data: unknown; error: { message: string } | null; count?: number } {
    const match = () => rows().filter(r => f.every(fn => fn(r)));
    if (op === "select") {
      const m = match().slice(0, lim);
      if (head) return { data: null, error: null, count: m.length };
      if (one) return m.length > 1 ? { data: null, error: { message: "multiple rows" } } : { data: m[0] ?? null, error: null };
      return { data: m, error: null, ...(count ? { count: m.length } : {}) };
    }
    if (op === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload!]).map(p => ({ id: nid(), created_at: new Date().toISOString(), ...p }) as Row);
      if (table === "line_link_requests") for (const p of list) if (rows().some(r => r.status === "pending" && r.store_id === p.store_id && r.customer_id === p.customer_id && r.line_user_id === p.line_user_id)) return { data: null, error: { message: "duplicate key value violates unique constraint" } };
      if (table === "line_link_requests") for (const p of list) p.status ??= "pending";
      rows().push(...list); return { data: returning ? list : null, error: null };
    }
    if (op === "update") { const m = match(); m.forEach(r => Object.assign(r, payload)); return { data: returning ? m : null, error: null }; }
    // upsert
    const keys = conflict.split(","); const p = payload as Row;
    let r = rows().find(x => keys.every(k => x[k] === p[k]));
    if (r) Object.assign(r, p); else { r = { id: nid(), followed: true, opted_out: false, created_at: new Date().toISOString(), ...p }; rows().push(r); }
    if (table === "line_links" && rows().filter(x => x.customer_id && x.customer_id === r!.customer_id && x.store_id === r!.store_id).length > 1) return { data: null, error: { message: "duplicate key line_links_customer_key" } };
    return { data: one ? r : [r], error: null };
  }
  return b;
}
const USERS: Record<string, string> = {};   // jwt → auth user id
let rpcFail: { code?: string; message: string } | null = null;
const rpcCalls: Record<string, unknown>[] = [];
/** 偽の service_create_booking（0022）：そのLINEにつながったお客様がいればその人、いなければ新しいお客様＋つながり（line_id）。本物の確かめは SQL 側（使い捨てDBで別に確認） */
function rpc(fn: string, args: Record<string, unknown>) {
  rpcCalls.push({ fn, ...args });
  if (fn !== "service_create_booking") return Promise.resolve({ data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } });
  if (rpcFail) return Promise.resolve({ data: null, error: rpcFail });
  const store = (T.stores ?? []).find(s => s.slug === args.p_slug)!;
  let link = (T.line_links ??= []).find(l => l.store_id === store.id && l.line_user_id === args.p_line_user_id && l.customer_id);
  let created = false;
  if (!link) {
    const c = { id: nid(), company_id: store.company_id, name: args.p_name, kana: args.p_kana, phone: args.p_phone, email: args.p_email, merged_into: null };
    (T.customers ??= []).push(c); created = true;
    link = T.line_links.find(l => l.store_id === store.id && l.line_user_id === args.p_line_user_id);
    if (link) Object.assign(link, { customer_id: c.id, linked_via: "line_id", linked_at: new Date().toISOString() });
    else T.line_links.push(link = { id: nid(), store_id: store.id, line_user_id: args.p_line_user_id, customer_id: c.id, display_name: args.p_line_display_name, followed: true, opted_out: false, linked_via: "line_id", linked_at: new Date().toISOString() });
  }
  const others = (T.customers ?? []).filter(c => c.company_id === store.company_id && c.id !== link!.customer_id && !c.merged_into && String(c.phone).replace(/\D/g, "") === String(args.p_phone).replace(/\D/g, ""));
  const b = { id: nid(), store_id: store.id, customer_id: link.customer_id, created_at: new Date().toISOString(), customer_created: created, cancel_token: "f".repeat(64), booking_no: "W261109-TEST1", web_name: args.p_name, web_phone: args.p_phone, web_check: others.length ? "同じ電話番号のお客様がいます" : null, channel: "own" };
  (T.bookings ??= []).push(b);
  return Promise.resolve({ data: { booking_no: b.booking_no, cancel_token: b.cancel_token, start_at: args.p_start, end_at: args.p_start, menu_name: "メニュー", price: 5000, price_total: 5000, people: 1, store_name: store.name, deadline: args.p_start, customer_id: link.customer_id, customer_created: created, line_linked: true }, error: null });
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => q(t), rpc, auth: { getUser: async (jwt: string) => (USERS[jwt] ? { data: { user: { id: USERS[jwt] } }, error: null } : { data: { user: null }, error: { message: "bad jwt" } }) } }),
}));

const STORE = "aaaaaaaa-0000-0000-0000-000000000001", CO = "cccccccc-0000-0000-0000-000000000001", OTHER_CO = "cccccccc-0000-0000-0000-000000000002";
const VICTIM = "U" + "b".repeat(32), ATTACKER = "U" + "a".repeat(32), NEWBIE = "U" + "c".repeat(32);
const JWT = (u: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ u })).toString("base64url")}.c2lnbmF0dXJlLXNpZw`;
const pushes: { to: string; text: string }[] = [];
let idTokenUser = ATTACKER;

beforeEach(() => {
  for (const k of Object.keys(T)) delete T[k];
  pushes.length = 0; rpcCalls.length = 0; rpcFail = null;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://fake"; process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
  T.stores = [{ id: STORE, company_id: CO, name: "ラシエル箱崎", slug: "laciel-hakozaki", web_booking_enabled: true }];
  T.line_channels = [{ store_id: STORE, enabled: true, login_channel_id: "1234567", liff_id: "1234567-abcd", secret_set_at: "x", token_set_at: "x", plan_limit: 200, bot_basic_id: "@lh" }];
  T.line_channel_secrets = [{ store_id: STORE, channel_secret: "s", access_token: "tok" }];
  T.menus = []; T.line_messages = []; T.audit_logs = []; T.line_link_requests = []; T.line_link_tokens = []; T.companies = [{ id: CO, name: "BE.COLLECTION.5", legal_name: "株式会社BE.COLLECTION.5" }];
  T.customers = [{ id: "cust-victim", company_id: CO, name: "被害 花子", phone: "09012345678", email: "victim@example.com", merged_into: null },
                 { id: "cust-new", company_id: CO, name: "新規 太郎", phone: "08000000000", email: "n@example.com", merged_into: null }];
  T.line_links = [{ id: "link-victim", store_id: STORE, line_user_id: VICTIM, customer_id: "cust-victim", followed: true, opted_out: false, linked_at: "2026-11-01T00:00:00Z", linked_via: "token" }];
  const now = new Date(Date.now() - 60_000).toISOString();
  T.bookings = [{ id: "bk-existing", store_id: STORE, customer_id: "cust-victim", created_at: now, customer_created: false, cancel_token: "a".repeat(64) },
                { id: "bk-new", store_id: STORE, customer_id: "cust-new", created_at: now, customer_created: true, cancel_token: "b".repeat(64) }];
  T.staff = [{ id: "st-1", company_id: CO, auth_user_id: "auth-staff", name: "スタッフA", role: "staff", active: true },
             { id: "st-2", company_id: CO, auth_user_id: "auth-viewer", name: "閲覧B", role: "viewer", active: true },
             { id: "st-3", company_id: OTHER_CO, auth_user_id: "auth-other", name: "他社C", role: "owner", active: true },
             { id: "st-4", company_id: CO, auth_user_id: "auth-left", name: "退職D", role: "manager", active: false }];
  for (const u of ["auth-staff", "auth-viewer", "auth-other", "auth-left"]) USERS[JWT(u)] = u;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/oauth2/v2.1/verify")) return new Response(JSON.stringify({ sub: idTokenUser, name: idTokenUser === ATTACKER ? "あやしい人" : "本人" }), { status: 200 });
    if (url.endsWith("/v2/bot/message/push")) { const b = JSON.parse(String(init?.body)); pushes.push({ to: b.to, text: b.messages[0].text }); return new Response("{}", { status: 200 }); }
    return new Response("not found", { status: 404 });
  }));
});

const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eHh4eCJ9.c2lnbmF0dXJlLXh4eA";

const BOOK = { slug: "laciel-hakozaki", idToken: "", menu_id: "11111111-1111-4111-8111-111111111111", start_at: "2026-11-20T01:00:00.000Z", name: "攻撃者", kana: "コウゲキ", phone: "090-1234-5678", email: "evil@example.com", intake: [], lang: "ja" as const };
/** 0022 より前の確認待ちが残っている状態（LINE予約からは作られなくなった） */
function seedRequest(lineUserId = ATTACKER, name = "あやしい人") {
  const id = `11111111-0000-4000-8000-${String(T.line_link_requests.length + 1).padStart(12, "0")}`;
  T.line_link_requests.push({ id, store_id: STORE, customer_id: "cust-victim", booking_id: "bk-existing", line_user_id: lineUserId, display_name: name, created_at: new Date().toISOString(), status: "pending" });
  return id;
}

describe("server.ts：案B（0022）LINE予約の本人＝LINEのユーザーID（偽の Supabase・偽の LINE）", () => {
  it("知らない LINE が、既存のお客様の電話番号で LINE予約 → 新しいお客様ができて、その人につながる。被害者のお客様情報・LINE には触れない", async () => {
    const { handleBook } = await import("@/lib/line/server");
    idTokenUser = ATTACKER;
    const r = await handleBook({ ...BOOK, idToken: ID_TOKEN });
    expect(r.ok).toBe(true);
    expect(r.line).toEqual({ linked: true, customer_created: true });
    expect(r.booking).toMatchObject({ booking_no: "W261109-TEST1", store_name: "ラシエル箱崎" });
    expect(r.booking).not.toHaveProperty("customer_id");            // お客様IDはブラウザに返さない
    // サーバは LINE で確かめたユーザーIDだけを渡す（ブラウザの言う名前・電話は本人の特定に使わない）
    expect(rpcCalls[0]).toMatchObject({ fn: "service_create_booking", p_line_user_id: ATTACKER, p_line_display_name: "あやしい人", p_phone: "090-1234-5678", p_slug: "laciel-hakozaki" });
    const newCust = T.customers.find(c => c.name === "攻撃者")!;
    expect(newCust).toBeTruthy(); expect(newCust.id).not.toBe("cust-victim");
    expect(T.line_links.find(l => l.line_user_id === ATTACKER)).toMatchObject({ customer_id: newCust.id, linked_via: "line_id" });
    expect(T.line_links.find(l => l.line_user_id === VICTIM)).toMatchObject({ customer_id: "cust-victim", linked_via: "token" });
    expect(T.customers.find(c => c.id === "cust-victim")).toMatchObject({ name: "被害 花子", email: "victim@example.com" });
    expect(T.bookings.at(-1)).toMatchObject({ customer_id: newCust.id, customer_created: true, web_check: "同じ電話番号のお客様がいます" });
    expect(T.line_link_requests).toEqual([]);                        // 確認待ちは作らない
    expect(T.audit_logs.map(a => a.action)).toEqual(["link_create"]);
    const json = JSON.stringify(T.audit_logs);
    for (const pii of [ATTACKER, "あやしい人", "攻撃者", "evil@example.com", "090-1234-5678"]) expect(json).not.toContain(pii);
    expect(pushes).toEqual([]);
  });

  it("同じ LINE の2回目 → 同じお客様（別の名前・電話でも新しいお客様は作らない）。前回入力（/api/line/me）は本人の分が出る", async () => {
    const { handleBook, handleMe } = await import("@/lib/line/server");
    idTokenUser = ATTACKER;
    const r1 = await handleBook({ ...BOOK, idToken: ID_TOKEN });
    const r2 = await handleBook({ ...BOOK, idToken: ID_TOKEN, name: "攻撃者２", phone: "080-0000-0000" });
    expect(r1.line.customer_created).toBe(true); expect(r2.line.customer_created).toBe(false);
    const mine = T.line_links.find(l => l.line_user_id === ATTACKER)!;
    expect(T.bookings.filter(b => b.customer_id === mine.customer_id)).toHaveLength(2);
    expect(T.customers.filter(c => String(c.name).startsWith("攻撃者"))).toHaveLength(1);
    expect(T.audit_logs.map(a => a.action)).toEqual(["link_create"]);   // 2回目はつながりを作らないので監査ログも増えない
    expect(await handleMe({ slug: "laciel-hakozaki", idToken: ID_TOKEN })).toMatchObject({ found: true, name: "攻撃者", phone: "090-1234-5678" });
    // 被害者（本人の LINE）の前回入力は被害者の分
    idTokenUser = VICTIM;
    expect(await handleMe({ slug: "laciel-hakozaki", idToken: ID_TOKEN })).toMatchObject({ found: true, name: "被害 花子" });
  });

  it("DB のエラー名はそのまま（slot_taken → 409）。DB の中身が分かる文は返さない（500）。0022 が無ければ 503。形が違えば LINE に聞く前に 400", async () => {
    const { handleBook } = await import("@/lib/line/server");
    idTokenUser = ATTACKER;
    rpcFail = { message: "slot_taken" };
    await expect(handleBook({ ...BOOK, idToken: ID_TOKEN })).rejects.toMatchObject({ status: 409, message: "slot_taken" });
    rpcFail = { message: "invalid_kana" };
    await expect(handleBook({ ...BOOK, idToken: ID_TOKEN })).rejects.toMatchObject({ status: 400, message: "invalid_kana" });
    rpcFail = { message: 'duplicate key value violates unique constraint "line_links_customer_key"' };
    await expect(handleBook({ ...BOOK, idToken: ID_TOKEN })).rejects.toMatchObject({ status: 500, message: "うまくいきませんでした（時間をおいてもう一度）" });
    rpcFail = { code: "PGRST202", message: "Could not find the function public.service_create_booking" };
    await expect(handleBook({ ...BOOK, idToken: ID_TOKEN })).rejects.toMatchObject({ status: 503 });
    rpcFail = null;
    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    await expect(handleBook({ ...BOOK, idToken: "nope" })).rejects.toMatchObject({ status: 400, message: "bad_request" });
    await expect(handleBook({ ...BOOK, idToken: ID_TOKEN, menu_id: "x" })).rejects.toMatchObject({ status: 400, message: "menu_not_found" });
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(before);
    expect(T.bookings).toHaveLength(2);
  });

  it("0020 の LINE予約からの連携（mode=booking）はもう無い（400）。ネット予約がオフの店では 404", async () => {
    const { handleBook, handleLink } = await import("@/lib/line/server");
    idTokenUser = ATTACKER;
    await expect(handleLink({ slug: "laciel-hakozaki", idToken: ID_TOKEN, mode: "booking", cancel_token: "a".repeat(64) } as unknown as Parameters<typeof handleLink>[0])).rejects.toMatchObject({ status: 400 });
    expect(T.line_link_requests).toEqual([]);
    T.stores[0].web_booking_enabled = false;
    await expect(handleBook({ ...BOOK, idToken: ID_TOKEN })).rejects.toMatchObject({ status: 404 });
  });

  it("残っている確認待ち（0020）をスタッフが承認 → 付け替わり、前の LINE に「送り先が変更されました」が届く。監査ログは ID だけ", async () => {
    const { handleLinkRequest } = await import("@/lib/line/server");
    const reqId = seedRequest();
    const r = await handleLinkRequest(JWT("auth-staff"), { request_id: reqId, decision: "approve" });
    expect(r).toMatchObject({ ok: true, repointed: true, notice: "sent" });
    expect(T.line_links.find(l => l.line_user_id === VICTIM)?.customer_id).toBeNull();
    expect(T.line_links.find(l => l.line_user_id === ATTACKER)).toMatchObject({ customer_id: "cust-victim", linked_via: "staff_approved" });
    expect(pushes).toEqual([{ to: VICTIM, text: "ラシエル箱崎のお知らせの送り先が変更されました。心当たりがない場合はお店にご連絡ください。" }]);
    expect(T.line_messages.find(m => m.kind === "link_notice")).toMatchObject({ line_user_id: VICTIM, status: "sent", counted: true });
    expect(T.line_link_requests[0]).toMatchObject({ status: "approved", decided_by: "st-1" });
    expect(T.audit_logs.map(a => a.action)).toEqual(["link_repoint", "request_approve"]);
    expect(T.audit_logs.every(a => a.table_name === "line_link")).toBe(true);
    const json = JSON.stringify(T.audit_logs);
    for (const pii of [VICTIM, ATTACKER, "あやしい人", "被害 花子", "victim@example.com", "09012345678"]) expect(json).not.toContain(pii);
    // 2回目は 409
    await expect(handleLinkRequest(JWT("auth-staff"), { request_id: reqId, decision: "reject" })).rejects.toMatchObject({ status: 409 });
  });

  it("「つながない」はつながりを変えず、何も送らない", async () => {
    const { handleLinkRequest } = await import("@/lib/line/server");
    expect(await handleLinkRequest(JWT("auth-staff"), { request_id: seedRequest(), decision: "reject" })).toMatchObject({ ok: true });
    expect(T.line_links.find(l => l.line_user_id === VICTIM)?.customer_id).toBe("cust-victim");
    expect(pushes).toEqual([]);
    expect(T.line_link_requests[0].status).toBe("rejected");
  });

  it("viewer・他社・退職者・未ログインは決められない。30日を過ぎたら期限切れ", async () => {
    const { handleLinkRequest } = await import("@/lib/line/server");
    const reqId = seedRequest();
    for (const u of ["auth-viewer", "auth-other", "auth-left"]) await expect(handleLinkRequest(JWT(u), { request_id: reqId, decision: "approve" })).rejects.toMatchObject({ status: 403 });
    await expect(handleLinkRequest(null, { request_id: reqId, decision: "approve" })).rejects.toMatchObject({ status: 401 });
    expect(T.line_link_requests[0].status).toBe("pending");
    T.line_link_requests[0].created_at = new Date(Date.now() - 31 * 86400_000).toISOString();
    await expect(handleLinkRequest(JWT("auth-staff"), { request_id: reqId, decision: "approve" })).rejects.toMatchObject({ status: 410 });
    expect(T.line_link_requests[0].status).toBe("expired");
    expect(T.line_links.find(l => l.line_user_id === VICTIM)?.customer_id).toBe("cust-victim");
  });

  it("会計のQR（token）で別の LINE に付け替えたときも、前の LINE に知らせる", async () => {
    const { handleLink } = await import("@/lib/line/server");
    const { createHash } = await import("node:crypto");
    const tok = "c".repeat(64);
    T.line_link_tokens = [{ token_hash: createHash("sha256").update(tok).digest("hex"), store_id: STORE, customer_id: "cust-victim", used_at: null, expires_at: new Date(Date.now() + 600_000).toISOString() }];
    idTokenUser = NEWBIE;
    const r = await handleLink({ slug: "laciel-hakozaki", idToken: ID_TOKEN, mode: "token", token: tok });
    expect(r.ok).toBe(true);
    expect(T.line_links.find(l => l.line_user_id === NEWBIE)).toMatchObject({ customer_id: "cust-victim", linked_via: "token" });
    expect(pushes.map(p => p.to)).toEqual([VICTIM]);
    expect(T.audit_logs.map(a => a.action)).toEqual(["link_repoint"]);
  });

  it("前回入力（/api/line/me）：staff_approved は返す・booking（0019 の既存のお客様）は返さない", async () => {
    const { handleMe } = await import("@/lib/line/server");
    idTokenUser = VICTIM;
    T.line_links[0].linked_via = "staff_approved";
    expect(await handleMe({ slug: "laciel-hakozaki", idToken: ID_TOKEN })).toMatchObject({ found: true, name: "被害 花子" });
    T.line_links[0].linked_via = "booking";
    expect(await handleMe({ slug: "laciel-hakozaki", idToken: ID_TOKEN })).toMatchObject({ found: false });
  });

  it("C7 持ち主の確認：同じ LINE の確認待ちを承認 → staff_approved・お知らせ再開（何も送らない）", async () => {
    const { handleLinkRequest, handleMe } = await import("@/lib/line/server");
    Object.assign(T.line_links[0], { linked_via: "booking_new", needs_confirm: true });
    T.line_link_requests.push({ id: "11111111-0000-4000-8000-000000000001", store_id: STORE, customer_id: "cust-victim", booking_id: "bk-existing", line_user_id: VICTIM, display_name: "本人", created_at: new Date().toISOString(), status: "pending" });
    idTokenUser = VICTIM;
    expect(await handleMe({ slug: "laciel-hakozaki", idToken: ID_TOKEN })).toMatchObject({ found: false });   // 確認待ちの間は前回入力も返さない
    const r = await handleLinkRequest(JWT("auth-staff"), { request_id: "11111111-0000-4000-8000-000000000001", decision: "approve" });
    expect(r).toMatchObject({ ok: true, repointed: false });
    expect(T.line_links[0]).toMatchObject({ customer_id: "cust-victim", linked_via: "staff_approved", needs_confirm: false });
    expect(pushes).toEqual([]);
    expect(await handleMe({ slug: "laciel-hakozaki", idToken: ID_TOKEN })).toMatchObject({ found: true });
  });

  it("C7 持ち主の確認：「外す」→ その LINE をお客様から外す", async () => {
    const { handleLinkRequest } = await import("@/lib/line/server");
    Object.assign(T.line_links[0], { line_user_id: ATTACKER, linked_via: "booking_new", needs_confirm: true });
    T.line_link_requests.push({ id: "11111111-0000-4000-8000-000000000002", store_id: STORE, customer_id: "cust-victim", booking_id: "bk-existing", line_user_id: ATTACKER, display_name: "あやしい人", created_at: new Date().toISOString(), status: "pending" });
    const r = await handleLinkRequest(JWT("auth-staff"), { request_id: "11111111-0000-4000-8000-000000000002", decision: "reject" });
    expect(r.message).toMatch(/外しました/);
    expect(T.line_links[0]).toMatchObject({ customer_id: null, needs_confirm: false });
    expect(T.audit_logs.map(a => a.action)).toEqual(["link_remove", "request_reject"]);
  });
});
