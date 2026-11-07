// スタッフのログインの発行・停止（サーバだけ。Next.js のルートから使う）。
// サービスキー（SUPABASE_SERVICE_ROLE_KEY）で Supabase Auth のユーザーを作る・止める。キーが無ければ 501。
// 操作する人の役割は、その人のトークンで my_role_in_company(対象の会社) を呼んで確かめる（画面の言うことは信じない）。
// 仮パスワードは返すだけ。DB・audit_logs・console には絶対に書かない。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { StaffRole } from "./db/types";
import {
  BAN_FOREVER, ISSUE_LIMIT_PER_HOUR, checkNewPassword, generateTempPassword, isValidEmail, loginPermissionError, loginStatusOf, normalizeEmail,
  canSeeLoginStatus, isUserRole, type AuthInfo, type StaffLoginAction, type StaffLoginHistory, type StaffLoginInfo, type StaffLoginResult, type StaffLoginStatusResult,
} from "./staffLogin";

export class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StaffRow { id: string; company_id: string; name: string; role: StaffRole; active: boolean | null; email: string | null; auth_user_id: string | null; home_store_id?: string | null }
export interface NewStaffRow { company_id: string; name: string; role: "staff" | "manager"; email: string; auth_user_id: string; home_store_id: string; show_on_ledger: boolean }
export interface AuditRow { actor: string; actor_staff_id: string | null; actor_name: string | null; store_id: string | null; row_id: string | null; action: string; reason?: string | null; company_id: string; after?: Record<string, unknown> }

/** サーバの部品（テストでは偽物に差し替える） */
export interface LoginDeps {
  configured: boolean;
  inviteEnabled: boolean;
  authUser(jwt: string): Promise<{ id: string; email: string | null } | null>;
  /** その人のトークンで my_role_in_company(company) */
  roleIn(jwt: string, companyId: string): Promise<StaffRole | null>;
  storeCompany(storeId: string): Promise<string | null>;
  staffById(id: string): Promise<StaffRow | null>;
  staffOfCompany(companyId: string): Promise<StaffRow[]>;
  /** その auth ユーザーにつながっている staff 行（全部の会社） */
  staffByAuth(authId: string): Promise<StaffRow[]>;
  authInfo(ids: string[], emails: string[]): Promise<AuthInfo[]>;
  /** mustChange＝最初のログインで自分のパスワードに変えてもらう（既定 true） */
  createAuthUser(email: string, password: string, mustChange?: boolean): Promise<string>;
  /** 設定＞ユーザー：スタッフ行（＋所属店舗）を作る。サービスキーで（同じ会社の店舗だけ渡す） */
  insertStaff(row: NewStaffRow): Promise<string>;
  inviteAuthUser(email: string, redirectTo: string): Promise<string>;
  deleteAuthUser(id: string): Promise<void>;
  setPassword(authId: string, password: string, mustChange: boolean): Promise<void>;
  setBan(authId: string, banned: boolean): Promise<void>;
  /** 今のログイン（リフレッシュトークン）を全部消す。できなければ false（1時間以内に切れる） */
  revokeSessions(authId: string): Promise<boolean>;
  linkStaff(staffId: string, authId: string, email: string): Promise<void>;
  recentIssueCount(companyId: string, sinceIso: string): Promise<number>;
  audit(row: AuditRow): Promise<void>;
  history(companyId: string, limit: number): Promise<StaffLoginHistory[]>;
}

export function loginServerConfigured() { return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY); }
export function appBase(origin?: string | null) {
  const v = process.env.APP_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") || origin || "";
  return v.replace(/\/+$/, "");
}
export const loginUrlFor = (base: string, email?: string | null) => `${base}/bookings${email ? `?email=${encodeURIComponent(email)}` : ""}`;
const ISSUE_ACTIONS = ["login_issue", "login_invite", "login_reset", "user_create", "user_password"];
const EMAIL_EXISTS_MSG = "このメールアドレスのログインはもうあります（別の会社・店舗で使っている、または前に作ったもの）。別のメール（お店のGmail＋名前 など）にするか、設定＞スタッフ の「ログインの発行」から今のログインをつないでください";

async function who(deps: LoginDeps, jwt: string | null) {
  if (!deps.configured) throw new HttpError(501, "サーバの設定が未完了です（Vercel の環境変数 SUPABASE_SERVICE_ROLE_KEY を設定してください）");
  if (!jwt) throw new HttpError(401, "ログインしてください");
  const u = await deps.authUser(jwt);
  if (!u) throw new HttpError(401, "ログインの期限が切れています。もう一度ログインしてください");
  return u;
}

/** 一覧：ログインの状態（オーナー・店長） */
export async function loginStatus(deps: LoginDeps, jwt: string | null, storeId: string): Promise<StaffLoginStatusResult> {
  await who(deps, jwt);
  if (!UUID_RE.test(storeId || "")) throw new HttpError(400, "店舗が分かりません");
  const company = await deps.storeCompany(storeId);
  if (!company) throw new HttpError(404, "店舗が見つかりません");
  const role = await deps.roleIn(jwt!, company);
  if (!canSeeLoginStatus(role)) throw new HttpError(403, "ログインの状態はオーナー・店長だけが見られます");
  const list = await deps.staffOfCompany(company);
  const ids = list.map(s => s.auth_user_id).filter((x): x is string => !!x);
  const emails = list.filter(s => !s.auth_user_id && s.email).map(s => normalizeEmail(s.email!));
  const infos = ids.length || emails.length ? await deps.authInfo(ids, emails) : [];
  const items: StaffLoginInfo[] = [];
  for (const s of list) {
    const u = s.auth_user_id ? infos.find(x => x.id === s.auth_user_id) : s.email ? infos.find(x => normalizeEmail(x.email || "") === normalizeEmail(s.email!)) : undefined;
    items.push({ staff_id: s.id, status: loginStatusOf(u ?? null), email: s.email ?? u?.email ?? null, last_sign_in_at: u?.last_sign_in_at ?? null, must_change: !!u?.must_change });
  }
  let history: StaffLoginHistory[] = [];
  try { history = await deps.history(company, 20); } catch { /* 履歴が読めなくても一覧は出す */ }
  return { server: true, invite_enabled: deps.inviteEnabled, items, history };
}

/** 発行・招待・再設定・停止・再開 */
export async function loginAction(deps: LoginDeps, jwt: string | null, body: StaffLoginAction & { store_id?: string }, origin?: string | null): Promise<StaffLoginResult> {
  const me = await who(deps, jwt);
  if (body?.kind === "create_user") return createUser(deps, jwt!, me, body, origin);
  if (!body || !UUID_RE.test(body.staff_id || "")) throw new HttpError(400, "スタッフが分かりません");
  const target = await deps.staffById(body.staff_id);
  if (!target) throw new HttpError(404, "スタッフが見つかりません");
  const company = target.company_id;
  const role = await deps.roleIn(jwt!, company);
  const actorRows = (await deps.staffByAuth(me.id)).filter(s => s.company_id === company && s.active !== false);
  const actor = actorRows.sort((a, b) => rank(a.role) - rank(b.role))[0] ?? null;
  const err = loginPermissionError(body.kind, { staff_id: actor?.id ?? null, auth_user_id: me.id, role }, target);
  if (err) throw new HttpError(403, err);
  // 記録する店舗：画面の店舗が同じ会社ならそれ、違えば所属店舗
  let storeId: string | null = target.home_store_id ?? null;
  if (body.store_id && UUID_RE.test(body.store_id) && (await deps.storeCompany(body.store_id)) === company) storeId = body.store_id;
  const base = appBase(origin);
  const log = (action: string, after: Record<string, unknown> = {}, reason?: string | null) =>
    deps.audit({ actor: me.id, actor_staff_id: actor?.id ?? null, actor_name: actor?.name ?? null, store_id: storeId, row_id: target.id, action, reason: reason ?? null, company_id: company, after: { company_id: company, target_name: target.name, ...after } });
  const limit = async () => {
    const n = await deps.recentIssueCount(company, new Date(Date.now() - 3600_000).toISOString());
    if (n >= ISSUE_LIMIT_PER_HOUR) throw new HttpError(429, `発行・再設定は1時間に${ISSUE_LIMIT_PER_HOUR}回までです。しばらくしてからもう一度どうぞ`);
  };
  /** 同じログインを別の会社の在籍スタッフも使っているか */
  const sharedElsewhere = async (authId: string) => (await deps.staffByAuth(authId)).some(s => s.id !== target.id && s.company_id !== company && s.active !== false);

  if (body.kind === "issue" || body.kind === "invite") {
    if (target.auth_user_id) throw new HttpError(409, "このスタッフのログインはもう発行済みです（パスワードを忘れたときは「パスワードを再設定」）");
    const email = normalizeEmail(body.email || "");
    if (!isValidEmail(email)) throw new HttpError(400, "メールアドレスが正しくありません");
    const dup = (await deps.staffOfCompany(company)).find(s => s.id !== target.id && normalizeEmail(s.email || "") === email);
    if (dup) throw new HttpError(409, `このメールは「${dup.name}」さんで使われています。別のメールにしてください`);
    if (body.kind === "invite" && !deps.inviteEnabled) throw new HttpError(400, "招待メールは使えない設定です（メールの送信設定＝SMTP をしてから）。「ログインを発行」（仮パスワード）を使ってください");
    await limit();
    const existing = (await deps.authInfo([], [email])).find(x => normalizeEmail(x.email || "") === email);
    if (existing) {
      if (body.kind !== "issue" || !body.link_existing) {
        return { ok: false, code: "email_exists", message: "このメールのログインはもうあります（別の会社・店舗で使っている等）。同じログインをこのスタッフにもつなぐか、別のメール（お店のGmail＋名前 など）にしてください" };
      }
      const rows = await deps.staffByAuth(existing.id);
      if (rows.some(r => r.company_id === company)) throw new HttpError(409, "そのログインは、この会社の別のスタッフにつながっています");
      await deps.linkStaff(target.id, existing.id, email);
      await log("login_link", { email });
      return { ok: true, message: "今あるログインをつなぎました。今までと同じパスワードでログインできます", email, login_url: loginUrlFor(base, email), status: loginStatusOf(existing) };
    }
    if (body.kind === "invite") {
      const id = await deps.inviteAuthUser(email, `${base}/bookings`);
      try { await deps.linkStaff(target.id, id, email); } catch (e) { await deps.deleteAuthUser(id).catch(() => {}); throw e; }
      await log("login_invite", { email });
      return { ok: true, message: `${email} に招待メールを送りました。メールのリンクを開くと、自分のパスワードを決める画面になります`, email, status: "invited" };
    }
    const pw = generateTempPassword();
    const id = await deps.createAuthUser(email, pw);
    try { await deps.linkStaff(target.id, id, email); } catch (e) { await deps.deleteAuthUser(id).catch(() => {}); throw e; }
    await log("login_issue", { email });
    return { ok: true, message: "ログインを発行しました", temp_password: pw, email, login_url: loginUrlFor(base, email), status: "invited" };
  }

  if (body.kind === "reset") {
    if (!target.auth_user_id) throw new HttpError(400, "まだログインが発行されていません（先に「ログインを発行」）");
    if (await sharedElsewhere(target.auth_user_id)) throw new HttpError(409, "このログインは別の会社でも使われているため、ここでは再設定できません");
    await limit();
    const pw = generateTempPassword();
    await deps.setPassword(target.auth_user_id, pw, true);
    await deps.revokeSessions(target.auth_user_id);
    await log("login_reset", { email: target.email });
    return { ok: true, message: "パスワードを再設定しました（今ログインしている端末はログアウトされます）", temp_password: pw, email: target.email ?? undefined, login_url: loginUrlFor(base, target.email), status: "invited" };
  }

  if (body.kind === "set_password") {
    if (!target.auth_user_id) throw new HttpError(400, "まだログインがありません（先に「ユーザーを追加」か「ログインを発行」）");
    const pw = String(body.password ?? "");
    const bad = checkNewPassword(pw, target.email);
    if (bad) throw new HttpError(400, bad);
    if (await sharedElsewhere(target.auth_user_id)) throw new HttpError(409, "このログインは別の会社でも使われているため、ここではパスワードを変えられません");
    await limit();
    const mustChange = body.must_change !== false;
    await deps.setPassword(target.auth_user_id, pw, mustChange);
    await deps.revokeSessions(target.auth_user_id);
    await log("user_password", { must_change: mustChange });
    return { ok: true, message: `パスワードを変えました（今ログインしている端末はログアウトされます）。${mustChange ? "次のログインで本人に自分のパスワードを決めてもらいます" : "このパスワードのまま使えます"}`, email: target.email ?? undefined, login_url: loginUrlFor(base, target.email), status: "invited", staff_id: target.id };
  }

  if (body.kind === "stop") {
    const reason = body.reason === "retire" ? "退職" : null;
    let authId = target.auth_user_id;
    if (!authId && target.email) authId = (await deps.authInfo([], [normalizeEmail(target.email)]))[0]?.id ?? null;
    if (!authId) return { ok: true, message: "ログインはまだ発行されていないので、止めるものはありません", status: "none" };
    if (await sharedElsewhere(authId)) {
      await log("login_stop", { shared: true }, reason);
      return { ok: true, not_stopped: true, message: "このログインは別の会社でも在籍中のため、ログイン自体は止めていません（この会社のデータは見られません）", status: "active" };
    }
    await deps.setBan(authId, true);
    const revoked = await deps.revokeSessions(authId);
    await log("login_stop", {}, reason);
    return { ok: true, message: revoked ? "ログインを止めました（今ログインしている端末もすぐ使えなくなります）" : "ログインを止めました（今開いている端末も、遅くとも1時間以内に使えなくなります）", status: "stopped" };
  }

  if (body.kind === "resume") {
    if (!target.auth_user_id) throw new HttpError(400, "まだログインが発行されていません");
    await deps.setBan(target.auth_user_id, false);
    await log("login_resume");
    return { ok: true, message: "ログインを再開しました（前と同じパスワードで入れます。忘れていたら「パスワードを再設定」）", status: "active" };
  }
  throw new HttpError(400, "unknown");
}

/** 設定＞ユーザー：オーナーが名前・役割・メール・パスワードを決めてユーザーを作る（パスワードは返事にも記録にも入れない） */
async function createUser(deps: LoginDeps, jwt: string, me: { id: string }, body: Extract<StaffLoginAction, { kind: "create_user" }> & { store_id?: string }, origin?: string | null): Promise<StaffLoginResult> {
  const email = normalizeEmail(String(body.email ?? ""));
  const pw = String(body.password ?? "");
  const mustChange = body.must_change !== false;
  let target: StaffRow | null = null, company: string | null = null;
  if (body.staff_id) {
    if (!UUID_RE.test(body.staff_id)) throw new HttpError(400, "スタッフが分かりません");
    target = await deps.staffById(body.staff_id);
    if (!target) throw new HttpError(404, "スタッフが見つかりません");
    company = target.company_id;
  } else {
    if (!UUID_RE.test(body.store_id || "")) throw new HttpError(400, "店舗が分かりません");
    company = await deps.storeCompany(body.store_id!);
    if (!company) throw new HttpError(404, "店舗が見つかりません");
  }
  const role = await deps.roleIn(jwt, company);
  const actor = (await deps.staffByAuth(me.id)).filter(s => s.company_id === company && s.active !== false).sort((a, b) => rank(a.role) - rank(b.role))[0] ?? null;
  if (role !== "owner") throw new HttpError(403, "ユーザーの追加はオーナーだけができます");
  if (target) {
    const e = loginPermissionError("create_user", { staff_id: actor?.id ?? null, auth_user_id: me.id, role }, target);
    if (e) throw new HttpError(403, e);
    if (target.auth_user_id) throw new HttpError(409, "このスタッフにはもうログインがあります（パスワードは「パスワードを変更」から）");
  }
  // 入力のチェック（つなぐときは、名前・役割は今のスタッフのまま）
  const name = target ? target.name : String(body.name ?? "").trim();
  if (!target) {
    if (!name) throw new HttpError(400, "名前を入れてください");
    if (name.length > 40) throw new HttpError(400, "名前は40文字までにしてください");
    if (!isUserRole(body.role)) throw new HttpError(400, "役割は「スタッフ」か「店長」から選んでください（オーナーは作れません）");
  }
  if (!isValidEmail(email)) throw new HttpError(400, "メールアドレスが正しくありません");
  const bad = checkNewPassword(pw, email);
  if (bad) throw new HttpError(400, bad);
  const dup = (await deps.staffOfCompany(company)).find(s => s.id !== target?.id && normalizeEmail(s.email || "") === email);
  if (dup) throw new HttpError(409, `このメールは「${dup.name}」さんで使われています。別のメールにしてください`);
  // 記録する店舗・新しい人の所属店舗：画面の店舗（同じ会社のときだけ）
  let storeId: string | null = target?.home_store_id ?? null;
  if (body.store_id && UUID_RE.test(body.store_id) && (target ? (await deps.storeCompany(body.store_id)) === company : true)) storeId = body.store_id;
  const n = await deps.recentIssueCount(company, new Date(Date.now() - 3600_000).toISOString());
  if (n >= ISSUE_LIMIT_PER_HOUR) throw new HttpError(429, `ユーザーの追加・パスワードの変更は1時間に${ISSUE_LIMIT_PER_HOUR}回までです。しばらくしてからもう一度どうぞ`);
  if ((await deps.authInfo([], [email])).some(x => normalizeEmail(x.email || "") === email)) return { ok: false, code: "email_exists", message: EMAIL_EXISTS_MSG };
  let authId: string;
  try { authId = await deps.createAuthUser(email, pw, mustChange); }
  catch (e) { if (e instanceof HttpError && e.code === "email_exists") return { ok: false, code: "email_exists", message: EMAIL_EXISTS_MSG }; throw e; }
  let staffId: string;
  try {
    if (target) { await deps.linkStaff(target.id, authId, email); staffId = target.id; }
    else staffId = await deps.insertStaff({ company_id: company, name, role: body.role, email, auth_user_id: authId, home_store_id: storeId!, show_on_ledger: body.show_on_ledger !== false });
  } catch (e) { await deps.deleteAuthUser(authId).catch(() => {}); throw e; }
  await deps.audit({ actor: me.id, actor_staff_id: actor?.id ?? null, actor_name: actor?.name ?? null, store_id: storeId, row_id: staffId, action: "user_create", reason: null, company_id: company,
    after: { company_id: company, target_name: name, email, role: target ? target.role : body.role, must_change: mustChange, new_staff: !target } });
  return { ok: true, message: `${name}さんのユーザーを作りました。${mustChange ? "最初のログインで本人に自分のパスワードを決めてもらいます" : "決めたパスワードのまま使えます"}`, email, login_url: loginUrlFor(appBase(origin), email), status: "invited", staff_id: staffId };
}

/** 本人が仮パスワードから自分のパスワードに変える（ログイン中の本人なら誰でも） */
export async function changeOwnPassword(deps: LoginDeps, jwt: string | null, password: string): Promise<{ ok: true }> {
  const me = await who(deps, jwt);
  const bad = checkNewPassword(String(password || ""), me.email);
  if (bad) throw new HttpError(400, bad);
  await deps.setPassword(me.id, password, false);
  const rows = (await deps.staffByAuth(me.id)).filter(s => s.active !== false);
  for (const r of rows.slice(0, 5)) await deps.audit({ actor: me.id, actor_staff_id: r.id, actor_name: r.name, store_id: r.home_store_id ?? null, row_id: r.id, action: "password_changed", company_id: r.company_id, after: { company_id: r.company_id, target_name: r.name } }).catch(() => {});
  return { ok: true };
}
const rank = (r: StaffRole) => ({ owner: 0, manager: 1, staff: 2, viewer: 3 })[r] ?? 9;

// ---------------------------------------------------------------------------
// 本物の部品（Supabase）
// ---------------------------------------------------------------------------
let admin: SupabaseClient | null = null;
function db() {
  if (!admin) admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}
function must<T>(r: { data: T | null; error: { message: string } | null }): T { if (r.error) throw new Error(r.error.message); return r.data as T; }
const STAFF_COLS = "id, company_id, name, role, active, email, auth_user_id, home_store_id";
const missingFn = (e: { code?: string; message?: string } | null) => !!e && (e.code === "PGRST202" || e.code === "42883" || /function .* does not exist|Could not find the function/i.test(e.message || ""));
type AdminUser = { id: string; email?: string | null; last_sign_in_at?: string | null; banned_until?: string | null; app_metadata?: Record<string, unknown> };
const toInfo = (u: AdminUser): AuthInfo => ({ id: u.id, email: u.email ?? null, last_sign_in_at: u.last_sign_in_at ?? null, banned_until: u.banned_until ?? null, must_change: u.app_metadata?.must_change_password === true });

export function supabaseLoginDeps(): LoginDeps {
  return {
    configured: loginServerConfigured(),
    inviteEnabled: process.env.STAFF_INVITE_EMAIL_ENABLED === "1",
    async authUser(jwt) { const r = await db().auth.getUser(jwt); return r.error || !r.data.user ? null : { id: r.data.user.id, email: r.data.user.email ?? null }; },
    async roleIn(jwt, companyId) {
      const c = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
      const r = await c.rpc("my_role_in_company", { p_company: companyId });
      if (r.error) throw new Error(r.error.message);
      return (r.data as StaffRole | null) ?? null;
    },
    async storeCompany(storeId) { const r = must(await db().from("stores").select("company_id").eq("id", storeId).maybeSingle()) as { company_id: string } | null; return r?.company_id ?? null; },
    async staffById(id) { return must(await db().from("staff").select(STAFF_COLS).eq("id", id).maybeSingle()) as StaffRow | null; },
    async staffOfCompany(companyId) { return must(await db().from("staff").select(STAFF_COLS).eq("company_id", companyId)) as StaffRow[]; },
    async staffByAuth(authId) { return must(await db().from("staff").select(STAFF_COLS).eq("auth_user_id", authId)) as StaffRow[]; },
    async authInfo(ids, emails) {
      // 0016 の staff_auth_lookup があれば1回で。無ければ Auth の管理APIで（少人数なので十分）
      const r = await db().rpc("staff_auth_lookup", { p_ids: ids, p_emails: emails });
      if (!r.error) return ((r.data || []) as (AuthInfo & { must_change: boolean | null })[]).map(x => ({ ...x, must_change: !!x.must_change }));
      if (!missingFn(r.error)) console.error("staff_auth_lookup", r.error.message.slice(0, 120));   // 読めなければ管理APIで
      const out: AuthInfo[] = [];
      for (const id of ids) { const u = await db().auth.admin.getUserById(id); if (!u.error && u.data.user) out.push(toInfo(u.data.user as AdminUser)); }
      if (emails.length) {
        const want = new Set(emails.map(normalizeEmail));
        for (let page = 1; page <= 20; page++) {
          const l = await db().auth.admin.listUsers({ page, perPage: 1000 });
          if (l.error) throw new Error(l.error.message);
          for (const u of l.data.users as AdminUser[]) if (u.email && want.has(normalizeEmail(u.email))) out.push(toInfo(u));
          if (l.data.users.length < 1000) break;
        }
      }
      return out;
    },
    async createAuthUser(email, password, mustChange = true) {
      const r = await db().auth.admin.createUser({ email, password, email_confirm: true, app_metadata: { must_change_password: mustChange } });
      if (r.error || !r.data.user) {
        const m = r.error?.message || "";
        if (/already|registered|exists/i.test(m)) throw new HttpError(409, "このメールのログインはもうあります", "email_exists");
        if (/weak|short|pwned|password/i.test(m)) throw new HttpError(400, "このパスワードは使えません（もっと長く・推測されにくいものに）");
        throw new HttpError(400, "ログインを作れませんでした（時間をおいてもう一度）");
      }
      return r.data.user.id;
    },
    async insertStaff(row) {
      // 表示順は会社の最後。0008 の列（sort_order・show_on_ledger・web_nominatable・home_store_id）は本番に適用済み
      const mx = must(await db().from("staff").select("sort_order").eq("company_id", row.company_id).order("sort_order", { ascending: false }).limit(1)) as { sort_order: number | null }[];
      const r = await db().from("staff").insert({ company_id: row.company_id, name: row.name, role: row.role, active: true, email: row.email, auth_user_id: row.auth_user_id, home_store_id: row.home_store_id,
        show_on_ledger: row.show_on_ledger, web_nominatable: row.show_on_ledger, sort_order: (mx[0]?.sort_order ?? 0) + 1 }).select("id").single();
      if (r.error || !r.data) throw new HttpError(409, /duplicate|unique/i.test(r.error?.message || "") ? "このメールは同じ会社の別のスタッフで使われています" : "スタッフを登録できませんでした");
      const id = (r.data as { id: string }).id;
      const l = await db().from("staff_stores").insert({ staff_id: id, store_id: row.home_store_id });
      if (l.error) { await db().from("staff").delete().eq("id", id); throw new HttpError(400, "所属店舗を登録できませんでした"); }
      return id;
    },
    async inviteAuthUser(email, redirectTo) {
      const r = await db().auth.admin.inviteUserByEmail(email, { redirectTo });
      if (r.error || !r.data.user) throw new HttpError(400, /rate limit/i.test(r.error?.message || "") ? "メールの送信回数の上限に当たりました（Supabase 標準のメールは1時間に数通まで）。「ログインを発行」（仮パスワード）を使ってください" : "招待メールを送れませんでした（メールの送信設定を確認してください）");
      await db().auth.admin.updateUserById(r.data.user.id, { app_metadata: { must_change_password: true } });
      return r.data.user.id;
    },
    async deleteAuthUser(id) { await db().auth.admin.deleteUser(id); },
    async setPassword(authId, password, mustChange) {
      const r = await db().auth.admin.updateUserById(authId, { password, app_metadata: { must_change_password: mustChange } });
      if (r.error) throw new HttpError(400, /weak|short|pwned/i.test(r.error.message) ? "このパスワードは使えません（もっと長く・推測されにくいものに）" : "パスワードを変えられませんでした（時間をおいてもう一度）");
    },
    async setBan(authId, banned) {
      const r = await db().auth.admin.updateUserById(authId, { ban_duration: banned ? BAN_FOREVER : "none" });
      if (r.error) throw new Error("ban: " + r.error.message.slice(0, 120));
    },
    async revokeSessions(authId) {
      const r = await db().rpc("staff_auth_revoke_sessions", { p_user: authId });
      return !r.error;
    },
    async linkStaff(staffId, authId, email) {
      const r = await db().from("staff").update({ auth_user_id: authId, email }).eq("id", staffId);
      if (r.error) throw new HttpError(409, /duplicate|unique/i.test(r.error.message) ? "このメールは同じ会社の別のスタッフで使われています" : "スタッフにログインをつなげませんでした");
    },
    async recentIssueCount(companyId, sinceIso) {
      const r = await db().from("audit_logs").select("id", { count: "exact", head: true }).eq("table_name", "staff_login").in("action", ISSUE_ACTIONS).gte("at", sinceIso).contains("after", { company_id: companyId });
      if (r.error) throw new Error(r.error.message);
      return r.count ?? 0;
    },
    async audit(a) {
      const r = await db().from("audit_logs").insert({ actor: a.actor, actor_staff_id: a.actor_staff_id, actor_name: a.actor_name, store_id: a.store_id, table_name: "staff_login", row_id: a.row_id, action: a.action, reason: a.reason ?? null, before: null, after: a.after ?? { company_id: a.company_id } });
      if (r.error) console.error("staff-login audit", r.error.message.slice(0, 120));
    },
    async history(companyId, limit) {
      const rows = must(await db().from("audit_logs").select("at, action, actor_name, reason, after").eq("table_name", "staff_login").contains("after", { company_id: companyId }).order("at", { ascending: false }).limit(limit)) as { at: string; action: string; actor_name: string | null; reason: string | null; after: Record<string, unknown> | null }[];
      return rows.map(r => ({ at: r.at, action: r.action, actor_name: r.actor_name, reason: r.reason, target_name: (r.after?.target_name as string) ?? null }));
    },
  };
}
