// リピート率推移表（サロンアンサーの同名の表と同じ形）。画面に依存しない純粋な関数だけ（単体テストあり）。
//
// 数え方（サロンアンサーの見本 2026/05〜10・大橋 の数字から読み取ったもの。区分の決め方だけは店舗の設定で変えられる）
//  - その月に来店したお客様を1人1回数える（同じ月に何回来ても1人）。
//  - 区分（新規・再来・準固定・固定）は、その月の「最初の来店」が、その店舗で何回目の来店か で決める。
//      既定：1回目＝新規／2回目＝再来／3回目以上＝固定（準固定は使わない）。※見本は準固定が全部の月で0。要確認
//  - そのお客様の「次の来店」で1つの欄に入れる：
//      その月のうちにもう一度来た＝同月再来／次の来店が1〜6か月後（暦の月の差）＝○カ月後再来／それ以外（まだ来ていない・7か月以上あと）＝失客
//    → 同月再来＋1〜6カ月後再来＋失客＝来店数（見本：7+64+15+1+2+0+0+3＝92）
//  - 割合は 0.1% 未満を切り捨て（見本：64/92＝69.56…% → 69.5%）。
//  - 担当別：その月にその担当が施術した来店だけを見る（技術の明細担当。ペアは2人とも）。次の来店は担当を問わない（設定で「同じ担当のときだけ」も選べる）。
//  - 来店回数には、前のPOSから取り込んだ来店（historical_visits）も入れる（0012）。売上・経理には入れない。
import type { ID, RepeatRules, RepeatSource, RepeatVisit, RepeatSummary } from "@/lib/db/types";
import { DEFAULT_REPEAT_RULES } from "@/lib/db/types";
import { addMonths } from "@/lib/schedule";

export type RepeatClass = "new" | "repeat" | "semi" | "fixed";
export const CLASS_ORDER: RepeatClass[] = ["new", "repeat", "semi", "fixed"];
export const CLASS_LABEL: Record<RepeatClass, string> = { new: "新規", repeat: "再来", semi: "準固定", fixed: "固定" };
/** 欄：0＝同月再来、1〜6＝○カ月後再来、7＝失客 */
export const BUCKET_LABEL = ["同月再来", "1カ月後再来", "2カ月後再来", "3カ月後再来", "4カ月後再来", "5カ月後再来", "6カ月後再来", "失客"];
export const LOST = 7;

export interface RepeatCell { visitors: number; buckets: number[] }
export interface RepeatMonth { ym: string; total: RepeatCell; rows: Record<RepeatClass, RepeatCell> }
export interface RepeatFilters {
  /** 担当：'store'＝店舗（全員）／'none'＝担当なし（フリー）／スタッフID */
  who: string;
  gender: "all" | "female" | "male" | "unknown";
  /** 来店集計区分：すべて／新規だけ／再来以上（2回目以降）だけ */
  visitClass: "all" | "new" | "repeat";
  /** 指名区分：すべて／指名／フリー（予約の「指名」。予約が無い来店・旧POSの来店は「すべて」のときだけ入る） */
  nominate: "all" | "nominated" | "free";
  /** 再来集計区分：担当を問わない／同じ担当のときだけ（担当別のときだけ意味がある） */
  returnMode: "any" | "same_staff";
}
export const DEFAULT_FILTERS: RepeatFilters = { who: "store", gender: "all", visitClass: "all", nominate: "all", returnMode: "any" };
export const FILTER_TEXT = {
  visitClass: { all: "すべて", new: "新規", repeat: "再来（2回目以降）" },
  returnMode: { any: "すべて", same_staff: "同じ担当" },
  gender: { all: "すべて", female: "女性", male: "男性", unknown: "未登録" },
  nominate: { all: "すべて", nominated: "指名", free: "フリー" },
} as const;

/** 来店回数 → 区分 */
export function classify(n: number, rules: RepeatRules = DEFAULT_REPEAT_RULES): RepeatClass {
  const r = normRules(rules);
  if (n <= 1) return "new";
  if (n <= r.repeat_max) return "repeat";
  if (n <= r.semi_max) return "semi";
  return "fixed";
}
/** 設定の値をそろえる（再来は2回目まで以上・準固定の上限は再来の上限以上） */
export function normRules(r?: Partial<RepeatRules> | null): RepeatRules {
  const repeat_max = Math.max(2, Math.min(50, Math.round(Number(r?.repeat_max) || DEFAULT_REPEAT_RULES.repeat_max)));
  const semi_max = Math.max(repeat_max, Math.min(100, Math.round(Number(r?.semi_max) || repeat_max)));
  return { repeat_max, semi_max };
}
/** 区分の説明（画面・Excel用） */
export function rulesText(r0: RepeatRules) {
  const r = normRules(r0);
  const rep = r.repeat_max === 2 ? "2回目" : `2〜${r.repeat_max}回目`;
  const semi = r.semi_max > r.repeat_max ? (r.semi_max === r.repeat_max + 1 ? `${r.semi_max}回目` : `${r.repeat_max + 1}〜${r.semi_max}回目`) : "なし";
  return `新規＝1回目／再来＝${rep}／準固定＝${semi}／固定＝${r.semi_max + 1}回目以上`;
}
/** 割合（0.1%未満は切り捨て）。0〜1 の小数（0.695 など） */
export function ratio(n: number, d: number) { return d ? Math.floor((n * 1000) / d + 1e-9) / 1000 : 0; }
export const pctText = (n: number, d: number) => `${(ratio(n, d) * 100).toFixed(1)} %`;

const ymOf = (d: string) => d.slice(0, 7);
function monthDiff(a: string, b: string) { const [ya, ma] = a.split("-").map(Number); const [yb, mb] = b.split("-").map(Number); return (yb - ya) * 12 + (mb - ma); }
const emptyCell = (): RepeatCell => ({ visitors: 0, buckets: Array(8).fill(0) });

/** 1日1回にまとめた来店 */
interface DayVisit { date: string; staff: Set<ID>; nominated: boolean | null }
interface CustTrack { store: ID; cid: ID; days: DayVisit[]; sum?: RepeatSummary }

/** 店舗×お客様ごとに、日付順の来店（同じ日は1回）にまとめる */
export function buildTracks(visits: RepeatVisit[], summaries: RepeatSummary[], storeIds?: ID[]): Map<string, CustTrack> {
  const want = storeIds ? new Set(storeIds) : null;
  const map = new Map<string, CustTrack>();
  const byDay = new Map<string, DayVisit>();
  for (const v of visits) {
    if (want && !want.has(v.store_id)) continue;
    const k = `${v.store_id}|${v.customer_id}`;
    let t = map.get(k); if (!t) { t = { store: v.store_id, cid: v.customer_id, days: [] }; map.set(k, t); }
    const dk = `${k}|${v.date}`;
    let d = byDay.get(dk);
    if (!d) { d = { date: v.date, staff: new Set(), nominated: null }; byDay.set(dk, d); t.days.push(d); }
    v.staff_ids.forEach(s => d!.staff.add(s));
    if (v.nominated === true) d.nominated = true; else if (v.nominated === false && d.nominated === null) d.nominated = false;
  }
  for (const s of summaries) {
    if (want && !want.has(s.store_id)) continue;
    if (!s.visit_count && !s.last_visit_on && !s.first_visit_on) continue;
    const k = `${s.store_id}|${s.customer_id}`;
    let t = map.get(k); if (!t) { t = { store: s.store_id, cid: s.customer_id, days: [] }; map.set(k, t); }
    t.sum = s;
  }
  for (const t of map.values()) t.days.sort((a, b) => a.date.localeCompare(b.date));
  return map;
}

/** その日の来店が、その店舗で何回目か。
 *  顧客CSVの「来店回数 N・最終来店日 L」がある人は、L より後の日なら「N ＋ L より後の来店の数」と「来店の記録の数」の大きい方。 */
export function visitNumber(t: { days: { date: string }[]; sum?: RepeatSummary }, date: string) {
  const before = t.days.filter(d => d.date < date);
  let prior = before.length;
  const s = t.sum;
  if (s && s.visit_count) {
    const last = s.last_visit_on || s.first_visit_on;
    if (!last) prior = Math.max(prior, s.visit_count + before.length);
    else if (last < date) prior = Math.max(prior, s.visit_count + before.filter(d => d.date > last).length);
  } else if (s && !s.visit_count) {
    // 回数が無く日付だけ：初回・最終来店日を1回ずつの来店として数える（記録が無いときだけ）
    const ds = [...new Set([s.first_visit_on, s.last_visit_on].filter((x): x is string => !!x && x < date))];
    if (!before.length) prior = Math.max(prior, ds.length);
  }
  return prior + 1;
}

const genderKind = (g: string | null | undefined): "female" | "male" | "unknown" => {
  const x = (g || "").trim();
  if (/^(女|女性|f|female)$/i.test(x)) return "female";
  if (/^(男|男性|m|male)$/i.test(x)) return "male";
  return "unknown";
};

/** 表を作る。startYm から months か月分 */
export function repeatTable(src: Pick<RepeatSource, "visits" | "summaries" | "genders" | "rules">, opt: { startYm: string; months?: number; storeIds?: ID[]; filters?: Partial<RepeatFilters> }): RepeatMonth[] {
  const f: RepeatFilters = { ...DEFAULT_FILTERS, ...(opt.filters || {}) };
  const months = Array.from({ length: opt.months ?? 6 }, (_, i) => addMonths(opt.startYm, i));
  const out = new Map<string, RepeatMonth>(months.map(ym => [ym, { ym, total: emptyCell(), rows: { new: emptyCell(), repeat: emptyCell(), semi: emptyCell(), fixed: emptyCell() } }]));
  const tracks = buildTracks(src.visits, src.summaries, opt.storeIds);
  const staffMatch = (d: DayVisit) => (f.who === "store" ? true : f.who === "none" ? d.staff.size === 0 : d.staff.has(f.who));
  for (const t of tracks.values()) {
    if (f.gender !== "all" && genderKind(src.genders[t.cid]) !== f.gender) continue;
    const rules = src.rules[t.store] || DEFAULT_REPEAT_RULES;
    for (const ym of months) {
      const mine = t.days.filter(d => ymOf(d.date) === ym && staffMatch(d));
      if (!mine.length) continue;
      const v1 = mine[0];
      if (f.nominate === "nominated" && v1.nominated !== true) continue;
      if (f.nominate === "free" && v1.nominated !== false) continue;
      const cls = classify(visitNumber(t, v1.date), rules);
      if (f.visitClass === "new" && cls !== "new") continue;
      if (f.visitClass === "repeat" && cls === "new") continue;
      const sameStaff = f.returnMode === "same_staff" && f.who !== "store";
      const next = t.days.find(d => d.date > v1.date && (!sameStaff || staffMatch(d)));
      let b = LOST;
      if (next) { const diff = monthDiff(ym, ymOf(next.date)); if (diff >= 0 && diff <= 6) b = diff; }
      const m = out.get(ym)!;
      for (const cell of [m.total, m.rows[cls]]) { cell.visitors++; cell.buckets[b]++; }
    }
  }
  return months.map(ym => out.get(ym)!);
}

/** 担当の切り替えに出す人：その期間に施術した人（担当なしの来店があれば「フリー（担当なし）」も） */
export function repeatStaffChoices(src: Pick<RepeatSource, "visits" | "staff">, startYm: string, months = 6, storeIds?: ID[]) {
  const end = addMonths(startYm, months);
  const ids = new Set<ID>(); let none = false;
  for (const v of src.visits) {
    if (storeIds && !storeIds.includes(v.store_id)) continue;
    const ym = ymOf(v.date); if (ym < startYm || ym >= end) continue;
    if (!v.staff_ids.length) none = true; v.staff_ids.forEach(s => ids.add(s));
  }
  const list = src.staff.filter(s => ids.has(s.id)).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name, "ja"))
    .map(s => ({ id: s.id, label: s.name + (s.active === false ? "（退職）" : "") }));
  const unknown = [...ids].filter(id => !src.staff.some(s => s.id === id)).map(id => ({ id, label: "（名前の分からない担当）" }));
  return [...list, ...unknown, ...(none ? [{ id: "none", label: "フリー（担当なし）" }] : [])];
}

/** CSV（画面と同じ並び：年月・区分・来店数・各欄の人数と割合） */
export function repeatCsvRows(table: RepeatMonth[], head: { title: string; period: string; store: string; who: string; filters: string; rules: string }) {
  const rows: (string | number)[][] = [[head.title], [`処理年月：${head.period}`, `店舗名：${head.store}`, `店舗/担当者名：${head.who}`], [head.filters], [head.rules], []];
  rows.push(["年月", "区分", "来店数", ...BUCKET_LABEL.flatMap(l => [l, `${l}（%）`])]);
  for (const m of table) {
    const line = (label: string, c: RepeatCell, first: boolean) => [first ? m.ym.replace("-", "/") : "", label, c.visitors, ...c.buckets.flatMap(n => [n, (ratio(n, c.visitors) * 100).toFixed(1)])];
    rows.push(line("合計", m.total, true));
    for (const k of CLASS_ORDER) rows.push(line(CLASS_LABEL[k], m.rows[k], false));
  }
  return rows;
}
