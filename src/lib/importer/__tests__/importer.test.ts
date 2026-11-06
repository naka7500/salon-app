import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Customer } from "@/lib/db/types";
import { decodeCsvBytes, parseCsv, readCsv } from "../csv";
import { autoMap, parseDate, phoneDigits, formatPhone, kanaKey, parseGender, type CustField, type VisitField } from "../fields";
import { planCustomers, planVisits, customerRequest, histRange } from "../plan";

const SAMPLES = path.resolve(__dirname, "../../../../tools/import-samples");
const sample = (f: string) => new Uint8Array(readFileSync(path.join(SAMPLES, f)));

describe("文字コードとCSVの読み取り", () => {
  it("Shift_JIS（CP932）・UTF-8・BOMつきを見分ける", () => {
    expect(decodeCsvBytes(new TextEncoder().encode("氏名,電話\n山田,090")).encoding).toBe("utf-8");
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("氏名")])).text).toBe("氏名");
    // 「氏名」の CP932：8E81 96BC
    const r = decodeCsvBytes(new Uint8Array([0x8e, 0x81, 0x96, 0xbc]));
    expect(r.encoding).toBe("shift_jis"); expect(r.text).toBe("氏名");
  });
  it("引用符・改行・カンマ・\"\" の入った列", () => {
    const rows = parseCsv('a,b,c\r\n1,"x,y","line1\nline2"\r\n2,"say ""hi""",\r\n\r\n');
    expect(rows).toEqual([["a", "b", "c"], ["1", "x,y", "line1\nline2"], ["2", 'say "hi"', ""]]);
  });
  it("タブ区切りも読める", () => { expect(parseCsv("a\tb\n1\t2")).toEqual([["a", "b"], ["1", "2"]]); });
  it("サンプルCSV（CP932・サロンアンサー風）", () => {
    const p = readCsv(sample("サンプル_サロンアンサー風_顧客_CP932.csv"));
    expect(p.encoding).toBe("shift_jis");
    expect(p.header).toContain("顧客番号");
    expect(p.rows.length).toBeGreaterThanOrEqual(8);
  });
  it("サンプルCSV（UTF-8 BOM・カミングスーン風）", () => {
    const p = readCsv(sample("サンプル_カミングスーン風_顧客_UTF8.csv"));
    expect(p.encoding).toBe("utf-8-bom");
    expect(p.header[0]).not.toMatch(/^﻿/);
  });
});

describe("値の整え方", () => {
  it("日付", () => {
    expect(parseDate("2024/1/5")).toBe("2024-01-05");
    expect(parseDate("２０２４年１月５日")).toBe("2024-01-05");
    expect(parseDate("20240105")).toBe("2024-01-05");
    expect(parseDate("令和6年1月5日")).toBe("2024-01-05");
    expect(parseDate("H10.4.1")).toBe("1998-04-01");
    expect(parseDate("昭和60/12/31")).toBe("1985-12-31");
    expect(parseDate("2024/02/30")).toBeNull();
    expect(parseDate("45292")).toBe("2024-01-01");
    expect(parseDate("2024-03-04 13:30")).toBe("2024-03-04");
    expect(parseDate("abc")).toBeNull();
  });
  it("電話・カナ・性別", () => {
    expect(phoneDigits("０９０－１２３４－５６７８")).toBe("09012345678");
    expect(phoneDigits("+81 90-1234-5678")).toBe("09012345678");
    expect(formatPhone("09012345678")).toBe("090-1234-5678");
    expect(formatPhone("0312345678")).toBe("03-1234-5678");
    expect(kanaKey("やまだ　はなこ")).toBe(kanaKey("ﾔﾏﾀﾞ ﾊﾅｺ"));
    expect(parseGender("女")).toBe("女性"); expect(parseGender("M")).toBe("男性");
  });
});

describe("見出しから自動で対応をつける", () => {
  it("顧客", () => {
    const m = autoMap<CustField>(["顧客番号", "姓", "名", "セイ", "メイ", "携帯電話", "自宅電話", "メールアドレス", "生年月日", "性別", "郵便番号", "住所1", "住所2", "初回来店日", "最終来店日", "来店回数", "担当スタッフ", "備考", "メモ", "謎の列"], "customers");
    expect(m).toEqual(["external_id", "name_last", "name_first", "kana_last", "kana_first", "phone", "phone2", "email", "birthday", "gender", "postal_code", "address", "address", "first_visit", "last_visit", "visit_count", "staff", "note", "note", "ignore"]);
    expect(autoMap<CustField>(["お客様名", "フリガナ", "TEL", "会員ID"], "customers")).toEqual(["name", "kana", "phone", "external_id"]);
    expect(autoMap<CustField>(["氏名（カナ）", "氏名"], "customers")).toEqual(["kana", "name"]);
  });
  it("保存した対応を優先", () => {
    expect(autoMap<CustField>(["お名前", "番号X"], "customers", { "番号X": "external_id" })).toEqual(["name", "external_id"]);
  });
  it("来店履歴", () => {
    expect(autoMap<VisitField>(["来店日", "顧客番号", "お客様名", "担当", "メニュー", "金額", "伝票番号"], "visits")).toEqual(["date", "external_id", "name", "staff", "menu", "amount", "slip_no"]);
  });
});

const C = (x: Partial<Customer> & { id: string; name: string }): Customer => ({ company_id: "co", created_at: "2026-01-01", ...x });
describe("顧客の下見（作る・更新・重複・エラー）", () => {
  const header = ["顧客番号", "氏名", "フリガナ", "電話", "メール", "生年月日", "初回来店日", "最終来店日", "来店回数", "備考"];
  const map = autoMap<CustField>(header, "customers");
  const existing: Customer[] = [
    C({ id: "e1", name: "山田 花子", kana: "ヤマダ ハナコ", phone: "090-1111-2222", import_source: "salonanswer", external_id: "1001" }),
    C({ id: "e2", name: "佐藤 結衣", kana: "サトウ ユイ", phone: "080-3333-4444", email: "old@example.com" }),
    C({ id: "e3", name: "鈴木 舞", kana: "スズキ マイ" }),
  ];
  const rows = [
    ["1001", "山田 花子", "ヤマダ ハナコ", "", "hanako@example.com", "1990/4/5", "2023/1/10", "2026/9/1", "12", ""],     // 顧客番号で一致 → メールと生年月日を埋める
    ["2001", "佐藤 結衣", "サトウ ユイ", "08033334444", "new@example.com", "", "", "", "", "VIP"],                       // 電話で一致 → メールは上書きしない（空欄だけ）
    ["2002", "鈴木 舞", "すずき まい", "", "", "", "", "", "", ""],                                                    // カナ＋氏名で一致 → 顧客番号を入れる
    ["2003", "新規 太郎", "シンキ タロウ", "070-5555-6666", "", "", "2026/10/1", "", "", ""],                            // 新しく登録
    ["2003", "新規 太郎", "シンキ タロウ", "070-5555-6666", "", "", "", "", "", ""],                                    // ファイル内の重複
    ["2004", "", "", "", "", "", "", "", "", ""],                                                                     // エラー
    ["1001", "山田 花子", "ヤマダ ハナコ", "", "", "", "", "", "", ""],                                                  // 上と同じ顧客番号
  ];
  it("空欄だけ埋める（既定）", () => {
    const p = planCustomers(rows, map, existing, "salonanswer", "fill");
    expect(p.items.map(x => x.action)).toEqual(["update", "update", "update", "create", "dup", "error", "dup"]);
    expect(p.items[0].matchBy).toBe("external_id"); expect(p.items[0].patch).toMatchObject({ email: "hanako@example.com", birthday: "1990-04-05", birth_month: "1990-04" });
    expect(p.items[0].summary).toEqual({ first_visit_on: "2023-01-10", last_visit_on: "2026-09-01", visit_count: 12, staff_name: null });
    expect(p.items[1].matchBy).toBe("phone"); expect(p.items[1].patch).toEqual({ external_id: "2001", note: "VIP" }); expect(p.items[1].kept).toContain("メール");
    expect(p.items[2].matchBy).toBe("kana_name"); expect(p.items[2].patch).toEqual({ external_id: "2002" });
    expect(p.items[3].data).toMatchObject({ name: "新規 太郎", kana: "シンキ タロウ", phone: "070-5555-6666", external_id: "2003" });
    expect(p.counts).toEqual({ create: 1, update: 3, same: 0, dup: 2, error: 1 });
  });
  it("上書き", () => {
    const p = planCustomers(rows, map, existing, "salonanswer", "overwrite");
    expect(p.items[1].patch).toMatchObject({ email: "new@example.com" });
  });
  it("2回目は変更なし（同じファイルを取り込み直しても二重にならない）", () => {
    const p1 = planCustomers(rows, map, existing, "salonanswer", "fill");
    // 1回目の結果を反映した既存のお客様
    const after: Customer[] = existing.map(c => { const it = p1.items.find(x => x.targetId === c.id && x.action === "update"); return it ? { ...c, ...it.patch, import_source: it.patch?.external_id ? "salonanswer" : c.import_source } : c; });
    p1.items.filter(x => x.action === "create").forEach((x, i) => after.push(C({ id: `n${i}`, ...x.data, name: x.data.name, import_source: "salonanswer" })));
    const p2 = planCustomers(rows, map, after, "salonanswer", "fill");
    expect(p2.counts.create).toBe(0); expect(p2.counts.update).toBe(0); expect(p2.counts.same).toBe(4);
    const req = customerRequest(p2, "salonanswer", "a.csv", "fill");
    expect(req.creates.length).toBe(0); expect(req.updates.length).toBe(0); expect(req.same).toBe(4);
  });
  it("別の取り込み元の顧客番号は上書きしない", () => {
    const ex = [C({ id: "x", name: "山田 花子", phone: "090-1111-2222", import_source: "comingsoon", external_id: "CS-9" })];
    const p = planCustomers([["1001", "山田 花子", "", "090-1111-2222", "", "", "", "", "", ""]], map, ex, "salonanswer", "overwrite");
    expect(p.items[0].action).toBe("same");
  });
  it("姓・名・セイ・メイの列をつなげる", () => {
    const m = autoMap<CustField>(["姓", "名", "セイ", "メイ"], "customers");
    const p = planCustomers([["田中", "葵", "たなか", "あおい"]], m, [], "other", "fill");
    expect(p.items[0].data.name).toBe("田中 葵"); expect(p.items[0].data.kana).toBe("タナカ アオイ");
  });
});

describe("来店履歴の下見", () => {
  const ex: Customer[] = [C({ id: "a", name: "山田 花子", kana: "ヤマダ ハナコ", phone: "090-1111-2222", import_source: "salonanswer", external_id: "1001" }), C({ id: "b", name: "佐藤 結衣", kana: "サトウ ユイ", phone: "080-3333-4444" })];
  const map = autoMap<VisitField>(["来店日", "顧客番号", "電話", "担当", "メニュー", "金額"], "visits");
  const rows = [["2026/9/1", "1001", "", "飯田", "まつ毛パーマ", "6,600"], ["2026/9/1", "1001", "", "飯田", "まつ毛パーマ", "6,600"], ["2026/9/2", "", "08033334444", "", "眉", "4400"], ["", "1001", "", "", "", ""], ["2026/9/3", "9999", "", "", "", ""]];
  it("顧客番号→電話で探す・同じ行は2件目にする・見つからないとエラー", () => {
    const p = planVisits(rows, map, ex, "salonanswer", new Set());
    expect(p.items.map(x => x.action)).toEqual(["create", "create", "create", "error", "error"]);
    expect(p.items[0].dedupe_key).not.toBe(p.items[1].dedupe_key);
    expect(p.items[0].amount).toBe(6600); expect(p.items[2].customerId).toBe("b");
    const again = planVisits(rows, map, ex, "salonanswer", new Set(p.items.filter(x => x.dedupe_key).map(x => x.dedupe_key!)));
    expect(again.counts).toEqual({ create: 0, dup: 3, error: 2 });
  });
  it("初回・最終の日付", () => {
    expect(histRange([{ kind: "visit", visited_on: "2026-09-01" }, { kind: "summary", first_visit_on: "2023-01-10", last_visit_on: "2026-08-01" }])).toEqual({ first: "2023-01-10", last: "2026-09-01" });
  });
});
