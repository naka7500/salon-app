// スタッフが手で送る LINE（予約詳細の「LINEで連絡」・台帳の「この日のお客様に連絡」）。
// 自動メッセージではない（人が内容を確かめて送る）ので、「LINE連携を使う」がオフでも送れる。ただし秘密（チャネルシークレット・アクセストークン）が保存済みのときだけ。
// ここは画面とサーバの両方で使う「決まり」だけ（送信はしない）。サーバは必ずもう一度ここで確かめる（画面の言うことは信じない）。
import type { ID } from "@/lib/db/types";
import type { LineLink } from "./types";
import { jaDate } from "./engine";

/** line_messages.kind（0015 に kind の制約は無いので、新しい値でもDB更新は要らない） */
export const MANUAL_KIND = "manual";
/** 1通の文字数の上限 */
export const MANUAL_TEXT_MAX = 1000;
/** 同じ予約へは1時間に3通まで（押しまちがい・二重送信の防止） */
export const MANUAL_PER_BOOKING_PER_HOUR = 3;
/** 店舗全体で1時間に送れる手動の数（まちがって大量に送らないための安全柵） */
export const MANUAL_PER_STORE_PER_HOUR = 120;
/** 1回にまとめて送れる人数 */
export const MANUAL_BATCH_MAX = 50;

export interface ManualItem { booking_id: ID; text: string }
export interface ManualResult { booking_id: ID; ok: boolean; message: string }
export interface ManualSendResult { ok: boolean; message: string; results: ManualResult[]; used?: number; limit?: number }

export type LineStatus = "linked" | "none" | "stopped";
export const LINE_STATUS_LABEL: Record<LineStatus, string> = { linked: "LINEでつながっている", none: "LINEとつながっていない", stopped: "LINEの配信停止中" };
/** お客様の LINE の状態：つながっている／つながっていない／配信停止中（お知らせ停止・ブロック） */
export function lineStatusOf(l: Pick<LineLink, "followed" | "opted_out"> | null | undefined): LineStatus {
  if (!l) return "none";
  if (l.opted_out || !l.followed) return "stopped";
  return "linked";
}

/** 手で送ってよい役割（オーナー・店長・スタッフ。閲覧のみ・退職は不可） */
export const canSendManual = (role: string | null | undefined, active: boolean | null | undefined = true) =>
  active !== false && (role === "owner" || role === "manager" || role === "staff");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 改行・タブ以外の見えない制御文字
const CTRL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// 見える文字（文字・数字・記号・絵文字）が1つでもあるか（ゼロ幅スペース・BOM・方向制御だけの本文を弾く。監査 L7）
const VISIBLE_RE = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** 本文の確認。問題なければ null（前後の空白は送る前に取る） */
export function manualTextError(text: unknown): string | null {
  if (typeof text !== "string") return "本文が空です";
  const t = text.trim();
  if (!t) return "本文が空です";
  if (t.length > MANUAL_TEXT_MAX) return `本文が長すぎます（${t.length}文字。${MANUAL_TEXT_MAX}文字まで）`;
  if (CTRL_RE.test(t)) return "本文に使えない文字が入っています";
  if (!VISIBLE_RE.test(t)) return "本文が空です";
  return null;
}

/** 画面から来た内容を確かめて、送る形にそろえる（同じ予約が2回あれば1回にする） */
export function parseManualItems(body: unknown): { items: ManualItem[] } | { error: string } {
  const raw = (body as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw) || raw.length === 0) return { error: "送る相手がいません" };
  if (raw.length > MANUAL_BATCH_MAX) return { error: `一度に送れるのは${MANUAL_BATCH_MAX}人までです` };
  const seen = new Set<string>(); const items: ManualItem[] = [];
  for (const x of raw) {
    const id = (x as { booking_id?: unknown })?.booking_id; const text = (x as { text?: unknown })?.text;
    if (typeof id !== "string" || !UUID_RE.test(id)) return { error: "予約が分かりません" };
    const e = manualTextError(text);
    if (e) return { error: e };
    if (seen.has(id)) continue;
    seen.add(id); items.push({ booking_id: id, text: (text as string).trim() });
  }
  return { items };
}

/** 送る前の確認（1人分）。送ってよければ null、だめなら理由（画面にそのまま出す） */
export function manualSendError(p: {
  booking: { store_id: ID; status: string; customer_id?: ID | null } | null;
  storeId: ID;
  link: Pick<LineLink, "followed" | "opted_out" | "line_user_id"> | null;
  recentForBooking: number;
  recentForStore: number;
  used: number; limit: number;
}): string | null {
  const b = p.booking;
  if (!b || b.store_id !== p.storeId) return "予約が見つかりません";
  if (b.status === "cancelled") return "キャンセル済みの予約には送りません";
  if (b.status === "block") return "予約ではありません";
  if (!b.customer_id) return "お客様が登録されていない予約です";
  const st = lineStatusOf(p.link);
  if (st === "none") return "このお客様はLINEとつながっていません（お電話で連絡してください）";
  if (st === "stopped") return "このお客様はLINEの配信停止中です（お電話で連絡してください）";
  if (p.recentForBooking >= MANUAL_PER_BOOKING_PER_HOUR) return `この予約には1時間に${MANUAL_PER_BOOKING_PER_HOUR}通まで送れます。少し時間をおいてください`;
  if (p.recentForStore >= MANUAL_PER_STORE_PER_HOUR) return `1時間に送れる数（${MANUAL_PER_STORE_PER_HOUR}通）に達しました。少し時間をおいてください`;
  if (p.used >= p.limit) return `今月の通数の上限（${p.limit}通）に達しています`;
  return null;
}

/** 今月の残り通数 */
export const quotaLeft = (used: number, limit: number) => Math.max(0, limit - used);

/** 文面の差し込み（台帳の「この日のお客様に連絡」で、お一人ずつ入れ替える） */
export const MANUAL_VARS = ["{お名前}", "{日時}", "{メニュー}"] as const;

/** スタッフの急なお休みのときの文面（差し込みのまま）。送る前に画面で直せる */
export function absenceTemplateRaw(storeName: string, phone?: string | null) {
  return [
    "{お名前}様",
    "",
    `いつも${storeName}をご利用いただきありがとうございます。`,
    `${storeName}です。`,
    "",
    "{日時}〜「{メニュー}」でご予約をいただいておりますが、担当スタッフが急な体調不良のため、お休みをいただくことになりました。",
    "直前のご案内となってしまい、本当に申し訳ございません。",
    "",
    "日時の変更、またはほかのスタッフでのご案内をご相談させてください。",
    "ご都合のよい日時を、このLINEにお返事いただけますと幸いです。",
    "今回は見送られる場合も、キャンセル料は一切かかりません。",
    "",
    phone ? `${storeName}（${phone}）` : storeName,
  ].join("\n");
}

/** 差し込みを、その予約の名前・日時・メニューに入れ替える */
export function fillManualText(tpl: string, p: { customerName?: string | null; startAt: string; menu?: string | null }) {
  const d = jaDate(p.startAt);
  const name = (p.customerName || "").trim() || "お客";
  const menu = (p.menu || "").trim();
  return tpl
    .replace(/「\{メニュー\}」/g, menu ? `「${menu}」` : "")
    .replace(/\{お名前\}/g, name)
    .replace(/\{日時\}/g, `${d.date} ${d.time}`)
    .replace(/\{メニュー\}/g, menu);
}

/** スタッフの急なお休みのときの文面（その予約の内容を入れたもの） */
export function absenceTemplate(p: { storeName: string; customerName: string; startAt: string; menu?: string | null; phone?: string | null }) {
  return fillManualText(absenceTemplateRaw(p.storeName, p.phone), p);
}

// ---------------------------------------------------------------------------
// 顧客詳細からの「LINEで連絡」（予約に結びつけない1人あて）
// ---------------------------------------------------------------------------
/** 同じお客様へは1時間に3通まで（予約からの手動送信もふくめて数える） */
export const MANUAL_PER_CUSTOMER_PER_HOUR = 3;

export interface DirectItem { customer_id: ID; text: string }
export interface DirectSendResult { ok: boolean; message: string; used?: number; limit?: number }

/** 画面から来た内容（customer_id ＋ 本文）を確かめる */
export function parseDirectBody(body: unknown): DirectItem | { error: string } {
  const b = body as { customer_id?: unknown; text?: unknown } | null;
  const id = b?.customer_id;
  if (typeof id !== "string" || !UUID_RE.test(id)) return { error: "お客様が分かりません" };
  const e = manualTextError(b?.text);
  if (e) return { error: e };
  return { customer_id: id, text: (b!.text as string).trim() };
}

/** 送る前の確認（顧客詳細から）。送ってよければ null、だめなら理由 */
export function directSendError(p: {
  customer: { company_id: ID; merged_into?: ID | null } | null;
  companyId: ID;
  link: Pick<LineLink, "followed" | "opted_out" | "line_user_id"> | null;
  recentForCustomer: number;
  recentForStore: number;
  used: number; limit: number;
}): string | null {
  if (!p.customer || p.customer.company_id !== p.companyId) return "お客様が見つかりません";
  if (p.customer.merged_into) return "このお客様は別のお客様に統合済みです（統合先から送ってください）";
  const st = lineStatusOf(p.link);
  if (st === "none") return "このお客様はLINEとつながっていません（お電話で連絡してください）";
  if (st === "stopped") return "このお客様はLINEの配信停止中です（お電話で連絡してください）";
  if (p.recentForCustomer >= MANUAL_PER_CUSTOMER_PER_HOUR) return `このお客様には1時間に${MANUAL_PER_CUSTOMER_PER_HOUR}通まで送れます。少し時間をおいてください`;
  if (p.recentForStore >= MANUAL_PER_STORE_PER_HOUR) return `1時間に送れる数（${MANUAL_PER_STORE_PER_HOUR}通）に達しました。少し時間をおいてください`;
  if (p.used >= p.limit) return `今月の通数の上限（${p.limit}通）に達しています`;
  return null;
}

/** 顧客詳細の「LINEで連絡」の最初の文面（ふつうの連絡用。直して使う） */
export function directTemplate(p: { customerName?: string | null; storeName: string; phone?: string | null }) {
  const name = (p.customerName || "").trim() || "お客";
  return [
    `${name}様`,
    `${p.storeName}です。`,
    "",
    "",
    "",
    p.phone ? `${p.storeName}（${p.phone}）` : p.storeName,
  ].join("\n");
}
