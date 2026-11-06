import { beforeAll, describe, expect, it } from "vitest";
import type { RepeatSource, RepeatVisit } from "@/lib/db/types";
import { classify, ratio, pctText, repeatTable, repeatStaffChoices, visitNumber, buildTracks, rulesText, normRules, repeatCsvRows, LOST } from "../repeat";
import { buildRepeatWorkbook } from "../repeatXlsx";
import { ensureJst } from "../inbound/tz";

beforeAll(() => ensureJst());
const S = "st1";
const v = (cid: string, date: string, staff: string[] = ["x"], nominated: boolean | null = null, store = S): RepeatVisit => ({ store_id: store, customer_id: cid, date, staff_ids: staff, nominated, src: "sale" });
const src = (visits: RepeatVisit[], o: Partial<RepeatSource> = {}): RepeatSource => ({ stores: [], staff: [], visits, summaries: [], genders: {}, rules: {}, rulesReady: true, ...o });

describe("割合（0.1%未満は切り捨て。サロンアンサー見本と同じ）", () => {
  it("見本の数字", () => {
    expect(ratio(64, 92)).toBe(0.695);   // 69.56% → 69.5%
    expect(ratio(62, 89)).toBe(0.696);   // 69.66% → 69.6%
    expect(ratio(5, 16)).toBe(0.312);
    expect(ratio(2, 3)).toBe(0.666);
    expect(ratio(38, 43)).toBe(0.883);
    expect(ratio(7, 7)).toBe(1);
    expect(ratio(0, 0)).toBe(0);
    expect(pctText(64, 92)).toBe("69.5 %");
  });
});

describe("区分（来店回数）", () => {
  it("既定：1回目＝新規・2回目＝再来・3回目以上＝固定（準固定なし）", () => {
    expect([1, 2, 3, 4, 10].map(n => classify(n))).toEqual(["new", "repeat", "fixed", "fixed", "fixed"]);
  });
  it("設定で準固定を使う（再来＝2回目・準固定＝3回目・固定＝4回目以上）", () => {
    const r = { repeat_max: 2, semi_max: 3 };
    expect([1, 2, 3, 4].map(n => classify(n, r))).toEqual(["new", "repeat", "semi", "fixed"]);
    expect(rulesText(r)).toBe("新規＝1回目／再来＝2回目／準固定＝3回目／固定＝4回目以上");
    expect(rulesText({ repeat_max: 2, semi_max: 2 })).toBe("新規＝1回目／再来＝2回目／準固定＝なし／固定＝3回目以上");
  });
  it("おかしな設定はそろえる", () => {
    expect(normRules({ repeat_max: 1, semi_max: 0 })).toEqual({ repeat_max: 2, semi_max: 2 });
    expect(normRules({ repeat_max: 3, semi_max: 2 })).toEqual({ repeat_max: 3, semi_max: 3 });
  });
});

describe("欄の振り分け（次の来店がいつか）", () => {
  const visits = [
    v("A", "2026-05-03"), v("A", "2026-05-20"), v("A", "2026-06-10"),   // 5月：新規・同月再来／6月：3回目＝固定・失客
    v("B", "2026-04-10"), v("B", "2026-05-15"), v("B", "2026-07-01"),   // 5月：2回目＝再来・2カ月後
    v("C", "2026-05-31"), v("C", "2026-12-01"),                          // 5月：新規・7か月後＝失客
    v("D", "2026-05-01"), v("D", "2026-11-30"),                          // 5月：新規・6カ月後
    v("E", "2026-05-05"), v("E", "2026-05-05"), v("E", "2026-06-05"),   // 同じ日の2伝票は1回 → 1カ月後
  ];
  const t = repeatTable(src(visits), { startYm: "2026-05" });
  const may = t[0], jun = t[1], jul = t[2];
  it("5月：1人1回・同月再来＋1〜6カ月後＋失客＝来店数", () => {
    expect(t.map(m => m.ym)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(may.total.visitors).toBe(5);
    expect(may.total.buckets).toEqual([1, 1, 1, 0, 0, 0, 1, 1]);
    expect(may.total.buckets.reduce((a, b) => a + b, 0)).toBe(may.total.visitors);
    expect(may.rows.new.visitors).toBe(4);
    expect(may.rows.new.buckets).toEqual([1, 1, 0, 0, 0, 0, 1, 1]);
    expect(may.rows.repeat.buckets).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
    expect(may.rows.semi.visitors).toBe(0);
  });
  it("6月：A は3回目（固定）で次が無い＝失客、E は2回目（再来）で失客", () => {
    expect(jun.total.visitors).toBe(2);
    expect(jun.rows.fixed.visitors).toBe(1); expect(jun.rows.fixed.buckets[LOST]).toBe(1);
    expect(jun.rows.repeat.visitors).toBe(1); expect(jun.rows.repeat.buckets[LOST]).toBe(1);
    expect(jul.rows.fixed.visitors).toBe(1);   // B の3回目
  });
  it("見本の型：6月の新規が7月に2回来る → 7月の再来1人・同月再来1", () => {
    const t2 = repeatTable(src([v("F", "2026-06-02"), v("F", "2026-07-03"), v("F", "2026-07-25")]), { startYm: "2026-06" });
    expect(t2[0].rows.new.buckets[1]).toBe(1);          // 6月 新規 → 1カ月後再来
    expect(t2[1].rows.repeat.visitors).toBe(1);         // 7月 再来（2回目）
    expect(t2[1].rows.repeat.buckets[0]).toBe(1);       // 同月再来
  });
});

describe("担当別・絞り込み", () => {
  const visits = [v("A", "2026-05-03", ["s1"], true), v("A", "2026-06-03", ["s2"], false), v("B", "2026-05-10", ["s2"], false), v("B", "2026-05-12", ["s1"], null), v("C", "2026-05-11", [], null)];
  const base = src(visits, { genders: { A: "女性", B: "男性" }, staff: [{ id: "s1", company_id: "c", name: "菊池", role: "staff", active: true }, { id: "s2", company_id: "c", name: "富塚", role: "staff", active: true }] });
  it("その担当が施術した来店だけ。次の来店は担当を問わない", () => {
    const s1 = repeatTable(base, { startYm: "2026-05", filters: { who: "s1" } })[0];
    expect(s1.total.visitors).toBe(2);          // A(5/3) と B(5/12)
    expect(s1.total.buckets[1]).toBe(1);        // A は6月に富塚で再来
    expect(s1.total.buckets[LOST]).toBe(1);     // B は5/12のあと来ていない
  });
  it("再来集計区分＝同じ担当：ほかの担当の来店は再来に数えない", () => {
    const s1 = repeatTable(base, { startYm: "2026-05", filters: { who: "s1", returnMode: "same_staff" } })[0];
    expect(s1.total.buckets[LOST]).toBe(2);
    const s2 = repeatTable(base, { startYm: "2026-05", filters: { who: "s2", returnMode: "same_staff" } })[0];
    expect(s2.total.visitors).toBe(1);          // B(5/10) だけ（A の富塚は6月）
    expect(s2.total.buckets[LOST]).toBe(1);     // B の次（5/12）は菊池なので数えない
  });
  it("フリー（担当なし）・担当の選択肢", () => {
    expect(repeatTable(base, { startYm: "2026-05", filters: { who: "none" } })[0].total.visitors).toBe(1);
    expect(repeatStaffChoices(base, "2026-05").map(c => c.label)).toEqual(["菊池", "富塚", "フリー（担当なし）"]);
  });
  it("性別・指名区分・来店集計区分", () => {
    expect(repeatTable(base, { startYm: "2026-05", filters: { gender: "female" } })[0].total.visitors).toBe(1);
    expect(repeatTable(base, { startYm: "2026-05", filters: { gender: "unknown" } })[0].total.visitors).toBe(1);   // C
    expect(repeatTable(base, { startYm: "2026-05", filters: { nominate: "nominated" } })[0].total.visitors).toBe(1); // A
    expect(repeatTable(base, { startYm: "2026-05", filters: { nominate: "free" } })[0].total.visitors).toBe(1);      // B（最初の来店がフリー）
    expect(repeatTable(base, { startYm: "2026-05", filters: { visitClass: "repeat" } })[1].total.visitors).toBe(1);  // 6月の A（2回目）
    expect(repeatTable(base, { startYm: "2026-05", filters: { visitClass: "new" } })[1].total.visitors).toBe(0);
  });
  it("全店：店舗ごとに数える（同じお客様IDでも店舗が違えば別）", () => {
    const t = repeatTable(src([v("A", "2026-05-01", ["x"], null, "st1"), v("A", "2026-05-02", ["x"], null, "st2")]), { startYm: "2026-05", storeIds: ["st1", "st2"] });
    expect(t[0].total.visitors).toBe(2); expect(t[0].rows.new.visitors).toBe(2);
    expect(repeatTable(src([v("A", "2026-05-01", ["x"], null, "st1"), v("A", "2026-05-02", ["x"], null, "st2")]), { startYm: "2026-05", storeIds: ["st1"] })[0].total.visitors).toBe(1);
  });
});

describe("前のPOSの来店（0012）も回数に入れる", () => {
  it("顧客CSVの来店回数5回・最終来店日が前 → 6回目＝固定", () => {
    const s = src([v("G", "2026-05-02")], { summaries: [{ store_id: S, customer_id: "G", visit_count: 5, first_visit_on: "2024-01-01", last_visit_on: "2026-03-01" }] });
    expect(repeatTable(s, { startYm: "2026-05" })[0].rows.fixed.visitors).toBe(1);
  });
  it("来店履歴と顧客CSVの回数が重なっても二重に数えない", () => {
    const visits = [{ ...v("H", "2026-04-30"), src: "hist" as const }, v("H", "2026-05-02")];
    const s = src(visits, { summaries: [{ store_id: S, customer_id: "H", visit_count: 1, first_visit_on: "2026-04-30", last_visit_on: "2026-04-30" }] });
    const tr = buildTracks(s.visits, s.summaries).get(`${S}|H`)!;
    expect(visitNumber(tr, "2026-05-02")).toBe(2);
    expect(repeatTable(s, { startYm: "2026-05" })[0].rows.repeat.visitors).toBe(1);
  });
  it("回数が無く最終来店日だけ → 1回の来店として数える", () => {
    const s = src([v("I", "2026-05-02")], { summaries: [{ store_id: S, customer_id: "I", visit_count: null, first_visit_on: null, last_visit_on: "2026-01-10" }] });
    expect(repeatTable(s, { startYm: "2026-05" })[0].rows.repeat.visitors).toBe(1);
  });
});

describe("CSV と Excel（見本と同じ並び）", () => {
  const t = repeatTable(src([v("A", "2026-05-03"), v("A", "2026-05-20"), v("B", "2026-05-04"), v("B", "2026-06-04")]), { startYm: "2026-05" });
  it("CSV：1か月＝5行（合計・新規・再来・準固定・固定）", () => {
    const rows = repeatCsvRows(t, { title: "リピート率推移表", period: "p", store: "s", who: "w", filters: "f", rules: "r" });
    const head = rows.findIndex(r => r[0] === "年月");
    expect(rows[head]).toContain("同月再来（%）");
    expect(rows[head + 1].slice(0, 5)).toEqual(["2026/05", "合計", 2, 1, "50.0"]);
    expect(rows.length - head - 1).toBe(30);
  });
  it("Excel：見出し・結合・書式", async () => {
    const wb = await buildRepeatWorkbook(t, { period: "2026年05月度 ～ 2026年10月度", store: "テスト店", who: "テスト店", visitClass: "すべて", returnMode: "すべて", gender: "すべて", nominate: "すべて", rules: "新規＝1回目", createdAt: new Date("2026-11-07T10:00:00+09:00") });
    const ws = wb.getWorksheet("リピート率推移表")!;
    expect(ws.getCell("B2").value).toBe("リピート率推移表");
    expect(ws.getCell("B3").value).toBe("処理年月：2026年05月度 ～ 2026年10月度");
    expect(ws.getCell("D6").value).toBe("来客数");
    expect(ws.getCell("AB6").value).toBe("失客");
    expect(ws.getCell("B7").value).toBe("2026/05");
    expect(ws.getCell("C7").value).toBe("合計");
    expect(ws.getCell("D7").value).toBe(2);
    expect(ws.getCell("F7").value).toBe(1);
    expect(ws.getCell("G7").value).toBe(0.5);
    expect(ws.getCell("G7").numFmt).toBe("#0.0%");
    expect(ws.getCell("D7").numFmt).toBe("#,##0");
    expect(ws.getCell("C11").value).toBe("固定");
    expect(ws.getCell("B12").value).toBe("2026/06");
    expect(ws.getCell("C36").value).toBe("固定");
    const merges = (ws.model as unknown as { merges: string[] }).merges;
    for (const m of ["B2:AC2", "D6:E6", "F6:I6", "J6:M6", "Y6:AA6", "AB6:AC6", "D7:E7", "G7:I7", "K7:M7", "P7:Q7", "R7:S7", "Y36:Z36"]) expect(merges).toContain(m);
    expect((ws.getCell("D6").fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe("FFCCFFCF");
  });
});
