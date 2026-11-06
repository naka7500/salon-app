// 取り込みの「下見」：1行ずつ 新しく作る／更新／変更なし／重複でスキップ／エラー を決める（DBには書かない）。
// 突き合わせの順番：①同じ取り込み元の顧客番号 ②電話（数字だけ） ③フリガナ＋氏名が完全に一致（どちらも空でないとき）
import type { Customer, CustomerImportFields, CustomerImportRequest, HistSummaryInput, ImportSource, VisitImportRequest } from "@/lib/db/types";
import { formatPhone, kanaDisplay, kanaKey, looksEmail, nameKey, nfkc, parseDate, parseGender, parseIntLoose, phoneDigits, type CustField, type VisitField } from "./fields";

export type Mode = "fill" | "overwrite";
export type CustAction = "create" | "update" | "same" | "dup" | "error";
export const ACTION_LABEL: Record<CustAction, string> = { create: "新しく登録", update: "更新", same: "変更なし", dup: "重複でスキップ", error: "エラー" };
export interface CustPlanItem {
  line: number; action: CustAction; reason?: string; matchBy?: "external_id" | "phone" | "kana_name"; targetId?: string; targetName?: string;
  data: CustomerImportFields; patch?: Partial<CustomerImportFields>; kept?: string[]; summary?: HistSummaryInput | null; warnings: string[];
}
export interface CustPlan { items: CustPlanItem[]; counts: Record<CustAction, number> }

const FIELD_LABEL: Record<keyof CustomerImportFields, string> = { name: "氏名", kana: "フリガナ", phone: "電話", email: "メール", birthday: "生年月日", birth_month: "生年月", gender: "性別", postal_code: "郵便番号", address: "住所", note: "メモ", external_id: "顧客番号" };
export const fieldLabel = (k: string) => FIELD_LABEL[k as keyof CustomerImportFields] ?? k;

/** 1行 → 顧客の項目（列の対応にしたがって。姓・名の列はつなげる） */
export function rowToCustomer(row: string[], map: CustField[]) {
  const get = (f: CustField) => map.map((m, i) => (m === f ? nfkc(row[i]) : "")).filter(Boolean);
  const one = (f: CustField) => get(f)[0] ?? "";
  const warnings: string[] = [];
  const name = one("name") || [one("name_last"), one("name_first")].filter(Boolean).join(" ");
  const kanaRaw = one("kana") || [one("kana_last"), one("kana_first")].filter(Boolean).join(" ");
  const phoneRaw = one("phone") || one("phone2");
  const phone = phoneRaw ? formatPhone(phoneRaw) : "";
  if (phoneRaw && !/^\d{10,11}$/.test(phoneDigits(phoneRaw))) warnings.push(`電話の桁数が合いません（${phoneRaw.length}文字）`);
  const email = one("email").toLowerCase();
  if (email && !looksEmail(email)) warnings.push("メールの形が正しくありません（取り込みません）");
  const bRaw = one("birthday"); const birthday = bRaw ? parseDate(bRaw) : null;
  if (bRaw && !birthday) warnings.push("生年月日が読めません（取り込みません）");
  const fvRaw = one("first_visit"), lvRaw = one("last_visit");
  const first = fvRaw ? parseDate(fvRaw) : null, last = lvRaw ? parseDate(lvRaw) : null;
  if (fvRaw && !first) warnings.push("初回来店日が読めません");
  if (lvRaw && !last) warnings.push("最終来店日が読めません");
  const cnt = parseIntLoose(one("visit_count"));
  const postal = one("postal_code").replace(/[^0-9]/g, "");
  const data: CustomerImportFields = {
    name: nfkc(name).replace(/\s+/g, " "), kana: kanaRaw ? kanaDisplay(kanaRaw) : null, phone: phone || null,
    email: email && looksEmail(email) ? email : null, birthday, birth_month: birthday ? birthday.slice(0, 7) : null,
    gender: parseGender(one("gender")), postal_code: postal.length === 7 ? `${postal.slice(0, 3)}-${postal.slice(3)}` : postal || null,
    address: get("address").join(" ") || null, note: get("note").join(" / ") || null, external_id: one("external_id") || null,
  };
  const summary: HistSummaryInput | null = first || last || cnt || one("staff") ? { first_visit_on: first, last_visit_on: last ?? first, visit_count: cnt, staff_name: one("staff") || null } : null;
  return { data, summary, warnings };
}

const empty = (v: unknown) => v === null || v === undefined || String(v).trim() === "";

/** 顧客CSVの下見 */
export function planCustomers(rows: string[][], map: CustField[], existing: Customer[], source: ImportSource, mode: Mode, firstLine = 2): CustPlan {
  const byExt = new Map<string, Customer>(), byPhone = new Map<string, Customer>(), byKanaName = new Map<string, Customer[]>();
  const byId = new Map(existing.map(c => [c.id, c]));
  for (const c0 of existing) {
    // 統合済みの人は統合先として扱う（顧客番号だけ引き継ぐ）
    if (c0.merged_into) { const to = byId.get(c0.merged_into); if (to && c0.external_id && c0.import_source === source && !byExt.has(c0.external_id)) byExt.set(c0.external_id, to); continue; }
    const c = c0;
    if (c.external_id && c.import_source === source) byExt.set(c.external_id, c);
    const p = phoneDigits(c.phone); if (p.length >= 10 && !byPhone.has(p)) byPhone.set(p, c);
    const k = kanaKey(c.kana), n = nameKey(c.name); if (k && n) { const key = `${k}|${n}`; byKanaName.set(key, [...(byKanaName.get(key) || []), c]); }
  }
  const seenExt = new Set<string>(), seenPhone = new Set<string>(), seenKN = new Set<string>(), seenTarget = new Set<string>();
  const items: CustPlanItem[] = rows.map((row, i) => {
    const line = firstLine + i;
    const { data, summary, warnings } = rowToCustomer(row, map);
    if (!data.name) { if (data.kana) data.name = data.kana; else return { line, action: "error", reason: "氏名もフリガナも空です", data, warnings }; }
    const ph = phoneDigits(data.phone), kk = kanaKey(data.kana), nk = nameKey(data.name);
    // ファイルの中での重複
    if ((data.external_id && seenExt.has(data.external_id)) || (!data.external_id && ph.length >= 10 && seenPhone.has(ph)) || (!data.external_id && ph.length < 10 && kk && seenKN.has(`${kk}|${nk}`)))
      return { line, action: "dup", reason: "このファイルの上の行と同じ人です", data, warnings };
    if (data.external_id) seenExt.add(data.external_id); if (ph.length >= 10) seenPhone.add(ph); if (kk) seenKN.add(`${kk}|${nk}`);
    // 既存のお客様と突き合わせ
    let target: Customer | undefined; let matchBy: CustPlanItem["matchBy"];
    if (data.external_id && byExt.has(data.external_id)) { target = byExt.get(data.external_id); matchBy = "external_id"; }
    else if (ph.length >= 10 && byPhone.has(ph)) { target = byPhone.get(ph); matchBy = "phone"; }
    else if (kk && nk) { const c = byKanaName.get(`${kk}|${nk}`); if (c?.length === 1) { target = c[0]; matchBy = "kana_name"; } else if (c && c.length > 1) warnings.push(`同じフリガナ・氏名の人が${c.length}人いるため新しく登録します`); }
    if (!target) return { line, action: "create", data, summary, warnings };
    if (seenTarget.has(target.id)) return { line, action: "dup", reason: `このファイルの上の行と同じ人（${target.name}）です`, targetId: target.id, targetName: target.name, data, warnings };
    seenTarget.add(target.id);
    // 何を変えるか：空欄だけ埋める（既定）／上書き。顧客番号は別の取り込み元のものを上書きしない
    const patch: Partial<CustomerImportFields> = {}; const kept: string[] = [];
    for (const k of Object.keys(data) as (keyof CustomerImportFields)[]) {
      const v = data[k]; if (empty(v)) continue;
      const cur = target[k as keyof Customer];
      if (k === "external_id") { if (target.import_source && target.import_source !== source && !empty(cur)) continue; if (cur !== v) patch.external_id = v; continue; }
      if (empty(cur)) { patch[k] = v as never; continue; }
      if (String(cur) === String(v)) continue;
      if (k === "phone" && phoneDigits(String(cur)) === phoneDigits(String(v))) continue;
      if (k === "kana" && kanaKey(String(cur)) === kanaKey(String(v))) continue;
      if (k === "name" && nameKey(String(cur)) === nameKey(String(v))) continue;
      if (mode === "overwrite") { if (k === "note") { if (!String(cur).includes(String(v))) patch.note = `${cur}\n${v}`; } else patch[k] = v as never; }
      else kept.push(fieldLabel(k));
    }
    const action: CustAction = Object.keys(patch).length ? "update" : "same";
    return { line, action, matchBy, targetId: target.id, targetName: target.name, data, patch, kept, summary, warnings };
  });
  const counts = { create: 0, update: 0, same: 0, dup: 0, error: 0 } as Record<CustAction, number>;
  for (const it of items) counts[it.action]++;
  return { items, counts };
}

export function customerRequest(plan: CustPlan, source: ImportSource, fileName: string, mode: Mode): CustomerImportRequest {
  return {
    source, file_name: fileName, mode,
    creates: plan.items.filter(x => x.action === "create").map(x => ({ data: x.data, summary: x.summary })),
    updates: plan.items.filter(x => x.action === "update").map(x => ({ id: x.targetId!, patch: x.patch!, summary: x.summary })),
    sames: plan.items.filter(x => x.action === "same" && x.summary).map(x => ({ id: x.targetId!, summary: x.summary })),
    same: plan.counts.same, skipped: plan.counts.dup, errors: plan.counts.error,
  };
}

// ---- 来店履歴CSV ----
export type VisitAction = "create" | "dup" | "error";
export interface VisitPlanItem { line: number; action: VisitAction; reason?: string; customerId?: string; customerName?: string; matchBy?: string;
  visited_on?: string; staff?: string; menu?: string; amount?: number | null; slip_no?: string; dedupe_key?: string }
export interface VisitPlan { items: VisitPlanItem[]; counts: Record<VisitAction, number> }

export function planVisits(rows: string[][], map: VisitField[], existing: Customer[], source: ImportSource, existingKeys: Set<string>, firstLine = 2): VisitPlan {
  const byExt = new Map<string, Customer>(), byPhone = new Map<string, Customer>(), byKN = new Map<string, Customer[]>();
  const byId = new Map(existing.map(c => [c.id, c]));
  for (const c0 of existing) {
    if (c0.merged_into) { const to = byId.get(c0.merged_into); if (to && c0.external_id && c0.import_source === source && !byExt.has(c0.external_id)) byExt.set(c0.external_id, to); continue; }
    const c = c0;
    if (c.external_id && c.import_source === source) byExt.set(c.external_id, c);
    const p = phoneDigits(c.phone); if (p.length >= 10 && !byPhone.has(p)) byPhone.set(p, c);
    const k = kanaKey(c.kana), n = nameKey(c.name); if (k) { const key = `${k}|${n}`; byKN.set(key, [...(byKN.get(key) || []), c]); byKN.set(`${k}|`, [...(byKN.get(`${k}|`) || []), c]); }
  }
  const occ = new Map<string, number>();
  const items: VisitPlanItem[] = rows.map((row, i) => {
    const line = firstLine + i;
    const one = (f: VisitField) => map.map((m, j) => (m === f ? nfkc(row[j]) : "")).filter(Boolean)[0] ?? "";
    const dRaw = one("date"); const d = parseDate(dRaw);
    if (!d) return { line, action: "error", reason: dRaw ? "来店日が読めません" : "来店日が空です" };
    const ext = one("external_id"), ph = phoneDigits(one("phone")), kk = kanaKey(one("kana")), nk = nameKey(one("name"));
    let c: Customer | undefined; let matchBy = "";
    if (ext && byExt.has(ext)) { c = byExt.get(ext); matchBy = "顧客番号"; }
    else if (ph.length >= 10 && byPhone.has(ph)) { c = byPhone.get(ph); matchBy = "電話"; }
    else if (kk) { const list = byKN.get(`${kk}|${nk}`) || (nk ? undefined : byKN.get(`${kk}|`)); if (list?.length === 1) { c = list[0]; matchBy = "フリガナ＋氏名"; } }
    if (!c) return { line, action: "error", reason: "お客様が見つかりません（先に顧客CSVを取り込んでください）", visited_on: d };
    const amount = parseIntLoose(one("amount")); const menu = one("menu"), staff = one("staff"), slip = one("slip_no");
    const base = [d, c.id, slip, menu, amount ?? ""].join("|"); const k = (occ.get(base) ?? 0) + 1; occ.set(base, k);
    const key = k > 1 ? `${base}#${k}` : base;
    if (existingKeys.has(key)) return { line, action: "dup", reason: "取り込み済みです", customerId: c.id, customerName: c.name, visited_on: d, dedupe_key: key };
    return { line, action: "create", customerId: c.id, customerName: c.name, matchBy, visited_on: d, staff, menu, amount, slip_no: slip, dedupe_key: key };
  });
  const counts = { create: 0, dup: 0, error: 0 } as Record<VisitAction, number>;
  for (const it of items) counts[it.action]++;
  return { items, counts };
}

export function visitRequest(plan: VisitPlan, source: ImportSource, fileName: string): VisitImportRequest {
  return {
    source, file_name: fileName,
    rows: plan.items.filter(x => x.action === "create").map(x => ({ customer_id: x.customerId!, visited_on: x.visited_on!, staff_name: x.staff || null, menu_text: x.menu || null, amount: x.amount ?? null, slip_no: x.slip_no || null, dedupe_key: x.dedupe_key! })),
    skipped: plan.counts.dup, errors: plan.counts.error,
  };
}

/** 旧POSの来店（visit・summary）から 初回・最終の日付を出す */
export function histRange(list: { kind: string; visited_on?: string | null; first_visit_on?: string | null; last_visit_on?: string | null }[]) {
  let first: string | null = null, last: string | null = null;
  for (const h of list) for (const d of [h.visited_on, h.first_visit_on, h.last_visit_on]) if (d) { if (!first || d < first) first = d; if (!last || d > last) last = d; }
  return { first, last };
}
