// スタッフのログイン（設定＞スタッフ「ログインの発行」）の共通部品。画面・サーバ・デモ・テストで同じ決まりを使う。
// ここには秘密を置かない。仮パスワードは作って返すだけ（保存・ログ出力はしない）。
import type { StaffRole } from "./db/types";

/** ログインの状態：未発行／招待済み（まだ自分のパスワードにしていない）／ログイン可／停止中 */
export type LoginStatus = "none" | "invited" | "active" | "stopped";
export const LOGIN_STATUS_LABEL: Record<LoginStatus, string> = { none: "未発行", invited: "招待済み", active: "ログイン可", stopped: "停止中" };

export interface StaffLoginInfo {
  staff_id: string;
  status: LoginStatus;
  email?: string | null;
  /** 最後にログインした日時 */
  last_sign_in_at?: string | null;
  /** 仮パスワードのまま（初回に変更が必要） */
  must_change?: boolean;
  /** 同じログインを別の会社でも使っている（その会社では止められない） */
  shared?: boolean;
}
export interface StaffLoginHistory { at: string; action: string; actor_name?: string | null; target_name?: string | null; reason?: string | null }
export interface StaffLoginStatusResult {
  /** サーバの設定（SUPABASE_SERVICE_ROLE_KEY）があり、発行・停止ができる */
  server: boolean;
  /** 招待メール（Supabase の inviteUserByEmail）を使える（SMTP を設定した店だけ） */
  invite_enabled: boolean;
  items: StaffLoginInfo[];
  history?: StaffLoginHistory[];
  message?: string;
  demo?: boolean;
}
export type StaffLoginAction =
  | { kind: "issue"; staff_id: string; email: string; link_existing?: boolean }
  | { kind: "invite"; staff_id: string; email: string }
  | { kind: "reset"; staff_id: string }
  | { kind: "stop"; staff_id: string; reason?: "retire" | "manual" }
  | { kind: "resume"; staff_id: string };
export type StaffLoginKind = StaffLoginAction["kind"];
export interface StaffLoginResult {
  ok: boolean;
  message: string;
  /** 仮パスワード：この1回だけ画面に出す（保存しない） */
  temp_password?: string;
  email?: string;
  login_url?: string;
  status?: LoginStatus;
  /** デモ（本物のログインは作っていない） */
  demo?: boolean;
  /** email_exists：そのメールのログインがもうある（つなぐかどうか聞く） */
  code?: string;
  /** 止めようとしたが止めていない（別の会社でも使っている等） */
  not_stopped?: boolean;
}

export const ACTION_JA: Record<string, string> = {
  login_issue: "ログインを発行", login_invite: "招待メールを送った", login_link: "今のログインをつないだ", login_reset: "パスワードを再設定",
  login_stop: "ログインを止めた", login_resume: "ログインを再開", password_changed: "自分のパスワードを変更",
};
/** 発行・再設定・招待は、会社ごとに1時間10回まで */
export const ISSUE_LIMIT_PER_HOUR = 10;
/** 自分で決めるパスワードの最低文字数 */
export const MIN_PASSWORD = 10;
/** Supabase の ban の長さ（実質ずっと）。再開で 'none' に戻す */
export const BAN_FOREVER = "876000h";

// ---------------------------------------------------------------------------
// 仮パスワード：見間違えやすい文字（0 O o 1 l I）を使わない 12文字＋区切り2つ（例：Kp7m-Qx4r-Tz9w）
// ---------------------------------------------------------------------------
const UP = "ABCDEFGHJKLMNPQRSTUVWXYZ", LO = "abcdefghijkmnpqrstuvwxyz", DG = "23456789";
export const TEMP_ALPHABET = UP + LO + DG;
/** 0..n-1 の一様な乱数（偏りが出ないよう棄却法）。テストで差し替えられる */
export type RandomBytes = (n: number) => Uint8Array;
const cryptoBytes: RandomBytes = n => { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return a; };
function pick(n: number, rnd: RandomBytes): number {
  const lim = 256 - (256 % n);
  for (;;) { for (const b of rnd(16)) if (b < lim) return b % n; }
}
export function generateTempPassword(rnd: RandomBytes = cryptoBytes): string {
  for (;;) {
    const cs = Array.from({ length: 12 }, () => TEMP_ALPHABET[pick(TEMP_ALPHABET.length, rnd)]);
    const s = cs.join("");
    if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[2-9]/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  }
}
/** 仮パスワードの強さ（ビット）。12文字×log2(56) ≒ 69.7 */
export const TEMP_PASSWORD_BITS = 12 * Math.log2(TEMP_ALPHABET.length);

// ---------------------------------------------------------------------------
// 入力チェック
// ---------------------------------------------------------------------------
export const normalizeEmail = (s: string) => s.trim().toLowerCase();
export const isValidEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s) && s.length <= 254;
const WEAK = ["password", "passw0rd", "1234567890", "12345678910", "0123456789", "qwertyuiop", "abcdefghij", "iloveyou", "kokage", "salon"];
/** 自分で決めるパスワードのチェック（null＝OK） */
export function checkNewPassword(pw: string, email?: string | null): string | null {
  if (pw.length < MIN_PASSWORD) return `パスワードは${MIN_PASSWORD}文字以上にしてください`;
  if (pw.length > 72) return "パスワードは72文字までにしてください";
  if (/^(.)\1+$/.test(pw)) return "同じ文字だけのパスワードは使えません";
  const low = pw.toLowerCase();
  if (WEAK.some(w => low.includes(w) && low.length - w.length < 4)) return "よく使われる言葉に近いパスワードは使えません";
  if (/^\d+$/.test(pw) && new Set(pw).size <= 3) return "数字の繰り返しは使えません";
  const local = (email || "").split("@")[0]?.toLowerCase();
  if (local && local.length >= 4 && low.includes(local)) return "メールアドレスと同じ言葉は入れないでください";
  return null;
}
/** お店の Gmail から「お店のGmail＋名前」のアドレスを作る（本人のメールが無いスタッフ用）。Gmail でなければ null */
export function plusAddress(storeEmail: string | null | undefined, nameEn: string | null | undefined, fallbackNo = 1): string | null {
  const m = (storeEmail || "").trim().toLowerCase().match(/^([^@+\s]+)(?:\+[^@]*)?@(gmail\.com|googlemail\.com)$/);
  if (!m) return null;
  const tag = (nameEn || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "").slice(0, 20) || `staff${fallbackNo}`;
  return `${m[1]}+${tag}@${m[2]}`;
}

// ---------------------------------------------------------------------------
// 状態の判定
// ---------------------------------------------------------------------------
export interface AuthInfo { id: string; email?: string | null; last_sign_in_at?: string | null; banned_until?: string | null; must_change?: boolean | null }
export function loginStatusOf(u: AuthInfo | null | undefined, now = Date.now()): LoginStatus {
  if (!u) return "none";
  if (u.banned_until && new Date(u.banned_until).getTime() > now) return "stopped";
  if (u.must_change || !u.last_sign_in_at) return "invited";
  return "active";
}

// ---------------------------------------------------------------------------
// 権限：誰が誰に何をできるか（サーバでも同じ関数で確かめる）
//  ・発行・招待・パスワード再設定・再開：オーナーだけ
//  ・止める：オーナー・店長（店長はオーナーを止められない）
//  ・自分のログインはここでは変えられない（自分を締め出さないように）
//  ・退職した人には、発行・再設定・再開はできない（先に在籍に戻す）
// ---------------------------------------------------------------------------
export interface LoginActor { staff_id?: string | null; auth_user_id?: string | null; role: StaffRole | null | undefined }
export interface LoginTarget { id: string; role: StaffRole; active?: boolean | null; auth_user_id?: string | null }
export function canSeeLoginStatus(role: StaffRole | null | undefined) { return role === "owner" || role === "manager"; }
export function loginPermissionError(kind: StaffLoginKind, actor: LoginActor, target: LoginTarget): string | null {
  const role = actor.role;
  if (role !== "owner" && role !== "manager") return "この操作はオーナー・店長だけができます";
  const self = (!!actor.staff_id && actor.staff_id === target.id) || (!!actor.auth_user_id && actor.auth_user_id === target.auth_user_id);
  if (self) return "自分のログインはここでは変えられません";
  if (kind === "stop") {
    if (target.role === "owner" && role !== "owner") return "オーナーのログインを止められるのはオーナーだけです";
    return null;
  }
  if (role !== "owner") return kind === "resume" ? "ログインの再開はオーナーだけができます" : "ログインの発行・パスワードの再設定はオーナーだけができます";
  if (target.active === false) return "退職した人にはできません（先に「在籍」に戻してください）";
  return null;
}
