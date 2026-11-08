// LINE連携の「つないでよいか」「前回の入力を返してよいか」の決まり（純粋関数。server.ts・デモ・単体テストで同じものを使う）。
// オーナー決定「案B」2026-11-08（0022）：
//  ・LINEの中の予約（LIFF）では、LINEのユーザーIDがそのお客様の本人。電話番号では既存のお客様に一切つながない
//    → そのLINEにつながったお客様がいればその人の予約、いなければ新しいお客様を作ってすぐつなぐ（linked_via='line_id'）。
//      予約の確定は anon の RPC ではなく、サーバ /api/line/book（IDトークンを LINE で確かめ、service_role で service_create_booking を呼ぶ）
//  ・LINE予約から「確認待ち」（0020 の line_link_requests）は作らない。会計のQR（token）は今までどおり
//  ・前回の入力（/api/line/me）は line_id・token・booking_new・staff_approved のつながりだけ
//  ・同じ電話番号のお客様が2人以上いるときは、スタッフが見て「統合する」（自動では統合しない）
import type { LineLink } from "./types";
import { linkSendable } from "./types";

export type LinkedVia = "token" | "staff_approved" | "line_id" | "booking_new" | "booking";
/** 信頼の強さ（大きいほど強い）。弱い経路でつなぎ直しても下げない。line_id＝LINE予約で本人（案B）は staff_approved と同じ強さ */
const RANK: Record<LinkedVia, number> = { token: 4, staff_approved: 3, line_id: 3, booking_new: 2, booking: 1 };
export const rankOf = (v: string | null | undefined): number => (v && v in RANK ? RANK[v as LinkedVia] : 0);
/** つなぎ直したときの経路：前より弱くはしない */
export function mergeLinkedVia(prev: string | null | undefined, next: LinkedVia): LinkedVia {
  return rankOf(prev) > RANK[next] ? (prev as LinkedVia) : next;
}

/** /api/line/me で名前・電話・メールを返してよいつながりか（linked_at があり、経路が line_id・token・booking_new・staff_approved） */
export const PREFILL_VIA: readonly LinkedVia[] = ["line_id", "token", "booking_new", "staff_approved"];
export function prefillAllowed(l: Pick<LineLink, "customer_id" | "linked_at" | "linked_via" | "needs_confirm"> | null | undefined): boolean {
  return !!l && !!l.customer_id && !!l.linked_at && !!l.linked_via && !l.needs_confirm && PREFILL_VIA.includes(l.linked_via as LinkedVia);
}

// ---------------------------------------------------------------------------
// LINE予約（/api/line/book）の入力の確かめ（DB・LINE に触る前に止める）
// ---------------------------------------------------------------------------
export const LINE_USER_RE = /^U[0-9a-f]{32}$/;
export const JWT_RE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface LineBookBody {
  slug: string; idToken: string;
  menu_id: string; start_at: string; name: string; kana: string; phone: string; email: string;
  intake?: { label: string; answer: string }[]; coupon_id?: string | null; code?: string | null; staff_id?: string | null; lang?: "ja" | "en"; option_ids?: string[];
}
/** 形だけの確かめ（値の正しさ＝文字数・メニュー・空き・料金は DB の関数が確かめる）。null＝よい */
export function lineBookInputError(b: unknown): string | null {
  const x = b as Partial<LineBookBody> | null;
  if (!x || typeof x !== "object") return "bad_request";
  if (typeof x.slug !== "string" || !x.slug.trim() || x.slug.length > 60) return "bad_request";
  if (typeof x.idToken !== "string" || x.idToken.length > 4000 || !JWT_RE.test(x.idToken)) return "bad_request";
  if (typeof x.menu_id !== "string" || !UUID_RE.test(x.menu_id)) return "menu_not_found";
  if (typeof x.start_at !== "string" || !Number.isFinite(Date.parse(x.start_at))) return "invalid_start";
  for (const k of ["name", "kana", "phone", "email"] as const) if (typeof x[k] !== "string" || (x[k] as string).length > 200) return `invalid_${k}`;
  if (x.intake !== undefined && (!Array.isArray(x.intake) || x.intake.length > 30 || JSON.stringify(x.intake).length > 8000)) return "invalid_intake";
  if (x.coupon_id != null && (typeof x.coupon_id !== "string" || !UUID_RE.test(x.coupon_id))) return "coupon_invalid";
  if (x.staff_id != null && (typeof x.staff_id !== "string" || !UUID_RE.test(x.staff_id))) return "bad_request";
  if (x.code != null && (typeof x.code !== "string" || x.code.length > 40)) return "coupon_code";
  if (x.lang != null && x.lang !== "ja" && x.lang !== "en") return "bad_request";
  if (x.option_ids !== undefined && (!Array.isArray(x.option_ids) || x.option_ids.length > 10 || x.option_ids.some(o => typeof o !== "string" || !UUID_RE.test(o)))) return "option_invalid";
  return null;
}
/** DB の関数が返すエラー（slot_taken など）は英数字と _ だけ。それ以外（DBの中身が分かる文）はお客様に見せない */
export const SQL_CODE_RE = /^[a-z_]{3,40}$/;
export const bookErrorForClient = (msg: string | null | undefined) => (msg && SQL_CODE_RE.test(msg) ? msg : "うまくいきませんでした（時間をおいてもう一度）");

// ---------------------------------------------------------------------------
// 同じ電話番号のお客様（ヒント）と統合の決まり
// ---------------------------------------------------------------------------
/** 電話番号を数字だけに（SQL の _norm_phone と同じ） */
export function normPhoneDigits(p: string | null | undefined): string {
  const d = (p || "").replace(/[^0-9]/g, "");
  return /^81[0-9]{9,10}$/.test(d) ? "0" + d.slice(2) : d;
}
/** 同じ電話番号（8桁以上）の、統合されていない別のお客様 */
export function samePhoneCustomers<T extends { id: string; phone?: string | null; merged_into?: string | null; company_id?: string }>(me: T, all: T[]): T[] {
  const p = normPhoneDigits(me.phone);
  if (p.length < 8) return [];
  return all.filter(c => c.id !== me.id && !c.merged_into && (!me.company_id || !c.company_id || c.company_id === me.company_id) && normPhoneDigits(c.phone) === p);
}
export const duplicateHint = (name: string, visits: number) => `同じ電話番号のお客様がいます：${name}様（来店${visits}回）`;
/** 統合できる役割（在籍の owner・manager・staff。SQL の can_write_company と同じ） */
export const canMerge = (role: string | null | undefined) => role === "owner" || role === "manager" || role === "staff";
export const MERGE_ERR: Record<string, string> = {
  merge_same: "同じお客様です", not_found: "お客様が見つかりません", merge_company_mismatch: "ほかの会社のお客様とは統合できません",
  already_merged: "もう統合されています（画面を開き直してください）", forbidden: "統合できるのは、在籍のオーナー・店長・スタッフだけです",
};

// ---------------------------------------------------------------------------
// 確認待ち（line_link_requests）：0022 以降は LINE予約からは作らない。残っているものの決着と、デモ・テストのために残す
// ---------------------------------------------------------------------------
export type LinkRequestStatus = "pending" | "approved" | "rejected" | "expired";
export interface LineLinkRequest {
  id: string; store_id: string; customer_id: string; booking_id?: string | null; line_user_id: string; display_name?: string | null;
  created_at: string; status: LinkRequestStatus; decided_by?: string | null; decided_at?: string | null;
}
export const REQUEST_TTL_DAYS = 30;
export const requestExpired = (r: Pick<LineLinkRequest, "created_at">, now = Date.now()) => now - Date.parse(r.created_at) > REQUEST_TTL_DAYS * 86400_000;
/** 画面に出す確認待ち（pending で30日以内） */
export const openRequests = <T extends Pick<LineLinkRequest, "status" | "created_at">>(rs: T[] | null | undefined, now = Date.now()) => (rs || []).filter(r => r.status === "pending" && !requestExpired(r, now));

/** 承認・つながないを決めてよいか（在籍の owner・manager・staff。viewer・退職者はだめ）。null＝よい */
export function decideRequestError(p: { role: string | null | undefined; request: Pick<LineLinkRequest, "status" | "created_at"> | null; now?: number }): { status: number; message: string } | null {
  if (p.role !== "owner" && p.role !== "manager" && p.role !== "staff") return { status: 403, message: "LINE連携の確認は、在籍のオーナー・店長・スタッフだけができます" };
  if (!p.request) return { status: 404, message: "確認待ちが見つかりません" };
  if (p.request.status !== "pending") return { status: 409, message: "この確認待ちは、もう決まっています（画面を開き直してください）" };
  if (requestExpired(p.request, p.now)) return { status: 410, message: `${REQUEST_TTL_DAYS}日を過ぎたので期限切れです。お店で会計のときにQRコードでつないでください` };
  return null;
}

// ---------------------------------------------------------------------------
// 付け替えのお知らせ（前の LINE へ）
// ---------------------------------------------------------------------------
export const REPOINT_NOTICE_KIND = "link_notice";
export const repointNoticeText = (storeName: string) => `${storeName}のお知らせの送り先が変更されました。心当たりがない場合はお店にご連絡ください。`;
/** 前の LINE に知らせるか：別の LINE に付け替わり、前の LINE が友だちのまま・お知らせ停止していないときだけ */
export function shouldNotifyOld(old: LineLink | null | undefined, newLineUserId: string): boolean {
  return !!old && old.line_user_id !== newLineUserId && linkSendable(old);
}

/** 確認待ちが「今つながっている LINE の持ち主の確認」（0020 C7 の残り）か */
export const isOwnerCheck = (r: Pick<LineLinkRequest, "line_user_id">, current: Pick<LineLink, "line_user_id" | "customer_id"> | null | undefined) => !!current?.customer_id && current.line_user_id === r.line_user_id;

/** 監査ログ（audit_logs.table_name='line_link'）の action */
export type LinkAuditAction = "link_create" | "link_repoint" | "link_remove" | "request_create" | "request_approve" | "request_reject";
export const LINK_AUDIT_TABLE = "line_link";
