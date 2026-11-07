// LINE連携の「つないでよいか」「前回の入力を返してよいか」の決まり（純粋関数。server.ts と単体テストで同じものを使う）。
// 監査 2026-11-07 R1：LINEの中の予約（booking モード）は、電話番号だけで他人のお客様情報に自分の LINE をつなげられたため、
//  ・その予約でお客様を新しく作ったとき（bookings.customer_created＝0019）か、
//  ・そのお客様にまだ別の LINE がつながっていないとき
// だけつなぐ。別の LINE がつながっている既存のお客様は付け替えない（会計のQR＝token モードだけが付け替えられる）。
// 前回の入力（/api/line/me）は、会計のQRでつないだ（token）か、LINE予約で新しく作られたお客様（booking_new）のときだけ返す。
import type { LineLink } from "./types";

export type LinkedVia = "token" | "booking_new" | "booking";
/** 信頼の強さ（大きいほど強い）。弱い経路でつなぎ直しても下げない */
const RANK: Record<LinkedVia, number> = { token: 3, booking_new: 2, booking: 1 };
export const rankOf = (v: string | null | undefined): number => (v && v in RANK ? RANK[v as LinkedVia] : 0);
/** つなぎ直したときの経路：前より弱くはしない */
export function mergeLinkedVia(prev: string | null | undefined, next: LinkedVia): LinkedVia {
  return rankOf(prev) > RANK[next] ? (prev as LinkedVia) : next;
}

/** booking モードの元になる予約（必要な列だけ） */
export interface LinkBookingRow { customer_id: string | null; created_at: string; customer_created?: boolean | null }
export type BookingLinkDecision =
  | { ok: true; customerId: string; via: Extract<LinkedVia, "booking_new" | "booking"> }
  | { ok: false; status: number; message: string };

/** LINE予約のあとの自動連携（booking モード）でつないでよいか */
export const LINK_WINDOW_MS = 2 * 3600_000;
export const BOOKING_LINK_TAKEN_MSG = "このお客様情報には別のLINEがつながっています。お店で会計のときにQRコードを出してもらってください";
export function bookingLinkDecision(p: { booking: LinkBookingRow | null; lineUserId: string; existingLink: LineLink | null; now?: number }): BookingLinkDecision {
  const b = p.booking;
  if (!b?.customer_id || (p.now ?? Date.now()) - Date.parse(b.created_at) > LINK_WINDOW_MS) return { ok: false, status: 410, message: "予約が見つかりません" };
  if (b.customer_created === true) return { ok: true, customerId: b.customer_id, via: "booking_new" };
  // 既存のお客様：まだ LINE がつながっていない、または つながっているのが自分（同じ LINE）のときだけ
  if (p.existingLink && p.existingLink.line_user_id !== p.lineUserId) return { ok: false, status: 409, message: BOOKING_LINK_TAKEN_MSG };
  return { ok: true, customerId: b.customer_id, via: "booking" };
}

/** /api/line/me で名前・電話・メールを返してよいつながりか（linked_at があり、経路が token か booking_new） */
export function prefillAllowed(l: Pick<LineLink, "customer_id" | "linked_at" | "linked_via"> | null | undefined): boolean {
  return !!l && !!l.customer_id && !!l.linked_at && (l.linked_via === "token" || l.linked_via === "booking_new");
}
