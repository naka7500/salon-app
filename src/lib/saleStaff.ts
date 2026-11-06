// 会計の「主担当」と「明細担当」。画面に依存しない純粋な関数（単体テストあり）。
//  - 主担当：伝票の顔。スタッフ、または受付枠（「1名様でのご予約」「2名様でのご予約（ペア予約）」）・「フリー」。
//    KOKAGE は指名を取らないので、主担当は受付枠になる（カミングスーンと同じ）。売上の計算には使わない。
//  - 明細担当：1行ごとの担当。売上・担当別集計・給与の参考はすべて明細担当で数える。
//    店販は「最初におすすめした人」に付けるので、その日の施術者とは限らない（ほかの店舗のヘルプの人も選べる）。
import type { Booking, Lane, Sale, SaleLine, Staff, ID } from "@/lib/db/types";
import { laneIds } from "@/lib/web";

export const FREE_LABEL = "フリー";
/** 主担当の選択肢の値：'staff:<id>' | 'lane:<id>' | 'free' */
export type MainPick = string;
export function parseMain(v: MainPick, lanes: Lane[]): { main_staff_id: ID | null; main_label: string | null; main_lane_id: ID | null } {
  if (v.startsWith("staff:")) return { main_staff_id: v.slice(6) || null, main_label: null, main_lane_id: null };
  if (v.startsWith("lane:")) { const l = lanes.find(x => x.id === v.slice(5)); return { main_staff_id: null, main_label: l?.name ?? null, main_lane_id: l?.id ?? null }; }
  if (v === "free") return { main_staff_id: null, main_label: FREE_LABEL, main_lane_id: null };
  return { main_staff_id: null, main_label: null, main_lane_id: null };
}
/** 予約から主担当の初期値：指名の予約＝担当スタッフ／ペア＝ペアの受付枠／受付枠の予約＝その受付枠／それ以外＝担当スタッフ */
export function defaultMain(b: Pick<Booking, "staff_id" | "lane_id" | "nominated" | "pair_group"> | null, lanes: Lane[], laneOk: boolean, fallbackStaff?: ID | null): MainPick {
  if (!b) return fallbackStaff ? `staff:${fallbackStaff}` : "";
  if (b.nominated && b.staff_id) return `staff:${b.staff_id}`;
  if (laneOk) {
    const { pair } = laneIds(lanes);
    if (b.pair_group && pair) return `lane:${pair}`;
    if (b.lane_id && lanes.some(l => l.id === b.lane_id)) return `lane:${b.lane_id}`;
  }
  return b.staff_id ? `staff:${b.staff_id}` : fallbackStaff ? `staff:${fallbackStaff}` : "";
}
/** 伝票の主担当の表示（スタッフ名／受付枠・フリー） */
export function mainLabel(s: Pick<Sale, "main_staff_id" | "main_label">, staff: Staff[]) {
  if (s.main_staff_id) return staff.find(x => x.id === s.main_staff_id)?.name || "—";
  return s.main_label || "—";
}
/** 明細担当の名前を並べる（「富塚・菊池」） */
export function lineStaffNames(s: Pick<Sale, "lines">, staff: Staff[]) {
  const ids = [...new Set(s.lines.map(l => l.staff_id).filter((x): x is ID => !!x))];
  return ids.map(id => staff.find(x => x.id === id)?.name || "—").join("・") || "—";
}
/** そのお客様の前回の店販の担当（新しい伝票から順に、店販の行の担当） */
export function lastProductStaff(sales: Sale[], customerId?: ID | null): ID | null {
  if (!customerId) return null;
  const xs = sales.filter(s => s.customer_id === customerId && s.status === "confirmed").sort((a, b) => b.sold_at.localeCompare(a.sold_at));
  for (const s of xs) { const l = s.lines.find(x => x.kind === "product" && x.staff_id); if (l) return l.staff_id!; }
  return null;
}
/** 行を足すときの明細担当の初期値：技術（メニュー・オプション・指名料）＝施術担当（予約の担当／主担当がスタッフならその人）、店販＝空（選ぶまで確定できない） */
export function defaultLineStaff(kind: SaleLine["kind"], serviceStaff: ID | null | undefined): ID | null {
  if (kind === "product") return null;
  return serviceStaff || null;
}
/** 明細担当が空の行の番号（確定前のチェック） */
export function missingLineStaff(lines: Pick<SaleLine, "staff_id">[]) { return lines.map((l, i) => (l.staff_id ? -1 : i)).filter(i => i >= 0); }

/** 明細担当の選択肢：この店舗の人 → ほかの店舗の人（ヘルプ）→ 退職（今の値だけ）。会社の全員から */
export function lineStaffOptions(all: Staff[], storeId: ID | null | undefined, current?: ID | null) {
  const act = all.filter(s => s.active !== false && s.role !== "viewer");
  const here = act.filter(s => !storeId || !s.store_ids || s.store_ids.includes(storeId) || s.home_store_id === storeId);
  const other = act.filter(s => !here.includes(s));
  const gone = current ? all.filter(s => s.id === current && s.active === false) : [];
  return { here, other, gone };
}
