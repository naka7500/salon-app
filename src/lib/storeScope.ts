// 店舗の色・集計の対象（全店／この店舗）
import { isTestStore, type Store } from "@/lib/db";

// 店舗ごとの色（どの店舗を見ているか一目で分かるように）。テスト店舗は黄色
const PALETTE = ["#2f6b4f", "#1d5f8a", "#8a3b5c", "#6b4f2f", "#4b3f8a", "#2f6b6b"];
export function storeColor(s: Store | undefined, list: Store[]) {
  if (!s) return PALETTE[0];
  if (isTestStore(s)) return "#d97706";
  const real = list.filter(x => !isTestStore(x));
  const i = Math.max(0, real.findIndex(x => x.id === s.id));
  return PALETTE[i % PALETTE.length];
}

// 集計画面の「全店」選択（集計画面だけで使う）
export const REPORT_SCOPE_KEY = "salon-app.reports-scope";
export const REPORT_SCOPE_EVENT = "salon-app:reports-scope";
export function getReportScope(): "all" | "store" { try { return localStorage.getItem(REPORT_SCOPE_KEY) === "all" ? "all" : "store"; } catch { return "store"; } }
export function setReportScope(v: "all" | "store") { try { localStorage.setItem(REPORT_SCOPE_KEY, v); } catch {} window.dispatchEvent(new Event(REPORT_SCOPE_EVENT)); }


/** 集計の「全店」に入れる店舗：テスト店舗（練習用）は除く。テスト店舗を表示中のときはテスト店舗だけ */
export function reportAllStores(stores: Store[], cur: Store | null | undefined) {
  const curFull = stores.find(s => s.id === cur?.id) || cur;
  return isTestStore(curFull) ? stores.filter(s => isTestStore(s)) : stores.filter(s => !isTestStore(s));
}
