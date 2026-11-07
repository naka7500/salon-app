"use client";
// リピート率推移表：サロンアンサーの同名の表と同じ形。開始の年月から6か月、店舗（全員）または担当ごと。
// 計算は lib/repeat.ts（単体テストあり）。Excel（見本と同じ並び）・CSV・印刷。
import { downloadCsv } from "@/lib/csv";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getRepo, todayStr, DEFAULT_REPEAT_RULES, type RepeatRules, type RepeatSource, type Staff, type Store } from "@/lib/db";
import { addDays, addMonths } from "@/lib/schedule";
import { getReportScope, reportAllStores } from "@/lib/storeScope";
import { repeatTable, repeatStaffChoices, repeatCsvRows, rulesText, normRules, pctText, BUCKET_LABEL, CLASS_LABEL, CLASS_ORDER, DEFAULT_FILTERS, FILTER_TEXT, type RepeatFilters, type RepeatCell } from "@/lib/repeat";

const ymJa = (ym: string) => `${ym.slice(0, 4)}年${ym.slice(5, 7)}月度`;

export default function RepeatPage() {
  const repo = getRepo();
  const today = todayStr();
  const [startYm, setStartYm] = useState(addMonths(today.slice(0, 7), -5));
  const [stores, setStores] = useState<Store[]>([]);
  const [cur, setCur] = useState<Store | null>(null);
  const [pick, setPick] = useState("");
  const [src, setSrc] = useState<RepeatSource | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");
  const [f, setF] = useState<RepeatFilters>(DEFAULT_FILTERS);
  const [open, setOpen] = useState(true);
  const [me, setMe] = useState<Staff | null>(null);
  const [ruleIn, setRuleIn] = useState<RepeatRules>(DEFAULT_REPEAT_RULES);
  const [ruleMsg, setRuleMsg] = useState("");

  useEffect(() => {
    void Promise.resolve().then(() => { try { const q = new URLSearchParams(location.search).get("ym"); if (q && /^\d{4}-\d{2}$/.test(q)) setStartYm(q); } catch {} });
    repo.me().then(setMe).catch(() => {});
    Promise.all([repo.store(), repo.stores()]).then(([c, ss]) => { setCur(c); setStores(ss); setPick(getReportScope() === "all" && ss.length > 1 ? "all" : c.id); }).catch(e => setErr((e as Error).message));
  }, [repo]);
  const list = useMemo(() => reportAllStores(stores, cur), [stores, cur]);
  const choices = useMemo(() => (list.some(s => s.id === cur?.id) ? list : cur ? [cur, ...list] : list), [list, cur]);
  const ids = useMemo(() => (pick === "all" ? list.map(s => s.id) : pick ? [pick] : []), [pick, list]);
  const storeName = pick === "all" ? `全店（${list.map(s => s.name).join("・")}）` : (stores.find(s => s.id === pick) || cur)?.name || "";

  const load = useCallback(async () => {
    if (!ids.length) return;
    setLoading(true); setErr("");
    try { const s = await repo.repeatSource(ids, addDays(today, 1)); setSrc(s); if (ids.length === 1) setRuleIn(s.rules[ids[0]] || DEFAULT_REPEAT_RULES); }
    catch (e) { setErr((e as Error).message); setSrc(null); }
    finally { setLoading(false); }
  }, [repo, ids, today]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const staffChoices = useMemo(() => (src ? repeatStaffChoices(src, startYm, 6, ids) : []), [src, startYm, ids]);
  const who = f.who === "store" || staffChoices.some(c => c.id === f.who) ? f.who : "store";
  const table = useMemo(() => (src ? repeatTable(src, { startYm, months: 6, storeIds: ids, filters: { ...f, who } }) : []), [src, startYm, ids, f, who]);
  const whoLabel = who === "store" ? storeName : staffChoices.find(c => c.id === who)?.label || "";
  const endYm = addMonths(startYm, 5);
  const period = `${ymJa(startYm)} ～ ${ymJa(endYm)}`;
  const rulesLine = src ? (ids.length === 1 ? rulesText(src.rules[ids[0]] || DEFAULT_REPEAT_RULES) : [...new Set(ids.map(id => rulesText(src.rules[id] || DEFAULT_REPEAT_RULES)))].join("／")) : "";
  const filterLine = `来店集計区分：${FILTER_TEXT.visitClass[f.visitClass]}　再来集計区分：${FILTER_TEXT.returnMode[f.returnMode]}　性別区分：${FILTER_TEXT.gender[f.gender]}　指名区分：${FILTER_TEXT.nominate[f.nominate]}　顧客区分：店舗`;
  const fileBase = `リピート率推移表_${pick === "all" ? "全店" : storeName}${who !== "store" ? `_${whoLabel}` : ""}_${startYm}から6か月`;
  const isAdmin = !me || me.role === "owner" || me.role === "manager";

  async function xlsx() {
    if (!src) return; setBusy("Excelを作っています…");
    try {
      const { downloadRepeatXlsx } = await import("@/lib/repeatXlsx");
      await downloadRepeatXlsx(table, { period, store: storeName, who: whoLabel, visitClass: FILTER_TEXT.visitClass[f.visitClass], returnMode: FILTER_TEXT.returnMode[f.returnMode], gender: FILTER_TEXT.gender[f.gender], nominate: FILTER_TEXT.nominate[f.nominate], rules: rulesLine }, `${fileBase}.xlsx`);
      setBusy("");
    } catch (e) { setBusy(`Excelを作れませんでした：${(e as Error).message}`); }
  }
  function print() { document.body.classList.add("printing-acct"); const off = () => { document.body.classList.remove("printing-acct"); window.removeEventListener("afterprint", off); }; window.addEventListener("afterprint", off); window.print(); }
  async function saveRules() {
    setRuleMsg("");
    try { await repo.saveRepeatRules(ids[0], normRules(ruleIn)); setRuleMsg("保存しました"); await load(); }
    catch (e) { setRuleMsg((e as Error).message); }
  }
  const sel = <K extends keyof RepeatFilters>(k: K, label: string, opts: Record<string, string>) => (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2"><label className="text-sm font-semibold text-ink text-right" htmlFor={`f-${k}`}>{label}</label>
      <select id={`f-${k}`} className="inp max-w-56" value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })}>{Object.entries(opts).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
  );

  return (
    <div className="max-w-[1400px]">
      <style>{`@media print { @page { size: A4 landscape; margin: 7mm; } }`}</style>
      <div className="flex flex-wrap items-center gap-2 mb-2 print:hidden">
        <Link href="/reports" className="btn-quiet">← 集計</Link>
        <h1 className="text-xl font-bold mr-1">リピート率推移表</h1>
      </div>

      <div className="card mb-2 print:hidden !p-0 overflow-hidden">
        <button className="w-full text-left px-3 py-2 bg-[#cdebe6] text-[13px] text-canopy-deep font-semibold" aria-expanded={open} onClick={() => setOpen(v => !v)}>{open ? "▾" : "▸"} 集計条件</button>
        {open && <div className="p-3 grid md:grid-cols-2 gap-x-6 gap-y-2">
          <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2"><label className="text-sm font-semibold text-right" htmlFor="f-ym">年月</label>
            <div className="flex flex-wrap items-center gap-1"><button className="btn !px-2 min-w-11" onClick={() => setStartYm(addMonths(startYm, -1))} aria-label="前の月から">‹</button><input id="f-ym" type="month" className="inp" value={startYm} onChange={e => e.target.value && setStartYm(e.target.value)} /><button className="btn !px-2 min-w-11" onClick={() => setStartYm(addMonths(startYm, 1))} aria-label="次の月から">›</button><span className="text-sm">から6カ月のリピート率を分析します。</span></div></div>
          <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2"><label className="text-sm font-semibold text-right" htmlFor="f-store">店舗</label>
            <select id="f-store" className="inp max-w-72" value={pick} onChange={e => { setPick(e.target.value); setF({ ...f, who: "store" }); }}>
              {choices.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              {list.length > 1 && <option value="all">全店（{list.length}店舗・テスト店舗を除く）</option>}
            </select></div>
          {sel("visitClass", "来店集計区分", FILTER_TEXT.visitClass)}
          {sel("returnMode", "再来集計区分", FILTER_TEXT.returnMode)}
          {sel("gender", "性別区分", FILTER_TEXT.gender)}
          {sel("nominate", "指名区分", FILTER_TEXT.nominate)}
          <div className="md:col-span-2 flex justify-start"><button className="btn text-ink-soft" onClick={() => setF(DEFAULT_FILTERS)}>条件をクリア</button></div>
        </div>}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-2 print:hidden">
        <label className="text-sm font-semibold" htmlFor="who">店舗/担当者名</label>
        <select id="who" data-testid="who" className="inp min-w-56" value={who} onChange={e => setF({ ...f, who: e.target.value })}>
          <option value="store">{pick === "all" ? "全店（全員）" : storeName}</option>
          {staffChoices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
        <div className="ml-auto flex flex-wrap gap-1">
          <button className="btn" onClick={() => downloadCsv(`${fileBase}.csv`, repeatCsvRows(table, { title: "リピート率推移表", period, store: storeName, who: whoLabel, filters: filterLine, rules: `区分：${rulesLine}` }))} disabled={!src}>CSV</button>
          <button className="btn-primary" onClick={xlsx} disabled={!src} data-testid="repeat-xlsx">Excel（.xlsx）で出す</button>
          <button className="btn" onClick={print} disabled={!src}>印刷</button>
        </div>
      </div>
      {busy && <div className="text-xs text-ink-soft mb-1 print:hidden">{busy}</div>}
      {err && <div className="mb-2 text-sm px-3 py-2 rounded bg-rose-50 text-rose-700 border border-rose-200">読み込めませんでした：{err}</div>}
      {loading && <div className="text-xs text-ink-mute mb-1 print:hidden">読み込み中…</div>}

      {src && (
        <div className="card p-3 print:border-0 print:p-0" data-testid="repeat-sheet">
          <div className="hidden print:block text-center font-bold text-lg mb-1">リピート率推移表</div>
          <div className="text-xs text-ink-soft">処理年月：{period}　店舗名：{storeName}{who !== "store" ? `　担当：${whoLabel}` : ""}</div>
          <div className="text-xs text-ink-soft">{filterLine}</div>
          <div className="text-xs text-ink-soft mb-2">区分：{rulesLine}</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] border-collapse text-[12px] print:text-[8px] print:min-w-0" data-testid="repeat-table">
              <thead><tr>
                <th className="acct-th" colSpan={2}></th><th className="acct-th">来店数</th>
                {BUCKET_LABEL.map(l => <th key={l} className="acct-th" colSpan={2}>{l}</th>)}
              </tr></thead>
              <tbody>{table.map(m => {
                const lines: [string, RepeatCell][] = [["合計", m.total], ...CLASS_ORDER.map(k => [CLASS_LABEL[k], m.rows[k]] as [string, RepeatCell])];
                return lines.map(([label, c], i) => (
                  <tr key={m.ym + label} className={i === 0 ? "border-t-2 border-line-strong" : ""} data-ym={m.ym} data-row={label}>
                    {i === 0 && <td rowSpan={lines.length} className="acct-th !font-normal align-middle w-20">{m.ym.replace("-", "/")}</td>}
                    <td className="acct-th !font-normal w-14">{label}</td>
                    <td className={`acct-td text-right font-semibold text-canopy-deep ${c.visitors ? "" : "!text-ink-mute"}`}>{c.visitors}</td>
                    {c.buckets.map((n, k) => [
                      <td key={`c${k}`} className={`acct-td text-right ${n ? "font-semibold text-canopy-deep" : "text-ink-mute"} ${k === 7 && n ? "!text-danger" : ""}`}>{n}</td>,
                      <td key={`p${k}`} className={`acct-td text-right text-[11px] ${n ? "text-ink-soft" : "text-ink-mute"}`}>{pctText(n, c.visitors)}</td>,
                    ])}
                  </tr>));
              })}</tbody>
            </table>
          </div>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-2 mt-2 print:hidden">
        <div className="card text-xs text-ink-soft leading-relaxed">
          <div className="font-bold text-sm text-ink mb-1">数え方</div>
          <div>・<b>来店数</b>＝その月に来店（確定した会計）したお客様の人数。同じ月に何回来ても1人です。その店舗の会計だけ（全店は店舗ごとに数えて合計）。</div>
          <div>・各欄は、そのお客様の<b>次の来店</b>がいつか：その月のうちにもう一度来た＝同月再来／次の来店が1〜6か月後（暦の月の差）＝○カ月後再来／まだ来ていない・7か月以上あと＝<b>失客</b>。同月再来＋1〜6カ月後再来＋失客＝来店数。</div>
          <div>・最近の月は、まだ次の来店の時期が来ていないので失客が多めに出ます（サロンアンサーも同じ）。</div>
          <div>・<b>担当別</b>は、その月にその担当が施術した来店（技術の明細担当）で数えます。次の来店は担当を問いません（「再来集計区分＝同じ担当」にすると、同じ担当の来店だけを再来と数えます）。</div>
          <div>・<b>指名区分</b>は予約の「指名」で分けます。予約の無い会計・前のPOSの来店は「すべて」のときだけ入ります。</div>
          <div>・来店回数には、前のPOS（サロンアンサー・カミングスーン）から取り込んだ来店も入れます（売上には入れません）。</div>
          <div>・割合は0.1%未満を切り捨て（サロンアンサーと同じ）。</div>
        </div>
        <div className="card text-sm" data-testid="repeat-rules">
          <div className="font-bold mb-1">区分の決め方（新規・再来・固定）</div>
          <div className="text-xs text-ink-soft mb-2 leading-relaxed">その月の最初の来店が、その店舗で何回目か で決めます。既定は<b>1回目＝新規・2回目＝再来・3回目以上＝固定</b>です（準固定は使いません）。</div>
          <div className="text-sm mb-2">今の決め方：<b>{rulesLine || "—"}</b></div>
          {ids.length === 1 && isAdmin && src?.rulesReady && <div className="flex flex-wrap items-end gap-2">
            <div><label className="lbl" htmlFor="r-rep">再来＝2回目〜</label><div className="flex items-center gap-1"><input id="r-rep" type="number" min={2} max={50} className="inp w-20 text-right" value={ruleIn.repeat_max} onChange={e => setRuleIn({ ...ruleIn, repeat_max: +e.target.value })} />回目</div></div>
            <button className="btn-primary" onClick={saveRules}>この店舗の決め方を保存</button>
            <div className="w-full text-xs text-ink-soft">保存すると：{rulesText(normRules(ruleIn))}</div>
          </div>}
          {ids.length === 1 && src && !src.rulesReady && <div className="text-xs text-ink-soft">決め方の変更は準備中です（DB更新 0013 の後に保存できます）。今は既定の決め方で数えています。</div>}
          {ids.length > 1 && <div className="text-xs text-ink-soft">全店では、各店舗の決め方で数えます（変えるときは店舗を1つ選んでください）。</div>}
          {!isAdmin && <div className="text-xs text-ink-soft">決め方の変更はオーナー・店長だけができます。</div>}
          {ruleMsg && <div className="text-xs mt-1 text-canopy-deep" role="status">{ruleMsg}</div>}
        </div>
      </div>
    </div>
  );
}
