// 予約トラッキング（カミングスーンの「予約情報トラッキング」と同じ考え方）。予約1件の 登録・変更・キャンセル・削除 の記録を表にする。
// 画面に依存しない純粋な関数（単体テストあり）。記録は 0013 のトリガーが自動で残す（期限なし。カミングスーンは90日で消える）。
import type { Booking, BookingHistoryEntry, Lane, Menu, Staff } from "@/lib/db/types";
import { bookingMenuLabel } from "@/lib/web";

export type TrackField = "menu" | "staff" | "start" | "end" | "status";
export interface TrackRow {
  key: string; state: string; route: string; at: string;
  menu: string; staff: string; start: string; end: string;
  /** 前の記録から変わった項目（赤く出す） */ changed: TrackField[];
  /** 0013 より前に入った予約の「登録」（予約の作成日時と経路から推定） */ estimated?: boolean;
}
const OTA: Record<string, string> = { viator: "Viator", klook: "Klook", ikyu: "一休" };
const CH: Record<string, string> = { own: "自社", hpb: "HPB", phone: "電話", walkin: "来店", line: "LINE", ...OTA };
const pad = (n: number) => String(n).padStart(2, "0");
const fmt = (iso?: string | null, sec = false) => {
  if (!iso) return "—"; const d = new Date(iso);
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${sec ? `:${pad(d.getSeconds())}` : ""}`;
};

/** 操作経路の表示 */
export function routeLabel(e: Pick<BookingHistoryEntry, "source" | "op" | "actor_name">, channel?: string | null) {
  const who = e.actor_name?.trim() || "スタッフ";
  if (e.source === "web") return e.op === "cancel" ? "ネット予約（お客様がキャンセル）" : "ネット予約";
  if (e.source === "hpb") return "HPB取り込み";
  if (e.source === "system") return "自動処理";
  // 予約台帳（スタッフの操作）。登録のときは受けた経路も出す（電話・LINE・OTA など）
  if (e.op === "insert" && channel && channel !== "own" && channel !== "block") {
    const ch = OTA[channel] ? `OTA・${OTA[channel]}` : CH[channel] || channel;
    return `${ch}（予約台帳・${who}）`;
  }
  return `予約台帳（${who}）`;
}

/** 状態の表示 */
export function stateLabel(e: Pick<BookingHistoryEntry, "op">, prev: Partial<Booking> | null, cur: Partial<Booking>) {
  if (e.op === "insert") return "登録";
  if (e.op === "cancel") return "キャンセル";
  if (e.op === "delete") return "削除";
  if (prev && prev.status !== cur.status) {
    if (cur.status === "done") return "会計";
    if (cur.status === "arrived") return "来店";
    if (cur.status === "noshow") return "無断キャンセル";
    if (cur.status === "booked" && (prev.status === "cancelled" || prev.status === "noshow")) return "予約に戻す";
  }
  return "変更";
}

export interface TrackCtx { menus: Menu[]; staff: Staff[]; lanes: Lane[] }
export function staffLaneLabel(b: Partial<Booking>, c: TrackCtx) {
  const lane = b.lane_id ? c.lanes.find(l => l.id === b.lane_id)?.name : null;
  const st = b.staff_id ? c.staff.find(s => s.id === b.staff_id)?.name || "（不明な担当）" : "担当なし";
  return `${lane ? `${lane}／` : ""}${st}${b.nominated ? "（指名）" : "（フリー）"}`;
}
function diff(prev: Partial<Booking> | null, cur: Partial<Booking>): TrackField[] {
  if (!prev) return [];
  const out: TrackField[] = [];
  if ((prev.menu_ids || []).join(",") !== (cur.menu_ids || []).join(",")) out.push("menu");
  if ((prev.staff_id || null) !== (cur.staff_id || null) || (prev.lane_id || null) !== (cur.lane_id || null) || !!prev.nominated !== !!cur.nominated) out.push("staff");
  if (prev.start_at && cur.start_at && new Date(prev.start_at).getTime() !== new Date(cur.start_at).getTime()) out.push("start");
  if (prev.end_at && cur.end_at && new Date(prev.end_at).getTime() !== new Date(cur.end_at).getTime()) out.push("end");
  if (prev.status !== cur.status) out.push("status");
  return out;
}
/** 0013 より前に入った予約の経路の推定 */
function guessSource(b: Partial<Booking>): BookingHistoryEntry["source"] {
  if (b.channel === "hpb") return "hpb";
  if (b.channel === "own" && (b.cancel_token || b.booking_no)) return "web";
  return "ledger";
}

/** 表の行（古い順）。記録に「登録」が無い予約は、最初の記録の「変更前」（無ければ今の予約）から登録の行を推定して先頭に足す */
export function trackingRows(entries: BookingHistoryEntry[], booking: Partial<Booking>, c: TrackCtx): TrackRow[] {
  const list = [...entries].sort((a, b) => a.at.localeCompare(b.at) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const rows: TrackRow[] = [];
  let prev: Partial<Booking> | null = null;
  if (!list.some(e => e.op === "insert")) {
    const base = list[0]?.before || booking;
    if (base && (base.start_at || booking.created_at)) {
      const src = guessSource(base);
      rows.push({ key: "est", state: "登録", route: `${src === "web" ? "ネット予約" : src === "hpb" ? "HPB取り込み" : `${CH[base.channel || ""] || "予約台帳"}`}（記録開始前・推定）`, at: fmt(booking.created_at, true),
        menu: bookingMenuLabel(base.menu_ids || [], c.menus) || "—", staff: staffLaneLabel(base, c), start: fmt(base.start_at), end: fmt(base.end_at), changed: [], estimated: true });
      prev = base;
    }
  }
  for (const e of list) {
    const cur = e.snapshot;
    const p = e.before ?? prev;
    rows.push({ key: String(e.id), state: stateLabel(e, p, cur), route: routeLabel(e, cur.channel ?? p?.channel), at: fmt(e.at, true),
      menu: bookingMenuLabel(cur.menu_ids || [], c.menus) || "—", staff: staffLaneLabel(cur, c), start: fmt(cur.start_at), end: fmt(cur.end_at),
      changed: e.op === "insert" ? [] : diff(p, cur) });
    prev = cur;
  }
  return rows;
}

/** 記録に残す予約の項目（デモの保存量を抑えるため。本番は行全体を残す） */
export const HISTORY_FIELDS = ["store_id", "customer_id", "customer_name", "staff_id", "lane_id", "start_at", "end_at", "status", "channel", "menu_ids", "nominated", "pair_group", "coupon_id", "booking_no", "external_ref"] as const;
export function pickHistory(b: Partial<Booking>): Partial<Booking> {
  const o: Record<string, unknown> = {};
  for (const k of HISTORY_FIELDS) if (b[k] !== undefined) o[k] = b[k];
  return o as Partial<Booking>;
}
/** 記録する価値のある変更か（更新日時だけの変更・ブロックは残さない） */
export function worthRecording(before: Partial<Booking> | null, after: Partial<Booking> | null) {
  const b = before, a = after;
  if ((b?.status ?? "block") === "block" && (a?.status ?? "block") === "block") return false;
  if (!b || !a) return true;
  return HISTORY_FIELDS.some(k => JSON.stringify(b[k] ?? null) !== JSON.stringify(a[k] ?? null));
}
/** 操作の種類 */
export function opOf(before: Partial<Booking> | null, after: Partial<Booking> | null): BookingHistoryEntry["op"] {
  if (!before) return "insert";
  if (!after) return "delete";
  return after.status === "cancelled" && before.status !== "cancelled" ? "cancel" : "update";
}
