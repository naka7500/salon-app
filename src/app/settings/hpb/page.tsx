"use client";
// 設定＞HPB連携（owner/manager）：HPBの予約通知メールを自動で台帳に取り込む（取り込みだけ。サロンボードには書き込まない）。
//  タブ：つなぐ設定（オン/オフ・合言葉・登録するメールアドレス）／対応表（クーポン→メニュー・人数、スタッフ）／受信ログ（再処理・手で直す）／テスト（テスト店舗だけ）
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getRepo, isTestStore, hm, type Store, type Menu, type Staff, type HpbSettings, type HpbMapping, type InboundMail } from "@/lib/db";
import { INBOUND_STATUS_LABEL, resolveMenu, type InboundStatus } from "@/lib/inbound/process";
import { HPB_KIND_LABEL, type HpbKind, type HpbManualFix } from "@/lib/inbound/hpb";
import { INBOX_EVENT } from "@/components/Nav";
import { SettingsFrame, useAdmin, Field } from "../SettingsParts";

type Tab = "setup" | "map" | "log" | "test";
const TAB_LABEL: Record<Tab, string> = { setup: "つなぐ設定", map: "対応表", log: "受信ログ", test: "テスト" };
const STATUS_COLOR: Record<InboundStatus, string> = { received: "bg-stone-200 text-stone-800", done: "bg-emerald-100 text-emerald-900", warn: "bg-amber-100 text-amber-900", review: "bg-rose-100 text-rose-800", error: "bg-rose-600 text-white", ignored: "bg-stone-100 text-stone-600", duplicate: "bg-stone-100 text-stone-600" };
const fmtAt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const localYmd = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const lines = (s: string) => s.split("\n").map(x => x.trim()).filter(Boolean);

async function sha256hex(s: string) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""); }
function randomToken() { const a = new Uint8Array(32); crypto.getRandomValues(a); return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }

export default function HpbSettingsPage() {
  const repo = getRepo();
  const { me, isAdmin, caps } = useAdmin();
  const [tab, setTabState] = useState<Tab>("setup");
  useEffect(() => { void Promise.resolve().then(() => { const t = new URLSearchParams(location.search).get("tab") as Tab | null; if (t && t in TAB_LABEL) setTabState(t); }); }, []);
  const setTab = (t: Tab) => { setTabState(t); history.replaceState(null, "", `?tab=${t}`); };
  const [store, setStore] = useState<Store | null>(null);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [settings, setSettings] = useState<HpbSettings | null>(null);
  const [maps, setMaps] = useState<HpbMapping[]>([]);
  const [mails, setMails] = useState<InboundMail[]>([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !!caps?.hpb11 && settings !== null;

  const load = useCallback(async () => {
    const [st, s, m, ml] = await Promise.all([repo.store(), repo.hpbSettings().catch(() => null), repo.hpbMappings().catch(() => null), repo.inboundMails(150).catch(() => null)]);
    setStore(st); setSettings(s); setMaps(m || []); setMails(ml || []);
  }, [repo]);
  useEffect(() => { void Promise.resolve().then(load); repo.menus().then(setMenus).catch(() => {}); repo.staff().then(setStaff).catch(() => {}); }, [repo, load]);

  async function run(f: () => Promise<unknown>, ok: string | ((r: unknown) => string)) {
    setBusy(true); setMsg("");
    try { const r = await f(); setMsg(typeof ok === "function" ? ok(r) : ok); await load(); window.dispatchEvent(new Event(INBOX_EVENT)); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  const showTest = !!store && isTestStore(store) && me?.role === "owner";
  const tabs: Tab[] = showTest ? ["setup", "map", "log", "test"] : ["setup", "map", "log"];
  const reviewCount = mails.filter(m => m.status === "review" || m.status === "error").length;

  return (
    <SettingsFrame title="設定" isAdmin={isAdmin} notReady={caps && !caps.hpb11 && "HPB連携は準備中です（DB更新 0011 の後に使えます。Supabase の SQL エディタで 0011_hpb_inbound.sql を流してください）。"}>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="seg" role="tablist" aria-label="HPB連携">
          {tabs.map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{TAB_LABEL[t]}{t === "log" && reviewCount > 0 && <span className="ml-1 inline-flex min-w-[18px] h-[18px] px-1 items-center justify-center rounded-full bg-rose-600 text-white text-[10px] font-bold">{reviewCount}</span>}</button>)}
        </div>
        {settings && <span className={`chip ${settings.enabled ? "bg-emerald-100 text-emerald-900" : "bg-stone-200 text-stone-700"}`}>{settings.enabled ? "● 取り込み中" : "○ 止めています"}</span>}
        <span className="text-xs text-ink-mute">HPBの予約メールを読んで台帳に入れるだけです（サロンボードには何も書き込みません）。</span>
      </div>
      {msg && <div className="mb-3 text-sm px-3 py-2 rounded bg-moss border border-line" role="status">{msg}</div>}
      {ready && store && settings && tab === "setup" && <SetupTab store={store} settings={settings} menus={menus} busy={busy} run={run} />}
      {ready && store && tab === "map" && <MapTab maps={maps} menus={menus} staff={staff} busy={busy} run={run} defaultMenuId={settings?.default_menu_id} />}
      {ready && tab === "log" && <LogTab mails={mails} menus={menus} staff={staff} busy={busy} run={run} reload={load} />}
      {ready && store && tab === "test" && showTest && <TestTab store={store} menus={menus} staff={staff} mails={mails} busy={busy} run={run} />}
    </SettingsFrame>
  );
}

type Run = (f: () => Promise<unknown>, ok: string | ((r: unknown) => string)) => Promise<void>;

// ---------------------------------------------------------------------------
function SetupTab({ store, settings, menus, busy, run }: { store: Store; settings: HpbSettings; menus: Menu[]; busy: boolean; run: Run }) {
  const repo = getRepo();
  const [origin, setOrigin] = useState("");
  useEffect(() => { void Promise.resolve().then(() => setOrigin(location.origin)); }, []);
  const suggested = `kokage.corp+hpb-${store.slug || "store"}@gmail.com`;
  const [addr, setAddr] = useState(settings.plus_address || suggested);
  const [fresh, setFresh] = useState<string | null>(null);
  const pc = settings.parser_config || {};
  const [pat, setPat] = useState((pc.reservationNoPatterns || []).join("\n"));
  const [cw, setCw] = useState((pc.cancelWords || []).join("\n"));
  const [chw, setChw] = useState((pc.changeWords || []).join("\n"));
  const [nw, setNw] = useState((pc.newWords || []).join("\n"));
  const [pw, setPw] = useState((pc.pairWords || []).join("\n"));
  const copy = (t: string, what: string) => navigator.clipboard?.writeText(t).then(() => alert(`${what}をコピーしました`)).catch(() => {});
  const url = `${origin}/api/inbound/hpb`;
  async function makeSecret() {
    if (settings.secret_hash && !confirm("合言葉を作り直すと、今の合言葉は使えなくなります（Apps Script の SECRET も入れ直しが必要）。作り直しますか？")) return;
    const secret = `${store.id}.${randomToken()}`;
    await run(async () => { await repo.saveHpbSettings({ secret_hash: await sha256hex(secret), secret_set_at: new Date().toISOString() }); setFresh(secret); }, "合言葉を作りました。下の合言葉は今だけ表示されます。Apps Script の SECRET に貼ってください。");
  }
  return (
    <div className="grid lg:grid-cols-2 gap-3">
      <div className="card space-y-3">
        <div className="font-bold">1. 取り込みのオン・オフ</div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-5 h-5" checked={settings.enabled} disabled={busy} onChange={e => run(() => repo.saveHpbSettings({ enabled: e.target.checked }), e.target.checked ? "取り込みをオンにしました" : "取り込みを止めました（届いたメールは受信ログに「無視」で残ります）")} />HPBの予約メールを台帳に取り込む</label>
        <div className="text-xs text-ink-mute">止めている間に届いたメールも受信ログに残ります。あとで「再処理」すると取り込めます。</div>
      </div>
      <div className="card space-y-3">
        <div className="font-bold">2. 合言葉（Apps Script と このアプリをつなぐ鍵）</div>
        <div className="text-sm">{settings.secret_hash ? <>作成済み（{fmtAt(settings.secret_set_at)}）。合言葉そのものは保存していないので、もう一度は表示できません。</> : <span className="text-amber-800">まだ作っていません。</span>}</div>
        <button className="btn-primary" disabled={busy} onClick={makeSecret}>{settings.secret_hash ? "合言葉を作り直す" : "合言葉を作る"}</button>
        {fresh && <div className="rounded border-2 border-amber-400 bg-amber-50 p-2 text-sm" data-testid="fresh-secret">
          <div className="font-bold text-amber-900 mb-1">今だけ表示しています。コピーして Apps Script の SECRET に貼ってください</div>
          <code className="block break-all text-xs bg-white border rounded p-1.5 select-all">{fresh}</code>
          <button className="btn text-xs mt-1" onClick={() => copy(fresh, "合言葉")}>コピー</button>
          <div className="text-[11px] text-amber-900 mt-1">LINE・メールに貼ったり、人に見せたりしないでください（この合言葉があれば、誰でもこの店の台帳に予約を入れられます）。</div>
        </div>}
      </div>
      <div className="card space-y-2">
        <div className="font-bold">3. サロンボードに登録するメールアドレス</div>
        <div className="text-xs text-ink-mute">サロンボードの「予約通知メールの送信先」（10件まで）に、このアドレスを1つ足します。Gmail の「+（プラス）」付きアドレスなので、kokage.corp@gmail.com に届きます。</div>
        <div className="flex gap-2"><input className="inp flex-1" value={addr} onChange={e => setAddr(e.target.value.trim())} aria-label="登録するメールアドレス" /><button className="btn" onClick={() => copy(addr, "アドレス")}>コピー</button></div>
        <button className="btn" disabled={busy || addr === settings.plus_address} onClick={() => run(() => repo.saveHpbSettings({ plus_address: addr || null }), "アドレスを保存しました")}>保存</button>
        <div className="text-xs">Apps Script の QUERY（探す条件）：<code className="bg-stone-100 px-1 rounded break-all">to:{addr} -label:HPB取込済</code></div>
      </div>
      <div className="card space-y-2">
        <div className="font-bold">4. Apps Script に入れる値</div>
        <Field label="WEBHOOK_URL（送り先）"><div className="flex gap-2"><input className="inp flex-1 text-xs" readOnly value={url} /><button className="btn" onClick={() => copy(url, "送り先URL")}>コピー</button></div></Field>
        <div className="text-xs text-ink-mute">手順は <code>docs/HPB連携_設定手順.md</code>。Apps Script のファイルは <code>tools/gas/hpb_forwarder.gs</code>。最初は DRY_RUN=true（試し：台帳には入れない）で動かし、受け取れることを確かめてから false にします。</div>
      </div>
      <div className="card space-y-2">
        <div className="font-bold">5. いつものメニュー（対応が見つからないとき）</div>
        <select className="inp w-full" value={settings.default_menu_id || ""} disabled={busy} onChange={e => run(() => repo.saveHpbSettings({ default_menu_id: e.target.value || null }), "保存しました")} aria-label="いつものメニュー">
          <option value="">（使わない：メニューなしで入れて「要確認」にする）</option>
          {menus.filter(m => m.category === "technical").map(m => <option key={m.id} value={m.id}>{m.name}（{m.duration_min}分）</option>)}
        </select>
      </div>
      <div className="card space-y-2 lg:col-span-2">
        <div className="font-bold">6. 読み取りの調整（本物のメールが届いてから）</div>
        <div className="text-xs text-ink-mute">本物のHPBのメールの形はまだ確かめていません。最初のメールが届いたら受信ログで本文を見て、読めなかったときだけここに足してください（1行に1つ。足した言葉は標準より先に使います）。</div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2">
          <Field label="予約番号の形（正規表現）" hint="標準：BE＋数字、YH＋数字 など"><textarea className="inp w-full h-24 text-xs font-mono" value={pat} onChange={e => setPat(e.target.value)} /></Field>
          <Field label="キャンセルとみなす件名の言葉" hint="標準：キャンセル"><textarea className="inp w-full h-24 text-xs" value={cw} onChange={e => setCw(e.target.value)} /></Field>
          <Field label="変更とみなす件名の言葉" hint="標準：予約変更・変更通知 など"><textarea className="inp w-full h-24 text-xs" value={chw} onChange={e => setChw(e.target.value)} /></Field>
          <Field label="新規とみなす件名の言葉" hint="標準：予約通知・新規予約 など"><textarea className="inp w-full h-24 text-xs" value={nw} onChange={e => setNw(e.target.value)} /></Field>
          <Field label="ペア（2名）とみなす言葉" hint="標準：ペア・2名・お二人 など"><textarea className="inp w-full h-24 text-xs" value={pw} onChange={e => setPw(e.target.value)} /></Field>
        </div>
        <button className="btn" disabled={busy} onClick={() => run(() => { for (const p of lines(pat)) { try { new RegExp(p); } catch { throw new Error(`予約番号の形「${p}」が正しくありません`); } } return repo.saveHpbSettings({ parser_config: { reservationNoPatterns: lines(pat), cancelWords: lines(cw), changeWords: lines(chw), newWords: lines(nw), pairWords: lines(pw) } }); }, "読み取りの調整を保存しました（受信ログの「再処理」で、保存した設定で読み直せます）")}>保存</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function MapTab({ maps, menus, staff, busy, run, defaultMenuId }: { maps: HpbMapping[]; menus: Menu[]; staff: Staff[]; busy: boolean; run: Run; defaultMenuId?: string | null }) {
  const repo = getRepo();
  const tech = menus.filter(m => m.category === "technical");
  const [nm, setNm] = useState<{ pattern: string; menu_id: string; people: string }>({ pattern: "", menu_id: "", people: "" });
  const [ns, setNs] = useState<{ pattern: string; staff_id: string }>({ pattern: "", staff_id: "" });
  const [tryText, setTryText] = useState("");
  const menuMaps = maps.filter(m => m.kind === "menu"), staffMaps = maps.filter(m => m.kind === "staff");
  const tried = useMemo(() => (tryText.trim() ? resolveMenu({ coupon: tryText, menu: null }, menus, maps, defaultMenuId) : null), [tryText, menus, maps, defaultMenuId]);
  const move = (list: HpbMapping[], i: number, d: number) => { const a = list[i], b = list[i + d]; if (!a || !b) return; return run(async () => { await repo.saveHpbMapping({ ...a, sort_order: b.sort_order }); await repo.saveHpbMapping({ ...b, sort_order: a.sort_order === b.sort_order ? a.sort_order + d : a.sort_order }); }, "並べ替えました"); };
  return (
    <div className="space-y-3">
      <div className="card">
        <div className="font-bold mb-1">クーポン・メニュー → 自社のメニュー</div>
        <div className="text-xs text-ink-mute mb-2">HPBのクーポン名（またはメニュー名）に「言葉」が入っていたら、そのメニューで台帳に入れます。上から順に見て、最初に当たったものを使います。どれにも当たらないときは、自社メニューの名前がそのまま入っているか → いつものメニュー の順に探します。</div>
        <table className="w-full text-sm">
          <thead><tr><th className="th">HPBのクーポン名に入っている言葉</th><th className="th">自社のメニュー</th><th className="th">人数</th><th className="th w-40"></th></tr></thead>
          <tbody>
            {menuMaps.map((r, i) => <tr key={r.id} className={r.active ? "" : "opacity-50"}>
              <td className="td">「{r.pattern}」</td><td className="td">{menus.find(m => m.id === r.menu_id)?.name || "（消えたメニュー）"}</td><td className="td">{r.people ? `${r.people}名` : "メニューどおり"}</td>
              <td className="td whitespace-nowrap"><button className="btn-quiet" aria-label="上へ" onClick={() => move(menuMaps, i, -1)}>↑</button><button className="btn-quiet" aria-label="下へ" onClick={() => move(menuMaps, i, 1)}>↓</button><button className="btn-quiet" onClick={() => run(() => repo.saveHpbMapping({ ...r, active: !r.active }), r.active ? "使わないにしました" : "使うにしました")}>{r.active ? "止める" : "使う"}</button><button className="btn-quiet text-rose-700" onClick={() => confirm(`「${r.pattern}」の対応を消しますか？`) && run(() => repo.deleteHpbMapping(r.id), "消しました")}>削除</button></td>
            </tr>)}
            <tr>
              <td className="td"><input className="inp w-full" placeholder="例：パリジェンヌ／ペア／【新規】" value={nm.pattern} onChange={e => setNm({ ...nm, pattern: e.target.value })} aria-label="新しい言葉" /></td>
              <td className="td"><select className="inp w-full" value={nm.menu_id} onChange={e => setNm({ ...nm, menu_id: e.target.value })} aria-label="自社のメニュー"><option value="">選ぶ</option>{tech.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></td>
              <td className="td"><select className="inp" value={nm.people} onChange={e => setNm({ ...nm, people: e.target.value })} aria-label="人数"><option value="">メニューどおり</option><option value="1">1名</option><option value="2">2名（ペア）</option></select></td>
              <td className="td"><button className="btn-primary" disabled={busy || !nm.pattern.trim() || !nm.menu_id} onClick={() => run(async () => { await repo.saveHpbMapping({ kind: "menu", pattern: nm.pattern, menu_id: nm.menu_id, people: nm.people ? Number(nm.people) : null }); setNm({ pattern: "", menu_id: "", people: "" }); }, "対応を足しました")}>足す</button></td>
            </tr>
          </tbody>
        </table>
        <div className="mt-3 rounded bg-paper border border-line p-2">
          <div className="text-xs font-semibold mb-1">試す：HPBのクーポン名を貼ると、どのメニューになるか分かります</div>
          <input className="inp w-full" placeholder="例：【新規】まつ毛パーマ＋眉Wax 8,800円" value={tryText} onChange={e => setTryText(e.target.value)} aria-label="試すクーポン名" />
          {tried && <div className="text-sm mt-1">{tried.menu ? <>→ <b>{tried.menu.name}</b>（{tried.via === "rule" ? `対応表「${tried.rule?.pattern}」` : tried.via === "auto" ? "メニュー名が入っていたので自動" : "いつものメニュー"}）{tried.people ? `・${tried.people}名` : ""}</> : <span className="text-rose-700">→ 見つかりません（メニューなしで入れて「要確認」になります）</span>}</div>}
        </div>
      </div>
      <div className="card">
        <div className="font-bold mb-1">HPBのスタッフ名 → 自社の担当</div>
        <div className="text-xs text-ink-mute mb-2">HPBの指名スタッフ名が自社の名前と違うとき（例：HPBは「Yuki」、自社は「菊池」）だけ足してください。同じ名前なら自動で合わせます。</div>
        <table className="w-full text-sm">
          <thead><tr><th className="th">HPBのスタッフ名に入っている言葉</th><th className="th">自社の担当</th><th className="th w-32"></th></tr></thead>
          <tbody>
            {staffMaps.map(r => <tr key={r.id}><td className="td">「{r.pattern}」</td><td className="td">{staff.find(s => s.id === r.staff_id)?.name || "（台帳に出ていない人）"}</td><td className="td"><button className="btn-quiet text-rose-700" onClick={() => run(() => repo.deleteHpbMapping(r.id), "消しました")}>削除</button></td></tr>)}
            <tr>
              <td className="td"><input className="inp w-full" placeholder="例：Yuki" value={ns.pattern} onChange={e => setNs({ ...ns, pattern: e.target.value })} aria-label="HPBのスタッフ名" /></td>
              <td className="td"><select className="inp w-full" value={ns.staff_id} onChange={e => setNs({ ...ns, staff_id: e.target.value })} aria-label="自社の担当"><option value="">選ぶ</option>{staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></td>
              <td className="td"><button className="btn-primary" disabled={busy || !ns.pattern.trim() || !ns.staff_id} onClick={() => run(async () => { await repo.saveHpbMapping({ kind: "staff", pattern: ns.pattern, staff_id: ns.staff_id }); setNs({ pattern: "", staff_id: "" }); }, "対応を足しました")}>足す</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function LogTab({ mails, menus, staff, busy, run, reload }: { mails: InboundMail[]; menus: Menu[]; staff: Staff[]; busy: boolean; run: Run; reload: () => Promise<void> }) {
  const repo = getRepo();
  const [open, setOpen] = useState<string | null>(null);
  const [fix, setFix] = useState<{ id: string; f: HpbManualFix } | null>(null);
  const [filter, setFilter] = useState<"all" | "attention">("all");
  const list = filter === "all" ? mails : mails.filter(m => m.status === "review" || m.status === "error" || m.status === "warn");
  function startFix(m: InboundMail) {
    const p = m.parsed; const mf = m.manual || {};
    setFix({ id: m.id, f: { kind: (mf.kind || p?.kind || "new") as HpbKind, reservationNo: mf.reservationNo ?? p?.reservationNo ?? "", date: mf.date ?? p?.date ?? "", start: mf.start ?? p?.start ?? "", durationMin: mf.durationMin ?? p?.durationMin ?? null, name: mf.name ?? p?.name ?? "", kana: mf.kana ?? p?.kana ?? "", phone: mf.phone ?? p?.phone ?? "", menu_id: mf.menu_id ?? null, staff_id: mf.staff_id ?? null, people: mf.people ?? (p?.people && p.people > 1 ? p.people : null) } });
    setOpen(m.id);
  }
  const setF = (p: Partial<HpbManualFix>) => fix && setFix({ ...fix, f: { ...fix.f, ...p } });
  return (
    <div className="card">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="font-bold">受信ログ（新しい順・最大150件）</div>
        <div className="seg"><button aria-pressed={filter === "all"} onClick={() => setFilter("all")}>すべて</button><button aria-pressed={filter === "attention"} onClick={() => setFilter("attention")}>要確認だけ</button></div>
        <button className="btn-quiet ml-auto" onClick={() => reload()}>更新</button>
      </div>
      {!list.length && <div className="state">{filter === "all" ? "まだメールは届いていません。" : "要確認のメールはありません。"}</div>}
      <div className="divide-y divide-line">
        {list.map(m => {
          const p = m.parsed; const isOpen = open === m.id;
          return (
            <div key={m.id} className="py-2" data-testid="inbound-row" data-status={m.status}>
              <button className="w-full text-left flex flex-wrap items-start gap-x-2 gap-y-1" onClick={() => setOpen(isOpen ? null : m.id)} aria-expanded={isOpen}>
                <span className={`chip font-semibold ${STATUS_COLOR[m.status]}`}>{INBOUND_STATUS_LABEL[m.status]}</span>
                {m.is_test && <span className="chip bg-amber-200 text-amber-900">テスト</span>}
                <span className="text-xs text-ink-mute tabular-nums">{fmtAt(m.created_at)}</span>
                <span className="text-xs">{HPB_KIND_LABEL[(m.kind || "unknown") as HpbKind]}</span>
                {m.reservation_no && <span className="text-xs font-mono">{m.reservation_no}</span>}
                {p?.startIso && <span className="text-xs">来店 {new Date(p.startIso).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" })} {hm(p.startIso)}</span>}
                {(p?.name || p?.kana) && <span className="text-xs">{p.name || p.kana}様</span>}
                <span className="basis-full text-sm truncate">{m.subject}</span>
                {m.action && <span className="basis-full text-xs text-ink-soft whitespace-pre-line">{m.action}</span>}
                {m.error && <span className="basis-full text-xs text-rose-700">エラー：{m.error}</span>}
              </button>
              {isOpen && (
                <div className="mt-2 grid lg:grid-cols-2 gap-3">
                  <div>
                    <div className="text-xs font-semibold mb-1">読み取った内容{p ? `（自信 ${Math.round(p.confidence * 100)}%）` : ""}</div>
                    {p ? <table className="text-xs w-full"><tbody>
                      {([["種類", HPB_KIND_LABEL[p.kind]], ["予約番号", p.reservationNo], ["来店日時", p.date && p.start ? `${p.date} ${p.start}${p.end ? `〜${p.end}` : ""}` : null], ["変更前", p.prev ? `${p.prev.date} ${p.prev.start}` : null], ["施術時間", p.durationMin ? `${p.durationMin}分` : null], ["お名前", p.name], ["カナ", p.kana], ["電話", p.phone], ["クーポン", p.coupon], ["メニュー", p.menu], ["指名", p.staff || (p.nominated ? "" : "指名なし")], ["人数", `${p.people}名${p.peopleHint ? `（${p.peopleHint}）` : ""}`], ["予定金額", p.total != null ? `${p.total.toLocaleString()}円` : null], ["要望", p.request]] as [string, string | null][]).map(([k, v]) =>
                        <tr key={k}><td className="pr-2 py-0.5 text-ink-mute whitespace-nowrap align-top">{k}</td><td className={`py-0.5 ${v ? "" : "text-rose-600"}`}>{v || "（読めず）"}</td></tr>)}
                    </tbody></table> : <div className="text-xs">—</div>}
                    {p && (p.missing.length > 0 || p.warnings.length > 0) && <ul className="mt-1 text-xs text-amber-900 list-disc pl-4">{p.missing.length > 0 && <li>読めなかった：{p.missing.join("・")}</li>}{p.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
                    <div className="flex flex-wrap gap-2 mt-2">
                      <button className="btn" disabled={busy} onClick={() => run(() => repo.hpbAction({ kind: "reprocess", mail_id: m.id }), r => `再処理しました：${INBOUND_STATUS_LABEL[(r as { status: InboundStatus }).status] || ""}`)}>再処理</button>
                      <button className="btn" disabled={busy} onClick={() => startFix(m)}>手で直す</button>
                      {m.status !== "ignored" && <button className="btn-quiet" disabled={busy} onClick={() => run(() => repo.hpbAction({ kind: "ignore", mail_id: m.id }), "無視にしました")}>無視する</button>}
                      {m.booking_id && p?.date && <Link className="btn" href={`/bookings?date=${p.date}`}>台帳で見る</Link>}
                    </div>
                    {fix?.id === m.id && (
                      <div className="mt-2 rounded border border-line-strong p-2 space-y-2 bg-paper" data-testid="fix-form">
                        <div className="text-xs font-semibold">手で直す（入れた値を優先して、もう一度台帳に反映します）</div>
                        <div className="grid grid-cols-2 gap-2">
                          <Field label="種類"><select className="inp w-full" value={fix.f.kind} onChange={e => setF({ kind: e.target.value as HpbKind })}><option value="new">新規</option><option value="change">変更</option><option value="cancel">キャンセル</option></select></Field>
                          <Field label="予約番号"><input className="inp w-full" value={fix.f.reservationNo || ""} onChange={e => setF({ reservationNo: e.target.value })} /></Field>
                          <Field label="来店日"><input type="date" className="inp w-full" value={fix.f.date || ""} onChange={e => setF({ date: e.target.value })} /></Field>
                          <Field label="開始"><input type="time" step={900} className="inp w-full" value={fix.f.start || ""} onChange={e => setF({ start: e.target.value })} /></Field>
                          <Field label="施術時間（分）"><input type="number" className="inp w-full" value={fix.f.durationMin ?? ""} onChange={e => setF({ durationMin: e.target.value ? Number(e.target.value) : null })} /></Field>
                          <Field label="人数"><select className="inp w-full" value={fix.f.people ?? ""} onChange={e => setF({ people: e.target.value ? Number(e.target.value) : null })}><option value="">メニューどおり</option><option value="1">1名</option><option value="2">2名（ペア）</option></select></Field>
                          <Field label="お名前"><input className="inp w-full" value={fix.f.name || ""} onChange={e => setF({ name: e.target.value })} /></Field>
                          <Field label="カナ"><input className="inp w-full" value={fix.f.kana || ""} onChange={e => setF({ kana: e.target.value })} /></Field>
                          <Field label="電話"><input className="inp w-full" value={fix.f.phone || ""} onChange={e => setF({ phone: e.target.value })} /></Field>
                          <Field label="メニュー"><select className="inp w-full" value={fix.f.menu_id || ""} onChange={e => setF({ menu_id: e.target.value || null })}><option value="">対応表どおり</option>{menus.filter(x => x.category === "technical").map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
                          <Field label="担当（指名）"><select className="inp w-full" value={fix.f.staff_id || ""} onChange={e => setF({ staff_id: e.target.value || null })}><option value="">メールどおり／空いている人</option>{staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
                        </div>
                        <div className="flex gap-2 justify-end"><button className="btn" onClick={() => setFix(null)}>やめる</button><button className="btn-primary" disabled={busy} onClick={() => run(async () => { const r = await repo.hpbAction({ kind: "fix", mail_id: m.id, manual: fix.f }); setFix(null); return r; }, r => `直した値で反映しました：${INBOUND_STATUS_LABEL[(r as { status: InboundStatus }).status] || ""}`)}>直して反映する</button></div>
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-xs font-semibold mb-1">メールの本文（届いたまま）</div>
                    <pre className="text-[11px] whitespace-pre-wrap bg-paper border border-line rounded p-2 max-h-80 overflow-auto font-sans">{m.body}</pre>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function TestTab({ store, menus, staff, mails, busy, run }: { store: Store; menus: Menu[]; staff: Staff[]; mails: InboundMail[]; busy: boolean; run: Run }) {
  const repo = getRepo();
  const tech = menus.filter(m => m.category === "technical");
  const coupons = tech.map(m => ({ label: `${(m.people ?? 1) > 1 ? "【ペア】" : "【新規】"}${m.name}`, minutes: m.duration_min, price: m.price }));
  const recent = [...new Map(mails.filter(m => m.is_test && m.reservation_no && m.kind === "new").map(m => [m.reservation_no!, m])).values()];
  const [kind, setKind] = useState<"new" | "change" | "cancel">("new");
  const [date, setDate] = useState(localYmd());
  const [start, setStart] = useState("13:00");
  const [ci, setCi] = useState(0);
  const [nom, setNom] = useState("");
  const [ref, setRef] = useState("");
  const c = coupons[ci] || { label: "【新規】まつ毛パーマ", minutes: 60, price: 0 };
  const refUse = ref || recent[0]?.reservation_no || "";
  const prev = mails.find(m => m.reservation_no === refUse)?.parsed;
  return (
    <div className="card max-w-2xl space-y-3">
      <div className="font-bold">テストメールを送る（テスト店舗だけ・オーナーだけ）</div>
      <div className="text-sm text-ink-soft">HPBの予約通知メールに似せた練習用のメールを作り、本物と同じ処理（読み取り → 台帳 → 受信ログ）に通します。HPBやサロンボードには何も送りません。</div>
      <div className="grid sm:grid-cols-2 gap-2">
        <Field label="種類"><select className="inp w-full" value={kind} onChange={e => setKind(e.target.value as typeof kind)} aria-label="テストメールの種類"><option value="new">新規の予約</option><option value="change">変更（日時を動かす）</option><option value="cancel">キャンセル</option></select></Field>
        {kind !== "new" && <Field label="どの予約を（テストで入れた予約番号）"><select className="inp w-full" value={refUse} onChange={e => setRef(e.target.value)} aria-label="予約番号">{!recent.length && <option value="">（まだありません。先に新規を送ってください）</option>}{recent.map(m => <option key={m.reservation_no!} value={m.reservation_no!}>{m.reservation_no}（{m.parsed?.date} {m.parsed?.start} {m.parsed?.coupon}）</option>)}</select></Field>}
        {kind !== "cancel" && <>
          <Field label="来店日"><input type="date" className="inp w-full" value={date} onChange={e => setDate(e.target.value)} aria-label="来店日" /></Field>
          <Field label="開始"><input type="time" step={900} className="inp w-full" value={start} onChange={e => setStart(e.target.value)} aria-label="開始" /></Field>
          <Field label="HPBのクーポン"><select className="inp w-full" value={ci} onChange={e => setCi(Number(e.target.value))} aria-label="クーポン">{coupons.map((x, i) => <option key={i} value={i}>{x.label}</option>)}</select></Field>
          <Field label="指名"><select className="inp w-full" value={nom} onChange={e => setNom(e.target.value)} aria-label="指名"><option value="">指名なし</option>{staff.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}</select></Field>
        </>}
      </div>
      <button className="btn-primary" disabled={busy || (kind !== "new" && !refUse)} data-testid="send-test-mail" onClick={() => run(() => repo.hpbAction({ kind: "test", test: kind === "new"
        ? { kind, date, start, minutes: c.minutes, coupon: c.label, staff: nom || null, total: c.price }
        : kind === "change" ? { kind, date, start, minutes: prev?.durationMin || c.minutes, coupon: prev?.coupon || c.label, staff: nom || null, reservationNo: refUse, prevDate: prev?.date, prevStart: prev?.start }
        : { kind, date: prev?.date || date, start: prev?.start || start, minutes: prev?.durationMin || 60, coupon: prev?.coupon || "", reservationNo: refUse } }),
        r => { const x = r as { status: InboundStatus; action?: string }; return `テストメールを処理しました：${INBOUND_STATUS_LABEL[x.status]}／${x.action || ""}`; })}>テストメールを送る</button>
      <div className="text-xs text-ink-mute">結果は「受信ログ」と <Link className="underline" href={`/bookings?date=${kind === "cancel" ? prev?.date || date : date}`}>予約台帳</Link> で確かめられます。空きが無い時間を選ぶと「ダブルブッキングの可能性」の赤い印がつきます。店舗：{store.name}</div>
    </div>
  );
}
