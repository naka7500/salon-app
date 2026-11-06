"use client";
// 顧客CSV取り込み（オーナー・店長だけ）：前のPOS（サロンアンサー・カミングスーンなど）の顧客CSV・来店履歴CSVを取り込む。
// 流れ：ファイルを選ぶ →（文字コードは自動判定）→ 列の対応を確かめる → 下見（DBには書かない）→ 取り込む → 記録から取り消しもできる。
// お客様の中身はブラウザの中だけで扱い、ログ（console・サーバ）には出さない。
import { useCallback, useEffect, useMemo, useState } from "react";
import { getRepo, IMPORT_SOURCE_LABEL, type Customer, type ImportLog, type ImportPreset, type ImportSource } from "@/lib/db";
import { readCsv, ENCODING_LABEL, type CsvEncoding, type ParsedCsv } from "@/lib/importer/csv";
import { autoMap, CUST_FIELDS, VISIT_FIELDS, type CustField, type VisitField } from "@/lib/importer/fields";
import { planCustomers, planVisits, customerRequest, visitRequest, ACTION_LABEL, fieldLabel, type CustPlan, type VisitPlan, type Mode, type CustAction } from "@/lib/importer/plan";
import { SettingsFrame, useAdmin } from "../SettingsParts";

type Tab = "customers" | "visits" | "logs";
const TAB_LABEL: Record<Tab, string> = { customers: "顧客", visits: "来店履歴（任意）", logs: "取り込みの記録" };
const SOURCES: ImportSource[] = ["salonanswer", "comingsoon", "other"];
const MAX_FILE = 30 * 1024 * 1024;
const PREVIEW_ROWS = 300;
const ACTION_STYLE: Record<string, string> = { create: "bg-moss text-canopy-deep", update: "bg-sky-50 text-sky-800", same: "bg-paper text-ink-soft", dup: "bg-amber-50 text-amber-900", error: "bg-rose-50 text-danger" };
const MATCH_LABEL: Record<string, string> = { external_id: "顧客番号", phone: "電話", kana_name: "フリガナ＋氏名" };

export default function ImportPage() {
  const repo = getRepo();
  const { isAdmin, caps } = useAdmin();
  const ready = !!caps?.import12;
  const [tab, setTab] = useState<Tab>("customers");
  const [source, setSource] = useState<ImportSource>("salonanswer");
  const [presets, setPresets] = useState<ImportPreset[]>([]);
  const [logs, setLogs] = useState<ImportLog[] | null>(null);
  const [storeName, setStoreName] = useState("");

  const reloadLogs = useCallback(() => { repo.importLogs().then(setLogs).catch(() => setLogs(null)); }, [repo]);
  useEffect(() => {
    if (!isAdmin || !ready) return;
    repo.importPresets().then(p => setPresets(p || [])).catch(() => {});
    repo.store().then(s => setStoreName(s.name)).catch(() => {});
    void Promise.resolve().then(reloadLogs);
  }, [repo, isAdmin, ready, reloadLogs]);

  return (
    <SettingsFrame title="設定" isAdmin={isAdmin} notReady={caps && !ready && "顧客CSV取り込みは準備中です（DB更新 0012 の後に使えます。0011 → 0012 の順に Supabase の SQL Editor で Run してください）。"}>
      {ready && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="seg" role="tablist">{(Object.keys(TAB_LABEL) as Tab[]).map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>)}</div>
            {tab !== "logs" && <label className="flex items-center gap-1 text-sm">取り込み元
              <select className="inp" value={source} onChange={e => setSource(e.target.value as ImportSource)} aria-label="取り込み元">{SOURCES.map(s => <option key={s} value={s}>{IMPORT_SOURCE_LABEL[s]}</option>)}</select>
            </label>}
            <span className="text-xs text-ink-mute ml-auto">取り込み先：{storeName}（来店履歴はこの店舗の来店として入ります）</span>
          </div>
          {tab === "customers" && <CustomerImport source={source} presets={presets} onPresets={setPresets} onDone={reloadLogs} />}
          {tab === "visits" && <VisitImport source={source} presets={presets} onPresets={setPresets} onDone={reloadLogs} />}
          {tab === "logs" && <Logs logs={logs} onChanged={reloadLogs} />}
        </div>
      )}
    </SettingsFrame>
  );
}

// ---------- ファイルを選ぶ（共通） ----------
function useCsvFile() {
  const [file, setFile] = useState<File | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [enc, setEnc] = useState<CsvEncoding | "auto">("auto");
  const [err, setErr] = useState("");
  const [parsed, parseErr] = useMemo((): [ParsedCsv | null, string] => {
    if (!bytes) return [null, ""];
    try { const r = readCsv(bytes, enc === "auto" ? undefined : enc); return r.header.length ? [r, ""] : [null, "中身が空のファイルです"]; }
    catch (e) { return [null, `CSVとして読めませんでした（${(e as Error).name}）`]; }
  }, [bytes, enc]);
  async function pick(f: File | null) {
    setErr(""); setFile(f); setBytes(null); setEnc("auto");
    if (!f) return;
    if (f.size > MAX_FILE) { setErr("ファイルが大きすぎます（30MBまで）。期間や店舗で分けて書き出してください"); return; }
    setBytes(new Uint8Array(await f.arrayBuffer()));
  }
  return { file, parsed, enc, setEnc, err: err || parseErr, pick };
}

function FilePicker({ f, kind }: { f: ReturnType<typeof useCsvFile>; kind: "customers" | "visits" }) {
  const p = f.parsed;
  return (
    <div className="card space-y-2">
      <div className="font-bold">1. CSVファイルを選ぶ</div>
      <input type="file" accept=".csv,.txt,text/csv" className="block text-sm" data-testid={`file-${kind}`} onChange={e => void f.pick(e.target.files?.[0] ?? null)} />
      {f.err && <div className="text-sm text-danger">{f.err}</div>}
      {p && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="chip bg-moss text-canopy-deep">{f.file?.name}</span>
          <span>{p.rows.length.toLocaleString()}行・{p.header.length}列</span>
          <label className="flex items-center gap-1">文字コード
            <select className="inp" value={f.enc} onChange={e => f.setEnc(e.target.value as CsvEncoding | "auto")} aria-label="文字コード">
              <option value="auto">自動（{ENCODING_LABEL[p.encoding]}と判定）</option>
              <option value="shift_jis">Shift_JIS（CP932）</option>
              <option value="utf-8">UTF-8</option>
            </select>
          </label>
          {p.headerRow > 0 && <span className="text-xs text-ink-soft">（上の{p.headerRow}行はタイトルとみなして飛ばしました）</span>}
          <span className="text-xs text-ink-mute">文字化けしていたら文字コードを切り替えてください</span>
        </div>
      )}
    </div>
  );
}

function Mapping<F extends string>({ parsed, map, setMap, fields, onSave, saved }: { parsed: ParsedCsv; map: F[]; setMap: (m: F[]) => void; fields: { key: F; label: string }[]; onSave: () => void; saved: string }) {
  const samples = parsed.rows.slice(0, 3);
  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="font-bold">2. 列の対応を確かめる</div>
        <span className="text-xs text-ink-soft">見出しの言葉から自動で選んでいます。違うところだけ直してください。</span>
        <button className="btn ml-auto" onClick={onSave}>この対応を保存</button>
        {saved && <span className="text-xs text-canopy">{saved}</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px]" data-testid="mapping">
          <thead><tr><th className="th w-48">CSVの見出し</th><th className="th">はじめの行の中身</th><th className="th w-60">このアプリの項目</th></tr></thead>
          <tbody>{parsed.header.map((h, i) => (
            <tr key={i} className={map[i] === "ignore" ? "text-ink-mute" : ""}>
              <td className="td font-semibold">{h || `（${i + 1}列目）`}</td>
              <td className="td text-xs"><div className="flex flex-col gap-0.5">{samples.map((r, j) => <span key={j} className="truncate max-w-[22rem]">{(r[i] ?? "").replace(/\n/g, " ⏎ ") || "—"}</span>)}</div></td>
              <td className="td"><select className="inp w-full" value={map[i] ?? "ignore"} aria-label={`${h}の項目`} onChange={e => { const m = [...map]; m[i] = e.target.value as F; setMap(m); }}>{fields.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}</select></td>
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  );
}

const toPreset = (header: string[], map: string[]) => Object.fromEntries(header.map((h, i) => [h, map[i] ?? "ignore"]).filter(([h]) => h));

// ---------- 顧客 ----------
function CustomerImport({ source, presets, onPresets, onDone }: { source: ImportSource; presets: ImportPreset[]; onPresets: (p: ImportPreset[]) => void; onDone: () => void }) {
  const repo = getRepo();
  const f = useCsvFile();
  const [map, setMap] = useState<CustField[]>([]);
  const [mode, setMode] = useState<Mode>("fill");
  const [plan, setPlan] = useState<CustPlan | null>(null);
  const [filter, setFilter] = useState<CustAction | "all">("all");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<[number, number] | null>(null);
  const [msg, setMsg] = useState(""); const [saved, setSaved] = useState("");
  const [result, setResult] = useState<ImportLog | null>(null);
  const preset = presets.find(p => p.source === source && p.kind === "customers")?.mapping;
  const header = f.parsed?.header;
  useEffect(() => { void Promise.resolve().then(() => { setMap(header ? autoMap<CustField>(header, "customers", preset) : []); setPlan(null); setResult(null); setMsg(""); }); }, [header, preset]);
  const setMap2 = (m: CustField[]) => { setMap(m); setPlan(null); setSaved(""); };
  const hasName = map.some(m => m === "name" || m === "name_last" || m === "kana" || m === "kana_last");

  async function savePreset() {
    if (!header) return;
    const p: ImportPreset = { source, kind: "customers", mapping: toPreset(header, map) };
    try { await repo.saveImportPreset(p); onPresets([...presets.filter(x => !(x.source === source && x.kind === "customers")), p]); setSaved(`${IMPORT_SOURCE_LABEL[source]}用に保存しました`); } catch (e) { setSaved((e as Error).message); }
  }
  async function preview() {
    if (!f.parsed) return; setBusy(true); setMsg(""); setResult(null);
    try { const idx: Customer[] = await repo.importIndex(); setPlan(planCustomers(f.parsed.rows, map, idx, source, mode, f.parsed.headerRow + 2)); setFilter("all"); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function run() {
    if (!plan || !f.file) return;
    const c = plan.counts;
    if (!confirm(`取り込みます。\n新しく登録 ${c.create}人／更新 ${c.update}人／変更なし ${c.same}人／スキップ ${c.dup}行／エラー ${c.error}行\n\nよろしいですか？（あとから「取り込みの記録」で取り消せます）`)) return;
    setBusy(true); setMsg(""); setProg([0, c.create + c.update + c.same]);
    try { const lg = await repo.runCustomerImport(customerRequest(plan, source, f.file.name, mode), (d, t) => setProg([d, t])); setResult(lg); setPlan(null); onDone(); }
    catch (e) { setMsg((e as Error).message); onDone(); } finally { setBusy(false); }
  }
  const items = plan ? plan.items.filter(x => filter === "all" || x.action === filter) : [];
  return (
    <>
      <FilePicker f={f} kind="customers" />
      {f.parsed && <Mapping parsed={f.parsed} map={map} setMap={setMap2} fields={CUST_FIELDS} onSave={savePreset} saved={saved} />}
      {f.parsed && (
        <div className="card space-y-2">
          <div className="font-bold">3. 下見する（まだ取り込みません）</div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>すでに登録されている人と同じだったとき：</span>
            <label className="flex items-center gap-1"><input type="radio" name="mode" className="w-5 h-5" checked={mode === "fill"} onChange={() => { setMode("fill"); setPlan(null); }} />空欄だけ埋める（おすすめ）</label>
            <label className="flex items-center gap-1"><input type="radio" name="mode" className="w-5 h-5" checked={mode === "overwrite"} onChange={() => { setMode("overwrite"); setPlan(null); }} />CSVの内容で上書き（メモは書き足し）</label>
          </div>
          <div className="text-xs text-ink-soft">同じ人かどうか：①同じ取り込み元の顧客番号 → ②電話番号 → ③フリガナと氏名がどちらも同じ、の順で探します。見つからなければ新しく登録します。</div>
          {!hasName && <div className="text-sm text-danger">「氏名」か「フリガナ」の列を選んでください。</div>}
          <button className="btn-primary" disabled={busy || !hasName} onClick={preview} data-testid="cust-preview">下見する</button>
          {msg && <div className="text-sm text-danger" role="alert">{msg}</div>}
        </div>
      )}
      {plan && (
        <div className="card space-y-2" data-testid="cust-plan">
          <div className="font-bold">4. 下見の結果</div>
          <div className="flex flex-wrap gap-1">
            <button className={`btn ${filter === "all" ? "border-canopy" : ""}`} onClick={() => setFilter("all")}>すべて {plan.items.length}</button>
            {(Object.keys(ACTION_LABEL) as CustAction[]).map(a => <button key={a} className={`btn ${filter === a ? "border-canopy" : ""}`} onClick={() => setFilter(a)}><span className={`chip ${ACTION_STYLE[a]}`}>{ACTION_LABEL[a]}</span>{plan.counts[a]}</button>)}
          </div>
          <div className="overflow-x-auto max-h-[480px] overflow-y-auto border border-line rounded-[var(--radius-ctl)]">
            <table className="w-full min-w-[820px]">
              <thead className="sticky top-0"><tr><th className="th w-12">行</th><th className="th w-28">判定</th><th className="th">氏名／フリガナ</th><th className="th">電話</th><th className="th">同じ人</th><th className="th">変える項目・理由・注意</th></tr></thead>
              <tbody>{items.slice(0, PREVIEW_ROWS).map(it => (
                <tr key={it.line}>
                  <td className="td text-xs text-ink-mute">{it.line}</td>
                  <td className="td"><span className={`chip ${ACTION_STYLE[it.action]}`}>{ACTION_LABEL[it.action]}</span></td>
                  <td className="td"><div>{it.data.name || "—"}</div><div className="text-[11px] text-ink-mute">{it.data.kana}</div></td>
                  <td className="td text-xs whitespace-nowrap">{it.data.phone}</td>
                  <td className="td text-xs">{it.targetName ? <>{it.targetName}<div className="text-ink-mute">{it.matchBy ? `${MATCH_LABEL[it.matchBy]}で一致` : ""}</div></> : ""}</td>
                  <td className="td text-xs">
                    {it.reason && <div>{it.reason}</div>}
                    {it.patch && Object.keys(it.patch).length > 0 && <div>変える：{Object.keys(it.patch).filter(k => k !== "birth_month").map(fieldLabel).join("・")}</div>}
                    {it.kept && it.kept.length > 0 && <div className="text-ink-soft">そのまま（今の値を残す）：{it.kept.join("・")}</div>}
                    {it.summary && <div className="text-ink-soft">来店：{[it.summary.first_visit_on && `初回 ${it.summary.first_visit_on}`, it.summary.last_visit_on && `最終 ${it.summary.last_visit_on}`, it.summary.visit_count != null && `${it.summary.visit_count}回`, it.summary.staff_name && `担当 ${it.summary.staff_name}`].filter(Boolean).join("・")}</div>}
                    {it.warnings.map((w, i) => <div key={i} className="text-amber-800">⚠ {w}</div>)}
                  </td>
                </tr>))}</tbody>
            </table>
          </div>
          {items.length > PREVIEW_ROWS && <div className="text-xs text-ink-mute">先頭の{PREVIEW_ROWS}行だけ表示しています（取り込みは全部の行）。</div>}
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-primary" disabled={busy || (plan.counts.create + plan.counts.update + plan.counts.same === 0)} onClick={run} data-testid="cust-run">取り込む（新しく登録 {plan.counts.create}人・更新 {plan.counts.update}人）</button>
            <span className="text-xs text-ink-soft">エラー・重複の行は取り込みません。同じファイルをもう一度取り込んでも二重にはなりません。</span>
          </div>
        </div>
      )}
      {prog && busy && <Progress done={prog[0]} total={prog[1]} />}
      {result && <ResultBox log={result} />}
    </>
  );
}

// ---------- 来店履歴 ----------
function VisitImport({ source, presets, onPresets, onDone }: { source: ImportSource; presets: ImportPreset[]; onPresets: (p: ImportPreset[]) => void; onDone: () => void }) {
  const repo = getRepo();
  const f = useCsvFile();
  const [map, setMap] = useState<VisitField[]>([]);
  const [plan, setPlan] = useState<VisitPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<[number, number] | null>(null);
  const [msg, setMsg] = useState(""); const [saved, setSaved] = useState("");
  const [result, setResult] = useState<ImportLog | null>(null);
  const preset = presets.find(p => p.source === source && p.kind === "visits")?.mapping;
  const header = f.parsed?.header;
  useEffect(() => { void Promise.resolve().then(() => { setMap(header ? autoMap<VisitField>(header, "visits", preset) : []); setPlan(null); setResult(null); setMsg(""); }); }, [header, preset]);
  const setMap2 = (m: VisitField[]) => { setMap(m); setPlan(null); setSaved(""); };
  const okMap = map.includes("date") && (map.includes("external_id") || map.includes("phone") || map.includes("kana") || map.includes("name"));
  async function savePreset() {
    if (!header) return;
    const p: ImportPreset = { source, kind: "visits", mapping: toPreset(header, map) };
    try { await repo.saveImportPreset(p); onPresets([...presets.filter(x => !(x.source === source && x.kind === "visits")), p]); setSaved(`${IMPORT_SOURCE_LABEL[source]}用に保存しました`); } catch (e) { setSaved((e as Error).message); }
  }
  async function preview() {
    if (!f.parsed) return; setBusy(true); setMsg(""); setResult(null);
    try { const [idx, keys] = await Promise.all([repo.importIndex(), repo.histKeys(source)]); setPlan(planVisits(f.parsed.rows, map, idx, source, keys, f.parsed.headerRow + 2)); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function run() {
    if (!plan || !f.file) return;
    if (!confirm(`来店履歴を ${plan.counts.create}件 取り込みます（売上台帳・経理の集計には入りません）。よろしいですか？`)) return;
    setBusy(true); setMsg(""); setProg([0, plan.counts.create]);
    try { const lg = await repo.runVisitImport(visitRequest(plan, source, f.file.name), (d, t) => setProg([d, t])); setResult(lg); setPlan(null); onDone(); }
    catch (e) { setMsg((e as Error).message); onDone(); } finally { setBusy(false); }
  }
  return (
    <>
      <div className="text-sm px-3 py-2 rounded-[var(--radius-ctl)] bg-sun-soft border border-[#ecd9b4] text-ink">
        前のPOSの来店（日付・お客様・担当・メニュー・金額）を「旧POSの来店」として入れます。<b>売上台帳・集計・経理日別売上集計には入りません</b>。
        新規／再来の判定、「前回来店から○日以内」のクーポン、お客様の最終来店日にだけ使います。<b>先に「顧客」を取り込んでください</b>（顧客番号・電話でお客様を探します）。
      </div>
      <FilePicker f={f} kind="visits" />
      {f.parsed && <Mapping parsed={f.parsed} map={map} setMap={setMap2} fields={VISIT_FIELDS} onSave={savePreset} saved={saved} />}
      {f.parsed && (
        <div className="card space-y-2">
          <div className="font-bold">3. 下見する（まだ取り込みません）</div>
          {!okMap && <div className="text-sm text-danger">「来店日」と、お客様を探す列（顧客番号・電話・フリガナ・氏名のどれか）を選んでください。</div>}
          <button className="btn-primary" disabled={busy || !okMap} onClick={preview} data-testid="visit-preview">下見する</button>
          {msg && <div className="text-sm text-danger" role="alert">{msg}</div>}
        </div>
      )}
      {plan && (
        <div className="card space-y-2" data-testid="visit-plan">
          <div className="font-bold">4. 下見の結果</div>
          <div className="flex flex-wrap gap-1 text-sm">
            <span className={`chip ${ACTION_STYLE.create}`}>取り込む {plan.counts.create}</span><span className={`chip ${ACTION_STYLE.dup}`}>取り込み済み {plan.counts.dup}</span><span className={`chip ${ACTION_STYLE.error}`}>エラー {plan.counts.error}</span>
          </div>
          <div className="overflow-x-auto max-h-[420px] overflow-y-auto border border-line rounded-[var(--radius-ctl)]">
            <table className="w-full min-w-[760px]">
              <thead className="sticky top-0"><tr><th className="th w-12">行</th><th className="th w-28">判定</th><th className="th">来店日</th><th className="th">お客様</th><th className="th">担当</th><th className="th">メニュー</th><th className="th text-right">金額</th><th className="th">理由</th></tr></thead>
              <tbody>{plan.items.slice(0, PREVIEW_ROWS).map(it => (
                <tr key={it.line}>
                  <td className="td text-xs text-ink-mute">{it.line}</td>
                  <td className="td"><span className={`chip ${ACTION_STYLE[it.action]}`}>{it.action === "create" ? "取り込む" : it.action === "dup" ? "取り込み済み" : "エラー"}</span></td>
                  <td className="td text-xs whitespace-nowrap">{it.visited_on || "—"}</td>
                  <td className="td">{it.customerName || "—"}{it.matchBy && <div className="text-[11px] text-ink-mute">{it.matchBy}で一致</div>}</td>
                  <td className="td text-xs">{it.staff}</td><td className="td text-xs">{it.menu}</td>
                  <td className="td text-right tabular-nums text-xs">{it.amount != null ? it.amount.toLocaleString() : ""}</td>
                  <td className="td text-xs">{it.reason}</td>
                </tr>))}</tbody>
            </table>
          </div>
          <button className="btn-primary" disabled={busy || !plan.counts.create} onClick={run} data-testid="visit-run">取り込む（{plan.counts.create}件）</button>
        </div>
      )}
      {prog && busy && <Progress done={prog[0]} total={prog[1]} />}
      {result && <ResultBox log={result} />}
    </>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const p = total ? Math.round((done / total) * 100) : 100;
  return (
    <div className="card" role="status" aria-live="polite">
      <div className="text-sm mb-1">取り込んでいます… {done.toLocaleString()} / {total.toLocaleString()}（画面を閉じないでください）</div>
      <div className="h-3 rounded-full bg-paper border border-line overflow-hidden"><div className="h-full bg-canopy transition-all" style={{ width: `${p}%` }} /></div>
    </div>
  );
}

function ResultBox({ log }: { log: ImportLog }) {
  const c = log.counts;
  return (
    <div className="card border-canopy border-2" role="status" data-testid="import-result">
      <div className="font-bold text-canopy-deep mb-1">取り込みました</div>
      {log.kind === "customers"
        ? <div className="text-sm">新しく登録 <b>{c.created}</b>人・更新 <b>{c.updated}</b>人・変更なし {c.same}人・スキップ {c.skipped}行・エラー {c.errors}行{c.visits ? `（来店のまとめ ${c.visits}人分）` : ""}</div>
        : <div className="text-sm">旧POSの来店 <b>{c.visits ?? c.created}</b>件・スキップ {c.skipped}行・エラー {c.errors}行</div>}
      <div className="text-xs text-ink-soft mt-1">間違えたときは「取り込みの記録」から取り消せます（取り込みで新しく登録した人のうち、まだ予約・会計・カルテが無い人が消えます）。</div>
    </div>
  );
}

// ---------- 記録 ----------
function Logs({ logs, onChanged }: { logs: ImportLog[] | null; onChanged: () => void }) {
  const repo = getRepo();
  const [msg, setMsg] = useState("");
  async function undo(l: ImportLog) {
    if (!confirm(`「${l.file_name}」の取り込みを取り消しますか？\n・この取り込みで新しく登録した人（予約・会計・カルテが無い人だけ）を消します\n・この取り込みで入れた来店履歴を消します\n・更新した人の項目は元に戻りません`)) return;
    try { const r = await repo.undoImport(l.id); setMsg(`取り消しました：消した人 ${r.removed}人・残した人 ${r.kept}人（予約などがあるため）・消した来店履歴 ${r.visits}件`); onChanged(); }
    catch (e) { setMsg((e as Error).message); }
  }
  if (!logs) return <div className="state">読み込み中…</div>;
  return (
    <div className="card">
      {msg && <div className="mb-2 text-sm px-3 py-2 rounded bg-moss text-canopy-deep" role="status">{msg}</div>}
      {!logs.length ? <div className="state">まだ取り込みはありません</div> : (
        <div className="overflow-x-auto"><table className="w-full min-w-[820px]" data-testid="import-logs">
          <thead><tr><th className="th">日時</th><th className="th">種類</th><th className="th">取り込み元</th><th className="th">ファイル</th><th className="th">した人</th><th className="th">件数</th><th className="th"></th></tr></thead>
          <tbody>{logs.map(l => (
            <tr key={l.id} className={l.undone_at ? "text-ink-mute" : ""}>
              <td className="td whitespace-nowrap text-xs">{new Date(l.created_at).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })}</td>
              <td className="td text-xs">{l.kind === "customers" ? "顧客" : "来店履歴"}{l.kind === "customers" && <div className="text-ink-mute">{l.mode === "fill" ? "空欄だけ" : "上書き"}</div>}</td>
              <td className="td text-xs">{IMPORT_SOURCE_LABEL[l.source]}</td>
              <td className="td text-xs break-all">{l.file_name}</td>
              <td className="td text-xs">{l.actor_name || "—"}</td>
              <td className="td text-xs">{l.kind === "customers" ? `登録 ${l.counts.created}・更新 ${l.counts.updated}・変更なし ${l.counts.same}・スキップ ${l.counts.skipped}・エラー ${l.counts.errors}` : `来店 ${l.counts.visits ?? l.counts.created}・スキップ ${l.counts.skipped}・エラー ${l.counts.errors}`}
                {(l.counts as { failed?: boolean }).failed && <div className="text-danger">途中で止まりました</div>}</td>
              <td className="td text-xs whitespace-nowrap">{l.undone_at ? <>取り消し済み<div>{l.undo_result ? `消した人 ${l.undo_result.removed}・残した人 ${l.undo_result.kept}・来店 ${l.undo_result.visits}` : ""}</div></> : <button className="btn" onClick={() => undo(l)}>この取り込みを取り消す</button>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </div>
  );
}
