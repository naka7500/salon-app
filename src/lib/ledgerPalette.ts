// 予約台帳の上に出す「チップ（パレット）」：IDLE／BREAK／×／保証 と、よく使うメニュー。
// チップを台帳の行・時刻へドラッグ（マウス・指・Apple Pencil）すると、ブロックを置く／予約の画面をそのメニューで開く。
// 画面に依存しない関数だけ（単体テストあり）。
import type { BlockKind, ID, Menu, Store } from "@/lib/db/types";

/** 既定で出すメニューの数（店舗の設定が無いとき：ネットに出している技術メニューの先頭から） */
export const PALETTE_DEFAULT_MAX = 8;
/** 選べる最大数（チップが多すぎると探しにくいので） */
export const PALETTE_MAX = 24;
/** 0014 の前（列が無いDB）や デモで、店舗ごとの選択を端末に置くときのキー */
export const paletteLocalKey = (storeId: ID) => `salon-app.ledger-palette.${storeId}`;

export type PaletteChip = { type: "block"; kind: BlockKind } | { type: "menu"; id: ID };
export type DropRowKind = "lane" | "staff" | "pair";

/** 台帳に出すメニュー（並び順つき）。ids が null/undefined なら既定（ネットに出す技術メニュー 先頭8件） */
export function paletteMenus(menus: Menu[], ids: ID[] | null | undefined): Menu[] {
  const usable = menus.filter(m => m.active !== false && m.category === "technical");
  if (Array.isArray(ids)) {
    const byId = new Map(usable.map(m => [m.id, m]));
    return ids.map(id => byId.get(id)).filter((m): m is Menu => !!m).slice(0, PALETTE_MAX);
  }
  const sorted = [...usable].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name, "ja"));
  const web = sorted.filter(m => m.web_visible !== false);
  return (web.length ? web : sorted).slice(0, PALETTE_DEFAULT_MAX);
}

/** 店舗の設定（DB）→ 端末の保存 → 既定 の順で、使う選択を決める */
export function resolvePaletteIds(store: Pick<Store, "id"> & { ledger_menu_ids?: ID[] | null } | null, local: string | null): ID[] | null {
  if (store && Array.isArray(store.ledger_menu_ids)) return store.ledger_menu_ids;
  if (local) { try { const v = JSON.parse(local); if (Array.isArray(v) && v.every(x => typeof x === "string")) return v; } catch {} }
  return null;
}

/** 落とした位置の分 → 開始時刻（店舗の「開始時刻の刻み」にそろえる。範囲の外は端に寄せる） */
export function snapStart(minute: number, step: number, min: number, max: number) {
  const s = Math.max(5, step || 30);
  const m = Math.round(minute / s) * s;
  const lo = Math.ceil(min / s) * s, hi = Math.floor((max - s) / s) * s;
  return Math.min(Math.max(m, lo), Math.max(lo, hi));
}

/** ブロックの既定の長さ（分）。置いたあとにクリックで変えられる */
export const BLOCK_DEFAULT_MIN: Record<BlockKind, number> = { idle: 60, break: 60, close: 60, guarantee: 30 };

/** そのブロックをその行に置けるか。置けないときは理由（日本語） */
export function blockDropError(kind: BlockKind, row: DropRowKind, hasPairLane: boolean): string | null {
  if (kind === "idle") return row === "pair" ? "IDLE（受付中）は「受付枠」かスタッフの行に置いてください" : null;
  if (kind === "break" || kind === "guarantee") return row === "staff" ? null : `${kind === "break" ? "BREAK" : "保証"}はスタッフの行に置いてください`;
  if (row === "pair" && !hasPairLane) return "ペアの受付枠が無いので、ペアの行には×を置けません";
  return null;
}
