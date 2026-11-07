// 本番の流れ（server.ts の handleLink・handleLinkRequest）を、偽の Supabase（メモリの表）と偽の LINE（fetch）で通す。
//  ・既存のお客様の LINE予約 → 確認待ちができて、つながらない
//  ・スタッフが承認 → 付け替わり、前の LINE に「送り先が変更されました」が届く
//  ・viewer は承認できない／2回目は 409
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
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => q(t), auth: { getUser: async (jwt: string) => (USERS[jwt] ? { data: { user: { id: USERS[jwt] } }, error: null } : { data: { user: null }, error: { message: "bad jwt" } }) } }),
}));

const STORE = "aaaaaaaa-0000-0000-0000-000000000001", CO = "cccccccc-0000-0000-0000-000000000001", OTHER_CO = "cccccccc-0000-0000-0000-000000000002";
const VICTIM = "U" + "b".repeat(32), ATTACKER = "U" + "a".repeat(32), NEWBIE = "U" + "c".repeat(32);
const JWT = (u: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ u })).toString("base64url")}.c2lnbmF0dXJlLXNpZw`;
const pushes: { to: string; text: string }[] = [];
let idTokenUser = ATTACKER;

beforeEach(() => {
  for (const k of Object.keys(T)) delete T[k];
  pushes.length = 0;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://fake"; process.env.SUPABASE_SERVICE_ROLE_KEY = "fake";
  T.stores = [{ id: STORE, company_id: CO, name: "ラシエル箱崎", slug: "laciel-hakozaki", web_booking_enabled: true }];
  T.line_channels = [{ store_id: STORE, enabled: true, login_channel_id: "1234567", liff_id: "1234567-abcd", secret_set_at: "x", token_set_at: "x", plan_limit: 200, bot_basic_id: "@lh" }];
  T.line_channel_secrets = [{ store_id: STORE, channel_secret: "s", access_token: "tok" }];
  T.menus = []; T.line_messages = []; T.audit_logs = []; T.line_link_requests = []; T.line_link_tokens = [];
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

describe("server.ts：LINE予約 → 確認待ち → 承認（偽の Supabase・偽の LINE）", () => {
  it("既存のお客様の LINE予約は確認待ちになり、つながらない（前回入力の名前も返さない）", async () => {
    const { handleLink } = await import("@/lib/line/server");
    idTokenUser = ATTACKER;
    const r = await handleLink({ slug: "laciel-hakozaki", idToken: ID_TOKEN, mode: "booking", cancel_token: "a".repeat(64) });
    expect(r).toMatchObject({ ok: false, pending: true, message: "LINEのお知らせは、ご来店時にお店で確認してからお届けします" });
    expect(T.line_links.find(l => l.line_user_id === VICTIM)?.customer_id).toBe("cust-victim");
    expect(T.line_links.some(l => l.line_user_id === ATTACKER)).toBe(false);
    expect(T.line_link_requests).toHaveLength(1);
    expect(T.line_link_requests[0]).toMatchObject({ customer_id: "cust-victim", booking_id: "bk-existing", line_user_id: ATTACKER, display_name: "あやしい人", status: "pending" });
    expect(T.audit_logs.map(a => a.action)).toEqual(["request_create"]);
    expect(pushes).toEqual([]);
    // 同じ予約でもう一度押しても確認待ちは1件のまま
    await handleLink({ slug: "laciel-hakozaki", idToken: ID_TOKEN, mode: "booking", cancel_token: "a".repeat(64) });
    expect(T.line_link_requests).toHaveLength(1);
  });

  it("LINE がつながっていない既存のお客様でも、確認待ち（自動ではつながない）", async () => {
    const { handleLink } = await import("@/lib/line/server");
    T.line_links = [];
    idTokenUser = ATTACKER;
    expect((await handleLink({ slug: "laciel-hakozaki", idToken: ID_TOKEN, mode: "booking", cancel_token: "a".repeat(64) })).pending).toBe(true);
    expect(T.line_links).toEqual([]);
  });

  it("新しく作られたお客様の LINE予約はそのままつなぐ（booking_new・名前を返す）", async () => {
    const { handleLink } = await import("@/lib/line/server");
    idTokenUser = NEWBIE;
    const r = await handleLink({ slug: "laciel-hakozaki", idToken: ID_TOKEN, mode: "booking", cancel_token: "b".repeat(64) });
    expect(r).toMatchObject({ ok: true, name: "新規 太郎" });
    expect(T.line_links.find(l => l.line_user_id === NEWBIE)).toMatchObject({ customer_id: "cust-new", linked_via: "booking_new" });
    expect(T.audit_logs.map(a => a.action)).toEqual(["link_create"]);
  });

  it("スタッフが承認 → 付け替わり、前の LINE に「送り先が変更されました」が届く。監査ログは ID だけ", async () => {
    const { handleLink, handleLinkRequest } = await import("@/lib/line/server");
    idTokenUser = ATTACKER;
    await handleLink({ slug: "laciel-hakozaki", idToken: ID_TOKEN, mode: "booking", cancel_token: "a".repeat(64) });
    const reqId = String(T.line_link_requests[0].id);
    const r = await handleLinkRequest(JWT("auth-staff"), { request_id: reqId, decision: "approve" });
    expect(r).toMatchObject({ ok: true, repointed: true, notice: "sent" });
    expect(T.line_links.find(l => l.line_user_id === VICTIM)?.customer_id).toBeNull();
    expect(T.line_links.find(l => l.line_user_id === ATTACKER)).toMatchObject({ customer_id: "cust-victim", linked_via: "staff_approved" });
    expect(pushes).toEqual([{ to: VICTIM, text: "ラシエル箱崎のお知らせの送り先が変更されました。心当たりがない場合はお店にご連絡ください。" }]);
    expect(T.line_messages.find(m => m.kind === "link_notice")).toMatchObject({ line_user_id: VICTIM, status: "sent", counted: true });
    expect(T.line_link_requests[0]).toMatchObject({ status: "approved", decided_by: "st-1" });
    expect(T.audit_logs.map(a => a.action)).toEqual(["request_create", "link_repoint", "request_approve"]);
    expect(T.audit_logs.every(a => a.table_name === "line_link")).toBe(true);
    const json = JSON.stringify(T.audit_logs);
    for (const pii of [VICTIM, ATTACKER, "あやしい人", "被害 花子", "victim@example.com", "09012345678"]) expect(json).not.toContain(pii);
    // 2回目は 409
    await expect(handleLinkRequest(JWT("auth-staff"), { request_id: reqId, decision: "reject" })).rejects.toMatchObject({ status: 409 });
  });

  it("「つながない」はつながりを変えず、何も送らない", async () => {
    const { handleLink, handleLinkRequest } = await import("@/lib/line/server");
    idTokenUser = ATTACKER;
    await handleLink({ slug: "laciel-hakozaki", idToken: ID_TOKEN, mode: "booking", cancel_token: "a".repeat(64) });
    expect(await handleLinkRequest(JWT("auth-staff"), { request_id: String(T.line_link_requests[0].id), decision: "reject" })).toMatchObject({ ok: true });
    expect(T.line_links.find(l => l.line_user_id === VICTIM)?.customer_id).toBe("cust-victim");
    expect(pushes).toEqual([]);
    expect(T.line_link_requests[0].status).toBe("rejected");
  });

  it("viewer・他社・退職者・未ログインは決められない。30日を過ぎたら期限切れ", async () => {
    const { handleLink, handleLinkRequest } = await import("@/lib/line/server");
    idTokenUser = ATTACKER;
    await handleLink({ slug: "laciel-hakozaki", idToken: ID_TOKEN, mode: "booking", cancel_token: "a".repeat(64) });
    const reqId = String(T.line_link_requests[0].id);
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
