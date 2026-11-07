"use client";
// 経理日別売上集計：サロンアンサーの同名の表と同じ形（税理士さん向け）。月×店舗（または全店）。
// 画面の表＋ Excel（.xlsx）・CSV・印刷。計算は lib/accounting.ts（単体テストあり）。
import { downloadCsv } from "@/lib/csv";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getRepo, todayStr, type Store } from "@/lib/db";
import { addMonths, monthDays, addDays } from "@/lib/schedule";
import { getReportScope, reportAllStores } from "@/lib/storeScope";
import { accountingReport, accountingCsvRows, MONEY_GROUPS, PAY_COLS, PAY_COL_LABEL, PAY_MAP_NOTE, type AcctReport, type Counted } from "@/lib/accounting";

const n0 = (v: number) => v.toLocaleString("ja-JP");
const yen0 = (v: number) => "¥" + v.toLocaleString("ja-JP");


export default function AccountingPage() {
  const repo = getRepo();
  const [ym, setYm] = useState(todayStr().slice(0, 7));
  const [stores, setStores] = useState<Store[]>([]);
  const [cur, setCur] = useState<Store | null>(null);
  const [pick, setPick] = useState<string>("");          // 店舗ID または "all"
  const [rep, setRep] = useState<AcctReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    void Promise.resolve().then(() => { try { const q = new URLSearchParams(location.search).get("ym"); if (q && /^\d{4}-\d{2}$/.test(q)) setYm(q); } catch {} });
    Promise.all([repo.store(), repo.stores()]).then(([c, ss]) => { setCur(c); setStores(ss); setPick(getReportScope() === "all" && ss.length > 1 ? "all" : c.id); }).catch(e => setErr((e as Error).message));
  }, [repo]);
  const list = useMemo(() => reportAllStores(stores, cur), [stores, cur]);
  const choices = useMemo(() => { const own = list.some(s => s.id === cur?.id) ? list : cur ? [cur, ...list] : list; return own; }, [list, cur]);
  const ids = useMemo(() => (pick === "all" ? list.map(s => s.id) : pick ? [pick] : []), [pick, list]);
  const days = useMemo(() => monthDays(ym), [ym]);
  const from = days[0], to = addDays(days[days.length - 1], 1);
  const storeName = pick === "all" ? `全店（${list.map(s => s.name).join("・")}）` : (stores.find(s => s.id === pick) || cur)?.name || "";
  const period = `${from.replace(/-/g, "/")} ～ ${days[days.length - 1].replace(/-/g, "/")}`;

  const load = useCallback(async () => {
    if (!ids.length) return;
    setLoading(true); setErr("");
    try { const b = await repo.reportBundle(ids, from, to, from); setRep(accountingReport(b.sales, from, to)); }
    catch (e) { setErr((e as Error).message); setRep(null); }
    finally { setLoading(false); }
  }, [repo, ids, from, to]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const fileBase = `経理日別売上集計_${pick === "all" ? "全店" : storeName}_${ym}`;
  async function xlsx() {
    if (!rep) return; setBusy("Excelを作っています…");
    try { const { downloadAccountingXlsx } = await import("@/lib/accountingXlsx"); await downloadAccountingXlsx(rep, { period, store: storeName }, `${fileBase}.xlsx`); setBusy(""); }
    catch (e) { setBusy(`Excelを作れませんでした：${(e as Error).message}`); }
  }
  function print() { document.body.classList.add("printing-acct"); const off = () => { document.body.classList.remove("printing-acct"); window.removeEventListener("afterprint", off); }; window.addEventListener("afterprint", off); window.print(); }

  return (
    <div className="max-w-[1400px]">
      <style>{`@media print { @page { size: A4 landscape; margin: 7mm; } body.printing-acct { background: #fff !important; } }`}</style>
      <div className="flex flex-wrap items-center gap-2 mb-2 print:hidden">
        <Link href="/reports" className="btn-quiet">← 集計</Link>
        <h1 className="text-xl font-bold mr-1">経理日別売上集計</h1>
        <div className="flex gap-1"><button className="btn" onClick={() => setYm(addMonths(ym, -1))}>前月</button><input type="month" className="inp" value={ym} onChange={e => e.target.value && setYm(e.target.value)} aria-label="月" /><button className="btn" onClick={() => setYm(addMonths(ym, 1))}>次月</button></div>
        <select className="inp" value={pick} onChange={e => setPick(e.target.value)} aria-label="店舗">
          {choices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          {list.length > 1 && <option value="all">全店（{list.length}店舗の合計）</option>}
        </select>
        <div className="ml-auto flex flex-wrap gap-1">
          <button className="btn-primary" onClick={xlsx} disabled={!rep}>Excel（.xlsx）で出す</button>
          <button className="btn" onClick={() => rep && downloadCsv(`${fileBase}.csv`, accountingCsvRows(rep, { period, store: storeName }))} disabled={!rep}>CSV</button>
          <button className="btn" onClick={print} disabled={!rep}>印刷</button>
        </div>
      </div>
      {busy && <div className="text-xs text-ink-soft mb-1 print:hidden">{busy}</div>}
      {err && <div className="mb-2 text-sm px-3 py-2 rounded bg-rose-50 text-rose-700 border border-rose-200">読み込めませんでした：{err}</div>}
      {loading && <div className="text-xs text-ink-mute mb-1 print:hidden">読み込み中…</div>}

      {rep && (
        <div className="acct-sheet card p-3 print:border-0 print:p-0 print:shadow-none" data-testid="acct-sheet">
          <div className="text-center font-bold text-lg mb-1">経理日別売上集計</div>
          <div className="text-xs text-ink-soft">処理年月日：{period}</div>
          <div className="text-xs text-ink-soft mb-2">店舗名：{storeName}</div>
          <Summary rep={rep} />
          <div className="overflow-x-auto mt-2">
            <table className="w-full min-w-[1000px] border-collapse text-[11px] print:text-[8px] print:min-w-0" data-testid="acct-table">
              <thead>
                <tr>
                  <th rowSpan={2} className="acct-th">日付</th>
                  {MONEY_GROUPS.map(g => <th key={g.key} colSpan={3} className="acct-th">{g.label}</th>)}
                  <th colSpan={8} className="acct-th">売上入金</th>
                </tr>
                <tr>
                  {MONEY_GROUPS.flatMap(g => ["税抜", "消費税", "税込"].map(l => <th key={g.key + l} className="acct-th">{l}</th>))}
                  {PAY_COLS.map(c => <th key={c} className="acct-th">{PAY_COL_LABEL[c]}</th>)}
                </tr>
              </thead>
              <tbody>
                {rep.rows.map((r, i) => (
                  <tr key={i} className={r.kind === "day" ? "" : "acct-sub"}>
                    <td className={`acct-td ${r.kind === "day" ? "text-center" : "text-right"}`}>{r.label}</td>
                    {MONEY_GROUPS.flatMap(g => [r[g.key].net, r[g.key].tax, r[g.key].gross].map((v, j) => <td key={g.key + j} className={`acct-td text-right ${v === 0 ? "text-ink-mute" : ""}`}>{n0(v)}</td>))}
                    {PAY_COLS.map(c => <td key={c} className={`acct-td text-right ${r.pay[c] === 0 ? "text-ink-mute" : ""}`}>{n0(r.pay[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-2 mt-2 print:hidden">
        <div className="card">
          <div className="font-bold text-sm mb-1">支払方法の振り分け</div>
          <table className="w-full"><thead><tr><th className="th">このアプリの支払方法</th><th className="th">経理の列</th><th className="th">メモ</th></tr></thead>
            <tbody>{PAY_MAP_NOTE.map(m => <tr key={m.from}><td className="td">{m.from}</td><td className="td font-semibold whitespace-nowrap">{PAY_COL_LABEL[m.to]}</td><td className="td text-xs text-ink-soft">{m.note || ""}</td></tr>)}</tbody></table>
        </div>
        <div className="card text-xs text-ink-soft leading-relaxed">
          <div className="font-bold text-sm text-ink mb-1">数え方</div>
          <div>・金額は税込。<b>消費税は伝票ごと</b>（技術・店販それぞれ）に「税込×10÷110」を四捨五入（8%は×8÷108）。税抜＝税込−消費税。サロンアンサーの見本（2026年11月 大橋）の数字と同じ丸め方です。</div>
          <div>・<b>技術売上</b>＝メニュー・オプション・指名料−値引。<b>店販売上</b>＝商品。値引が技術より大きいときは残りを店販から引きます。</div>
          <div>・<b>赤伝</b>は赤伝を切った日にマイナスで入ります（元の伝票の日はそのまま）。件数は元の伝票＋1・赤伝−1。</div>
          <div>・<b>会員カード売上・売掛金・前受出金・ポイント利用・売掛入金・前受入金</b>はこのアプリに機能が無いので 0 です（税理士さんの表と同じ並びにするため列は残しています）。</div>
          <div>・全店はテスト店舗（練習用）を除いた合計です。数字はこのアプリに入れた会計だけ（サロンアンサー・サロンボード側の数字は含みません）。</div>
        </div>
      </div>
    </div>
  );
}

function Summary({ rep }: { rep: AcctReport }) {
  const s = rep.summary;
  const z: Counted = { amount: 0, count: 0 };
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 items-start border border-line-strong rounded-[var(--radius-ctl)] p-2 print:grid-cols-4 print:rounded-none" data-testid="acct-summary">
      <Box testid="sum-sales" rows={[["・総売上", s.total, true], ["技術売上", s.tech], ["会員C売上", s.member], ["店販売上", s.product], ["・消費税", s.tax, true], ["技術消費税", s.taxTech], ["会員C消費税", s.taxMember], ["店販消費税", s.taxProduct], ["（内　軽減税率）", { amount: s.reducedTax, count: NaN }]]} />
      <Box testid="sum-pay" rows={[["・売上入金", s.payTotal, true], ...PAY_COLS.map(c => [PAY_COL_LABEL[c], s.pay[c]] as [string, Counted])]} />
      <Box rows={[["・売掛入金", z, true], ["現金", z], ["クレジット", z], ["電子マネー", z], ["商品券", z], ["その他", z]]} />
      <Box rows={[["・前受入金", z, true], ["現金", z], ["クレジット", z], ["電子マネー", z], ["商品券", z], ["その他", z]]} />
    </div>
  );
}

function Box({ rows, testid }: { rows: [string, Counted | null, boolean?][]; testid?: string }) {
  return (
    <table className="w-full text-[12px] print:text-[8px]" data-testid={testid}>
      <tbody>{rows.map(([l, v, head], i) => (
        <tr key={i} className={head ? "font-semibold" : ""}>
          <td className={`py-0.5 pr-2 whitespace-nowrap ${head ? "" : "pl-2"}`}>{l}</td>
          <td className="py-0.5 text-right tabular-nums whitespace-nowrap">{v ? yen0(v.amount) : ""}</td>
          <td className="py-0.5 pl-2 text-right tabular-nums whitespace-nowrap text-ink-soft">{v && !Number.isNaN(v.count) ? `${n0(v.count)}人` : ""}</td>
        </tr>))}</tbody>
    </table>
  );
}
