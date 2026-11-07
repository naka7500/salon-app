// LINE連携の「つないでよいか」「前回の入力を返してよいか」の決まり（純粋関数。server.ts・デモ・単体テストで同じものを使う）。
// 監査 2026-11-07 R1 ＋ オーナー決定 2026-11-08（0020）：
//  ・LINEの中の予約（booking モード）で自動でつなぐのは、その予約でお客様を新しく作ったとき（bookings.customer_created＝0019）だけ
//  ・既存のお客様（電話番号が一致）に当たったときは、LINEがつながっていてもいなくても、つながず「確認待ち」（line_link_requests）を作る
//    → スタッフが予約詳細・顧客詳細で承認したときだけつなぐ（staff_approved）。会計のQR（token）はもう1つの信頼できる道
//  ・前回の入力（/api/line/me）は token・booking_new・staff_approved のつながりだけ
import type { LineLink } from "./types";
import { linkSendable } from "./types";

export type LinkedVia = "token" | "staff_approved" | "booking_new" | "booking";
/** 信頼の強さ（大きいほど強い）。弱い経路でつなぎ直しても下げない */
const RANK: Record<LinkedVia, number> = { token: 4, staff_approved: 3, booking_new: 2, booking: 1 };
export const rankOf = (v: string | null | undefined): number => (v && v in RANK ? RANK[v as LinkedVia] : 0);
/** つなぎ直したときの経路：前より弱くはしない */
export function mergeLinkedVia(prev: string | null | undefined, next: LinkedVia): LinkedVia {
  return rankOf(prev) > RANK[next] ? (prev as LinkedVia) : next;
}

/** booking モードの元になる予約（必要な列だけ） */
export interface LinkBookingRow { id?: string; customer_id: string | null; created_at: string; customer_created?: boolean | null }
export type BookingLinkDecision =
  | { kind: "link"; customerId: string; via: "booking_new" }   // 新しく作られたお客様 → つなぐ
  | { kind: "already"; customerId: string }                    // 既存のお客様に、もう同じ LINE がつながっている → 何も変えない
  | { kind: "request"; customerId: string }                    // 既存のお客様 → つながず確認待ちを作る
  | { kind: "error"; status: number; message: string };

/** LINE予約のあとの自動連携（booking モード）の決め方 */
export const LINK_WINDOW_MS = 2 * 3600_000;
/** 確認待ちになったときにお客様に見せる文 */
export const LINK_PENDING_MSG = "LINEのお知らせは、ご来店時にお店で確認してからお届けします";
export function bookingLinkDecision(p: { booking: LinkBookingRow | null; lineUserId: string; existingLink: LineLink | null; now?: number }): BookingLinkDecision {
  const b = p.booking;
  if (!b?.customer_id || (p.now ?? Date.now()) - Date.parse(b.created_at) > LINK_WINDOW_MS) return { kind: "error", status: 410, message: "予約が見つかりません" };
  if (b.customer_created === true) return { kind: "link", customerId: b.customer_id, via: "booking_new" };
  if (p.existingLink && p.existingLink.customer_id === b.customer_id && p.existingLink.line_user_id === p.lineUserId) return { kind: "already", customerId: b.customer_id };
  return { kind: "request", customerId: b.customer_id };
}

/** /api/line/me で名前・電話・メールを返してよいつながりか（linked_at があり、経路が token・booking_new・staff_approved） */
export const PREFILL_VIA: readonly LinkedVia[] = ["token", "booking_new", "staff_approved"];
export function prefillAllowed(l: Pick<LineLink, "customer_id" | "linked_at" | "linked_via" | "needs_confirm"> | null | undefined): boolean {
  return !!l && !!l.customer_id && !!l.linked_at && !!l.linked_via && !l.needs_confirm && PREFILL_VIA.includes(l.linked_via as LinkedVia);
}

// ---------------------------------------------------------------------------
// 確認待ち（line_link_requests）
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

/** 確認待ちが「今つながっている LINE の持ち主の確認」（C7：LINE予約で作られたお客様に別の予約が寄った）か */
export const isOwnerCheck = (r: Pick<LineLinkRequest, "line_user_id">, current: Pick<LineLink, "line_user_id" | "customer_id"> | null | undefined) => !!current?.customer_id && current.line_user_id === r.line_user_id;

/** 監査ログ（audit_logs.table_name='line_link'）の action */
export type LinkAuditAction = "link_create" | "link_repoint" | "link_remove" | "request_create" | "request_approve" | "request_reject";
export const LINK_AUDIT_TABLE = "line_link";
