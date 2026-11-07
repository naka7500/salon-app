"use client";
// 公式ネット予約ページ（お客様用・ログイン不要）。スマホ最優先。
// 流れ：メニュー/クーポン →（オプション：必須は選ぶまで進めない）→ 日付・時間（オプション込みの時間で空きを出す）→ お客様情報 → 事前問診 → 確認 → 完了
// データは公開用の関数（public_*）だけを通す。料金・空きの最終確認はサーバ側で行う。
import { use, useCallback, useEffect, useMemo, useState } from "react";
import { getPublicApi, couponConditions, couponPrice, intakeQuestionsFor, errorText, type PublicStore, type PublicCatalog, type PublicMenu, type PublicCoupon, type PublicBookingResult, type PublicOptionGroup } from "@/lib/web";
import type { IntakeAnswer, IntakeQuestion } from "@/lib/db/types";
import { T, fmtDate, fmtDateTime, yenFmt, initialLang, LANG_KEY, type Lang } from "../i18n";
import { useLiff, addFriendUrl } from "../liff";

type Step = "menu" | "option" | "date" | "info" | "intake" | "confirm" | "done";
const ACCENT = "#2d5d49";   // globals.css の canopy と同じ
const pad = (n: number) => String(n).padStart(2, "0");
const ymdOf = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
const addDaysS = (d: string, n: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return ymdOf(x); };
const firstOf = (ym: string) => `${ym}-01`;
const addMonth = (ym: string, n: number) => { const [y, m] = ym.split("-").map(Number); const x = new Date(y, m - 1 + n, 1); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}`; };

export default function PublicBookingPage({ params }: { params: Promise<{ storeSlug: string }> }) {
  const { storeSlug } = use(params);
  const api = getPublicApi();
  const [lang, setLangState] = useState<Lang>("ja");
  const t = T[lang];
  const [phase, setPhase] = useState<"loading" | "ok" | "closed" | "notready">("loading");
  const [store, setStore] = useState<PublicStore | null>(null);
  const [cat, setCat] = useState<PublicCatalog | null>(null);
  const [tab, setTab] = useState<"coupon" | "menu">("coupon");
  const [code, setCode] = useState(""); const [codeMsg, setCodeMsg] = useState(""); const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("menu");
  const [menu, setMenu] = useState<PublicMenu | null>(null);
  const [coupon, setCoupon] = useState<PublicCoupon | null>(null);
  const [pickFor, setPickFor] = useState<PublicCoupon | null>(null);
  const [staffId, setStaffId] = useState("");
  const [optSel, setOptSel] = useState<string[]>([]);
  const [ym, setYm] = useState("");
  const [avail, setAvail] = useState<Record<string, Record<string, string[]>>>({});
  const [availLoading, setAvailLoading] = useState(false);
  const [date, setDate] = useState(""); const [time, setTime] = useState("");
  const [info, setInfo] = useState({ name: "", kana: "", phone: "", email: "" });
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublicBookingResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  // LINE の中（LIFF）で開いたとき：予約と LINE をつなぐ／会計のQRから来たときは連携だけ
  const { liff, linkToken } = useLiff(api, storeSlug);
  const [lineLinked, setLineLinked] = useState<null | "ok" | string>(null);
  const [prefilled, setPrefilled] = useState(false);
  // LINEの中で開いた・つながっているお客様：前回の名前・電話・メールを最初から入れておく（確認して直せる）
  useEffect(() => {
    if (liff.phase !== "ready" || liff.demo || !api.lineMe) return;
    let live = true;
    api.lineMe({ slug: storeSlug, idToken: liff.idToken }).then(r => {
      if (!live || !r.found) return;
      setInfo(prev => (prev.name || prev.phone || prev.email) ? prev : { name: r.name || "", kana: r.kana || "", phone: r.phone || "", email: r.email || "" });
      setPrefilled(true);
    }).catch(() => {});
    return () => { live = false; };
  }, [api, liff, storeSlug]);
  useEffect(() => {
    if (liff.phase !== "ready" || !linkToken || !api.linkLine) return;
    api.linkLine({ slug: storeSlug, idToken: liff.idToken, mode: "token", token: linkToken }).then(r => setLineLinked(r.ok ? "ok" : r.message || "つなげませんでした")).catch(() => setLineLinked("つなげませんでした"));
  }, [api, liff, linkToken, storeSlug]);

  const setLang = (l: Lang) => { setLangState(l); try { localStorage.setItem(LANG_KEY, l); } catch {} };
  useEffect(() => { void Promise.resolve().then(() => { setLangState(initialLang()); setOrigin(location.origin); }); }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);

  useEffect(() => { (async () => {
    try {
      const s = await api.storeInfo(storeSlug);
      if (!s) { setPhase("closed"); return; }
      const c = await api.menus(storeSlug);
      setStore(s); setCat(c); setYm(s.today.slice(0, 7)); setTab(c && c.coupons.length ? "coupon" : "menu"); setPhase("ok");
      document.title = `${s.name}｜ネット予約`;
    } catch (e) { setPhase((e as Error).message.includes("not_ready") ? "notready" : "closed"); }
  })(); }, [api, storeSlug]);

  const L = useCallback((ja?: string | null, en?: string | null) => (lang === "en" && en ? en : ja || ""), [lang]);
  const today = store?.today || ymdOf(new Date());
  const lastDay = store ? addDaysS(today, store.booking_horizon_days) : today;
  const questions: IntakeQuestion[] = useMemo(() => (store ? intakeQuestionsFor({ business_type: store.business_type, intake_questions: store.intake_questions }) : []), [store]);
  const people = menu?.people || 1;
  // 指名料：指名したときだけ足す（サーバの public_create_booking と同じ）
  const nomFee = staffId && cat ? cat.staff.find(s => s.id === staffId)?.fee || 0 : 0;
  // オプション：このメニュー（＋クーポン）で選べるグループ
  const optGroups: PublicOptionGroup[] = useMemo(() => { if (!menu || !cat?.option_groups) return []; const ids = new Set([...(menu.option_group_ids || []), ...(coupon?.option_group_ids || [])]); return cat.option_groups.filter(g => ids.has(g.id)); }, [menu, coupon, cat]);
  const optItems = optGroups.flatMap(g => g.items).filter(i => optSel.includes(i.id));
  const optMin = optItems.reduce((a, i) => a + i.minutes, 0), optPrice = optItems.reduce((a, i) => a + i.price, 0);
  const optMissing = optGroups.filter(g => g.required && !g.items.some(i => optSel.includes(i.id)));
  const optLabel = optItems.map(i => L(i.name, i.name_en)).join("＋");
  // 料金：ペアは1組の料金（0009 より前のDBは1名分×人数）＋オプション×人数＋指名料
  const base = menu ? (coupon ? couponPrice(coupon.kind, coupon.value, menu.price) : menu.price) : 0;
  const totalPrice = menu ? (menu.price_per === "group" ? base : base * people) + optPrice * people + nomFee : 0;
  const totalMin = (menu?.duration_min || 0) + optMin;
  const stepKeys: Step[] = ["menu", ...(optGroups.length ? ["option" as Step] : []), "date", "info", ...(questions.length ? ["intake" as Step] : []), "confirm"];
  const stepLabel: Record<string, string> = { menu: t.steps[0], option: t.option, date: t.steps[1], info: t.steps[2], intake: t.steps[3], confirm: t.steps[4] };
  const availKey = menu ? `${menu.id}|${coupon?.id || ""}|${staffId}|${optSel.slice().sort().join(",")}|${ym}` : "";
  const days = availKey ? avail[availKey] : undefined;

  // 空き（月ごとにまとめて取る）
  useEffect(() => {
    if (!menu || !ym || step !== "date" || !store || avail[availKey]) return;
    const from = firstOf(ym) < today ? today : firstOf(ym);
    const nextFirst = firstOf(addMonth(ym, 1)); const end = addDaysS(lastDay, 1);
    const to = nextFirst < end ? nextFirst : end;
    if (from >= to) { void Promise.resolve().then(() => setAvail(a => ({ ...a, [availKey]: {} }))); return; }
    let live = true;
    void Promise.resolve().then(() => setAvailLoading(true));
    api.availability(storeSlug, menu.id, from, to, coupon?.id, staffId || null, optSel).then(r => { if (live) setAvail(a => ({ ...a, [availKey]: r?.days || {} })); })
      .catch(e => { if (live) setErr(errorText(e, lang)); }).finally(() => { if (live) setAvailLoading(false); });
    return () => { live = false; };
  }, [api, storeSlug, menu, coupon, staffId, optSel, ym, step, store, avail, availKey, today, lastDay, lang]);

  async function applyCode() {
    const c = code.trim(); if (!c) return;
    const r = await api.menus(storeSlug, c).catch(() => null);
    if (r && r.coupons.length > (cat?.coupons.length || 0)) { setCat(r); setAppliedCode(c); setCodeMsg(t.codeOk); setTab("coupon"); } else setCodeMsg(t.codeNg);
  }
  const couponMenus = (c: PublicCoupon) => (cat?.menus || []).filter(m => !c.menu_ids.length || c.menu_ids.includes(m.id));
  function chooseMenu(m: PublicMenu, c: PublicCoupon | null) {
    setMenu(m); setCoupon(c); setPickFor(null); setDate(""); setTime(""); setErr(""); setOptSel([]);
    if (!m.nominatable) setStaffId("");
    const ids = new Set([...(m.option_group_ids || []), ...(c?.option_group_ids || [])]);
    setStep((cat?.option_groups || []).some(g => ids.has(g.id)) ? "option" : "date"); window.scrollTo({ top: 0 });
  }
  function chooseCoupon(c: PublicCoupon) { const ms = couponMenus(c); if (ms.length === 1) chooseMenu(ms[0], c); else setPickFor(c); }

  const answerList = (): IntakeAnswer[] => questions.map(q => {
    const a = answers[q.id]; const toJa = (v: string) => { const i = (q.options_en || []).indexOf(v); return i >= 0 && q.options?.[i] ? q.options[i] : v; };
    const s = Array.isArray(a) ? a.map(toJa).join("・") : a ? toJa(String(a)) : "";
    return { label: q.label, answer: s.trim() };
  }).filter(x => x.answer);
  const missingQ = questions.filter(q => q.required && !(Array.isArray(answers[q.id]) ? (answers[q.id] as string[]).length : String(answers[q.id] || "").trim()));
  const infoOk = info.name.trim() && (lang === "en" || info.kana.trim()) && info.phone.replace(/[^0-9]/g, "").length >= 8 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(info.email.trim());

  async function submit() {
    if (!menu || !date || !time || !store) return;
    setBusy(true); setErr("");
    try {
      const r = await api.createBooking({ slug: storeSlug, menu_id: menu.id, start_at: new Date(`${date}T${time}:00`).toISOString(), name: info.name, kana: info.kana, phone: info.phone, email: info.email, intake: answerList(), coupon_id: coupon?.id || null, code: appliedCode, staff_id: staffId || null, lang, option_ids: optSel });
      setResult(r); setStep("done"); window.scrollTo({ top: 0 });
      if (liff.phase === "ready" && api.linkLine) api.linkLine({ slug: storeSlug, idToken: liff.idToken, mode: "booking", cancel_token: r.cancel_token }).then(x => setLineLinked(x.ok ? "ok" : x.message || "")).catch(() => {});
    } catch (e) {
      const msg = (e as Error).message;
      setErr(errorText(e, lang));
      if (msg.includes("slot_taken")) { setAvail({}); setTime(""); setStep("date"); }
    } finally { setBusy(false); }
  }
  const go = (s: Step) => { setErr(""); setStep(s); window.scrollTo({ top: 0 }); };

  // ---------- 画面 ----------
  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-paper text-ink">
      <div className="max-w-md mx-auto min-h-screen bg-[#fbfcfb] sm:border-x border-line pb-28">
        <header className="sticky top-0 z-20 bg-[#fbfcfb]/95 backdrop-blur border-b border-line">
          <div className="flex items-center gap-2 px-4 h-14">
            {store?.logo_url ? <img src={store.logo_url} alt="" className="w-8 h-8 rounded-full object-cover" /> : <span className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold" style={{ background: ACCENT }}>{(store?.name || "予").slice(0, 1)}</span>}
            <div className="min-w-0 flex-1"><div className="font-bold truncate leading-tight">{store ? L(store.name, store.name_en) : ""}</div><div className="text-[11px] text-stone-500 leading-tight">{t.book}</div></div>
            <div className="flex rounded-full border border-stone-300 overflow-hidden text-xs" role="group" aria-label="Language">
              {(["ja", "en"] as Lang[]).map(l => <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} className={`px-3 py-1.5 min-w-[44px] ${lang === l ? "text-white" : "text-stone-600"}`} style={lang === l ? { background: ACCENT } : undefined}>{l === "ja" ? "日本語" : "EN"}</button>)}
            </div>
          </div>
          {phase === "ok" && step !== "done" && (
            <div className="px-4 pb-2">
              <div className="flex gap-1">{stepKeys.map((k, i) => { const cur = stepKeys.indexOf(step); return <div key={k} className="flex-1"><div className="h-1.5 rounded-full" style={{ background: i <= cur ? ACCENT : "#e7e2da" }} /><div className={`text-[10px] mt-0.5 text-center ${i === cur ? "font-bold text-stone-800" : "text-stone-400"}`}>{stepLabel[k]}</div></div>; })}</div>
            </div>
          )}
        </header>
        {children}
        <footer className="px-4 pt-6 pb-4 text-center text-[11px] text-stone-500" data-testid="public-footer">
          <a className="underline mx-2" href={`/r/${storeSlug}/privacy`}>{lang === "en" ? "Privacy policy (Japanese)" : "プライバシーポリシー"}</a>
          <a className="underline mx-2" href={`/r/${storeSlug}/terms`}>{lang === "en" ? "Terms of use (Japanese)" : "利用規約"}</a>
        </footer>
      </div>
    </div>
  );

  // 会計のQRから来た：LINE連携だけの画面
  if (linkToken !== null || (liff.phase !== "off" && new URLSearchParams(typeof location !== "undefined" ? location.search : "").has("link"))) {
    const friend = liff.phase === "ready" ? addFriendUrl(liff.basicId) : null;
    return shell(
      <div className="px-4 pt-10 text-center space-y-4" data-testid="liff-link">
        <div className="mx-auto w-16 h-16 rounded-full flex items-center justify-center text-white text-2xl font-bold" style={{ background: lineLinked === "ok" ? "#06c755" : "#9aa59f" }} aria-hidden>{lineLinked === "ok" ? "✓" : "LINE"}</div>
        {liff.phase === "error" ? <div className="text-sm text-rose-700">{liff.message}</div>
          : lineLinked === "ok" ? <>
            <h1 className="text-xl font-bold">LINE連携が完了しました</h1>
            <div className="text-sm text-stone-600">次回から、ご予約の前日のご確認などを LINE でお送りします。{liff.phase === "ready" && liff.demo ? "（デモ：実際には送りません）" : ""}</div>
            {friend && <a className="inline-flex min-h-12 px-6 items-center rounded-xl text-white font-bold" style={{ background: "#06c755" }} href={friend}>友だち追加する</a>}
            <div className="text-xs text-stone-500">お知らせが不要になったら、トークで「配信停止」と送ってください。</div>
          </> : lineLinked ? <div className="text-sm text-rose-700">{lineLinked}</div>
          : <div className="text-sm text-stone-500">LINEとつないでいます…</div>}
      </div>
    );
  }
  if (phase === "loading") return shell(<div className="p-10 text-center text-stone-500">{t.loading}</div>);
  if (phase !== "ok" || !store || !cat) return shell(
    <div className="p-8 text-center space-y-3">
      <div className="text-lg font-bold">{t.closed}</div>
      <div className="text-sm text-stone-600">{t.closedNote}</div>
    </div>
  );

  const bigBtn = "w-full rounded-2xl py-4 text-base font-bold text-white shadow-sm disabled:opacity-40 active:scale-[0.99] transition";
  const card = "w-full text-left bg-white rounded-2xl border border-stone-200 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.04)] active:bg-stone-50";
  const priceTag = (m: PublicMenu, c: PublicCoupon | null) => {
    const p = c ? couponPrice(c.kind, c.value, m.price) : m.price;
    return <span className="whitespace-nowrap">{c && p !== m.price && <s className="text-xs text-stone-400 mr-1">{yenFmt(m.price)}</s>}<b className="text-lg" style={{ color: c ? "#b4472f" : undefined }}>{yenFmt(p)}</b><span className="text-[10px] text-stone-500">{m.people > 1 && m.price_per === "group" ? t.perPairShort : ""}{t.taxIn}</span></span>;
  };
  const badges = (target: string, ppl?: number) => <>
    {target === "new" && <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200">{t.forNew}</span>}
    {target === "repeat" && <span className="text-[11px] px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200">{t.forRepeat}</span>}
    {ppl && ppl > 1 ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">{t.pair}</span> : null}
  </>;
  const summary = menu && (
    <div className="mx-4 mt-3 rounded-xl bg-white border border-stone-200 px-3 py-2 text-sm flex items-center gap-2">
      <div className="min-w-0 flex-1"><div className="font-semibold truncate">{L(menu.name, menu.name_en)}{optLabel && <span className="font-normal">＋{optLabel}</span>}</div>{coupon && <div className="text-xs text-[#b4472f] truncate">{L(coupon.name, coupon.name_en)}</div>}<div className="text-xs text-stone-500">{totalMin}{t.minutes}{people > 1 ? `・${t.people(people)}` : ""}{date ? `・${fmtDate(date, lang)}${time ? ` ${time}` : ""}` : ""}</div></div>
      <div className="text-right font-semibold" data-testid="summary-price">{yenFmt(totalPrice)}</div>
    </div>
  );
  const errBox = err && <div role="alert" className="mx-4 mt-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm px-3 py-2">{err}</div>;

  // ---- 1. メニュー・クーポン ----
  if (step === "menu") return shell(<>
    {store.photo_url && <img src={store.photo_url} alt="" className="w-full h-44 object-cover" />}
    {store.web_message && <div className="mx-4 mt-3 text-sm rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 whitespace-pre-wrap">{store.web_message}</div>}
    <h1 className="px-4 pt-4 pb-2 text-lg font-bold">{t.pickMenu}</h1>
    <div className="px-4 flex gap-2" role="tablist">
      {(["coupon", "menu"] as const).map(k => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`flex-1 py-3 rounded-xl text-sm font-bold border ${tab === k ? "text-white border-transparent" : "bg-white border-stone-200 text-stone-600"}`} style={tab === k ? { background: ACCENT } : undefined}>{k === "coupon" ? `${t.coupon}（${cat.coupons.length}）` : `${t.menu}（${cat.menus.length}）`}</button>)}
    </div>
    <div className="p-4 space-y-3">
      {tab === "coupon" && cat.coupons.map(c => { const ms = couponMenus(c); const one = ms.length === 1 ? ms[0] : null; const conds = couponConditions(c, lang); return (
        <button key={c.id} className={card} onClick={() => chooseCoupon(c)}>
          <div className="flex items-start gap-2 mb-1"><div className="flex flex-wrap gap-1">{badges(c.target, one?.people)}</div>{c.left != null && <span className="ml-auto text-[11px] text-stone-500">{lang === "en" ? `${c.left} left` : `残り${c.left}名`}</span>}</div>
          <div className="font-bold leading-snug">{L(c.name, c.name_en)}</div>
          {L(c.description, c.description_en) && <div className="text-sm text-stone-600 mt-1">{L(c.description, c.description_en)}</div>}
          {conds.length > 0 && <div className="text-[11px] text-stone-500 mt-1">{conds.join(" ／ ")}</div>}
          <div className="flex items-end justify-between mt-2">
            <span className="text-xs text-stone-500">{one ? `${L(one.name, one.name_en)}・${one.duration_min}${t.minutes}` : t.allMenus}</span>
            {one ? priceTag(one, c) : <b className="text-lg text-[#b4472f]">{c.kind === "percent" ? `${c.value}%OFF` : c.kind === "amount" ? `${yenFmt(c.value)} OFF` : yenFmt(c.value)}</b>}
          </div>
        </button>); })}
      {tab === "coupon" && <div className="rounded-2xl border border-dashed border-stone-300 p-3">
        <div className="text-sm font-semibold mb-2">{t.codeQ}</div>
        <div className="flex gap-2"><input className="flex-1 rounded-xl border border-stone-300 px-3 py-3 text-base bg-white" value={code} onChange={e => { setCode(e.target.value); setCodeMsg(""); }} autoCapitalize="characters" aria-label={t.codeQ} /><button className="rounded-xl px-4 font-bold text-white" style={{ background: ACCENT }} onClick={applyCode}>{t.apply}</button></div>
        {codeMsg && <div className="text-xs mt-1 text-stone-600">{codeMsg}</div>}
      </div>}
      {tab === "menu" && cat.menus.map(m => (
        <button key={m.id} className={card} onClick={() => chooseMenu(m, null)}>
          <div className="flex gap-3">
            {m.image_url ? <img src={m.image_url} alt="" className="w-20 h-20 rounded-xl object-cover shrink-0" /> : <span className="w-1.5 rounded-full shrink-0" style={{ background: m.color || ACCENT }} />}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap gap-1 mb-1">{badges(m.target, m.people)}</div>
              <div className="font-bold leading-snug">{L(m.name, m.name_en)}</div>
              {L(m.description, m.description_en) && <div className="text-sm text-stone-600 mt-1">{L(m.description, m.description_en)}</div>}
              <div className="flex items-end justify-between mt-2"><span className="text-xs text-stone-500">{m.duration_min}{t.minutes}</span>{priceTag(m, null)}</div>
            </div>
          </div>
        </button>))}
    </div>
    {pickFor && (
      <div className="fixed inset-0 z-30 bg-black/40 flex items-end justify-center" onClick={() => setPickFor(null)}>
        <div className="bg-[#fbfcfb] w-full max-w-md rounded-t-3xl p-4 max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
          <div className="font-bold mb-1">{t.couponMenu}</div>
          <div className="text-xs text-[#b4472f] mb-3">{L(pickFor.name, pickFor.name_en)}</div>
          <div className="space-y-2">{couponMenus(pickFor).map(m => <button key={m.id} className={card} onClick={() => chooseMenu(m, pickFor)}><div className="flex items-center gap-2"><div className="flex-1 min-w-0"><div className="font-semibold">{L(m.name, m.name_en)}</div><div className="text-xs text-stone-500">{m.duration_min}{t.minutes}</div></div>{priceTag(m, pickFor)}</div></button>)}</div>
          <button className="w-full mt-3 py-3 text-stone-600" onClick={() => setPickFor(null)}>{t.back}</button>
        </div>
      </div>
    )}
  </>);

  // ---- 1.5 オプション（必須は選ぶまで次へ進めない） ----
  if (step === "option") return shell(<>
    {summary}{errBox}
    <h2 className="px-4 pt-4 text-base font-bold">{t.pickOption}</h2>
    <div className="px-4 mt-2 space-y-3">
      {optGroups.map(g => (
        <fieldset key={g.id} className="bg-white rounded-2xl border border-stone-200 p-3" data-testid={`opt-${g.name}`}>
          <legend className="text-sm font-semibold px-1">{L(g.name, g.name_en)} {g.required ? <span className="text-rose-600 text-xs">{t.required}</span> : <span className="text-stone-400 text-xs">{t.optional}</span>}<span className="text-stone-400 text-xs ml-1">{g.multi ? t.pickAny : t.pickOne}</span></legend>
          {g.description && <div className="text-xs text-stone-500 mb-2">{g.description}</div>}
          <div className="space-y-2">
            {g.items.map(i => { const on = optSel.includes(i.id); return (
              <button key={i.id} type="button" role={g.multi ? "checkbox" : "radio"} aria-checked={on} onClick={() => setOptSel(g.multi ? (on ? optSel.filter(x => x !== i.id) : [...optSel, i.id]) : (on ? optSel.filter(x => x !== i.id) : [...optSel.filter(x => !g.items.some(y => y.id === x)), i.id]))}
                className={`w-full flex items-center gap-3 rounded-xl border px-3 py-3 text-left min-h-[52px] ${on ? "border-transparent text-white" : "bg-white border-stone-300"}`} style={on ? { background: ACCENT } : undefined}>
                <span className={`w-5 h-5 shrink-0 border-2 flex items-center justify-center ${g.multi ? "rounded" : "rounded-full"} ${on ? "border-white" : "border-stone-400"}`}>{on && <span className={`w-2.5 h-2.5 bg-white ${g.multi ? "rounded-sm" : "rounded-full"}`} />}</span>
                <span className="flex-1 min-w-0"><span className="block font-semibold">{L(i.name, i.name_en)}</span>{i.description && <span className={`block text-xs ${on ? "text-white/80" : "text-stone-500"}`}>{i.description}</span>}</span>
                <span className={`text-sm whitespace-nowrap ${on ? "text-white" : "text-stone-600"}`}>{i.price ? `+${yenFmt(i.price)}` : yenFmt(0)}{i.minutes ? `・+${i.minutes}${t.minutes}` : ""}</span>
              </button>); })}
          </div>
        </fieldset>
      ))}
    </div>
    {optMissing.length > 0 && <div className="mx-4 mt-3 text-sm text-rose-700" role="status">{t.optionNeed(optMissing.map(g => L(g.name, g.name_en)).join("・"))}</div>}
    <div className="fixed bottom-0 left-0 right-0 z-20"><div className="max-w-md mx-auto bg-[#fbfcfb]/95 backdrop-blur border-t border-stone-200 p-3 flex gap-2">
      <button className="px-4 rounded-2xl border border-stone-300 bg-white text-stone-700" onClick={() => go("menu")}>{t.back}</button>
      <button className="w-full rounded-2xl py-4 text-base font-bold text-white shadow-sm disabled:opacity-40" style={{ background: ACCENT }} disabled={optMissing.length > 0} onClick={() => go("date")} data-testid="option-next">{t.next}</button>
    </div></div>
  </>);

  // ---- 2. 日付・時間 ----
  if (step === "date") {
    const first = new Date(`${firstOf(ym)}T00:00:00`); const startPad = first.getDay();
    const n = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells: (string | null)[] = [...Array(startPad).fill(null), ...Array.from({ length: n }, (_, i) => `${ym}-${pad(i + 1)}`)];
    const canPrev = ym > today.slice(0, 7), canNext = addMonth(ym, 1) <= lastDay.slice(0, 7);
    const mark = (d: string) => { if (d < today || d > lastDay) return null; if (!days) return "…"; const c = days[d]?.length || 0; return c >= 4 ? "◎" : c > 0 ? "△" : "×"; };
    const slots = date && days ? days[date] || [] : [];
    const wd = lang === "ja" ? ["日", "月", "火", "水", "木", "金", "土"] : ["S", "M", "T", "W", "T", "F", "S"];
    return shell(<>
      {summary}{errBox}
      {menu?.nominatable && cat.staff.length > 1 && (
        <div className="px-4 mt-3"><label className="text-sm font-semibold">{t.staff}
          <select className="mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-3 text-base" value={staffId} onChange={e => { setStaffId(e.target.value); setTime(""); }}>
            <option value="">{t.noNom}</option>{cat.staff.map(s => <option key={s.id} value={s.id}>{L(s.name, s.name_en)}{s.fee ? `（${t.nomFee} +${yenFmt(s.fee)}）` : ""}</option>)}
          </select></label></div>
      )}
      <h2 className="px-4 pt-4 text-base font-bold">{t.pickDate}</h2>
      <div className="mx-4 mt-2 bg-white rounded-2xl border border-stone-200 p-3">
        <div className="flex items-center justify-between mb-2">
          <button className="px-3 py-2 rounded-lg text-sm disabled:opacity-30" disabled={!canPrev} onClick={() => setYm(addMonth(ym, -1))}>‹ {t.prevMonth}</button>
          <div className="font-bold">{lang === "ja" ? `${Number(ym.slice(0, 4))}年${Number(ym.slice(5))}月` : new Date(`${firstOf(ym)}T00:00:00`).toLocaleDateString("en-US", { year: "numeric", month: "long" })}</div>
          <button className="px-3 py-2 rounded-lg text-sm disabled:opacity-30" disabled={!canNext} onClick={() => setYm(addMonth(ym, 1))}>{t.nextMonth} ›</button>
        </div>
        <div className="grid grid-cols-7 text-center text-[11px] text-stone-500 mb-1">{wd.map((w, i) => <div key={i} className={i === 0 ? "text-rose-500" : i === 6 ? "text-sky-600" : ""}>{w}</div>)}</div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((d, i) => { if (!d) return <div key={i} />; const mk = mark(d); const ok = mk === "◎" || mk === "△"; const on = d === date; return (
            <button key={d} disabled={!ok} onClick={() => { setDate(d); setTime(""); }} aria-label={`${fmtDate(d, lang)} ${mk || ""}`} aria-pressed={on}
              className={`h-14 rounded-xl flex flex-col items-center justify-center text-sm border ${on ? "text-white border-transparent" : ok ? "bg-white border-stone-200" : "bg-transparent border-transparent text-stone-300"}`} style={on ? { background: ACCENT } : undefined}>
              <span className="leading-none">{Number(d.slice(-2))}</span>
              <span className={`text-[13px] leading-none mt-1 ${on ? "text-white" : mk === "◎" ? "text-emerald-700" : mk === "△" ? "text-amber-600" : "text-stone-300"}`}>{mk || ""}</span>
            </button>); })}
        </div>
        <div className="text-[11px] text-stone-500 mt-2 text-center">{availLoading ? t.loading : t.legend}</div>
      </div>
      {date && <>
        <h2 className="px-4 pt-4 text-base font-bold">{fmtDate(date, lang)}　{t.pickTime}</h2>
        <div className="px-4 mt-2 grid grid-cols-4 gap-2">
          {slots.length === 0 && <div className="col-span-4 text-sm text-stone-500 py-4 text-center">{t.noSlot}</div>}
          {slots.map(s => <button key={s} onClick={() => { setTime(s); go("info"); }} className={`min-h-14 rounded-xl border text-lg font-semibold tabular-nums active:scale-[0.98] transition ${time === s ? "text-white border-transparent" : "bg-white border-line-strong hover:border-canopy"}`} style={time === s ? { background: ACCENT } : undefined}>{s}</button>)}
        </div>
      </>}
      <div className="px-4 mt-6"><button className="w-full py-3 text-stone-600" onClick={() => go(optGroups.length ? "option" : "menu")}>‹ {t.back}</button></div>
    </>);
  }

  const bottom = (label: string, enabled: boolean, onClick: () => void, backTo: Step) => (
    <div className="fixed bottom-0 left-0 right-0 z-20"><div className="max-w-md mx-auto bg-[#fbfcfb]/95 backdrop-blur border-t border-stone-200 p-3 flex gap-2">
      <button className="px-4 rounded-2xl border border-stone-300 bg-white text-stone-700" onClick={() => go(backTo)}>{t.back}</button>
      <button className={bigBtn} style={{ background: ACCENT }} disabled={!enabled || busy} onClick={onClick}>{label}</button>
    </div></div>
  );
  const inputCls = "mt-1 w-full rounded-xl border border-stone-300 bg-white px-3 py-3 text-base focus:outline-none focus:ring-2 focus:ring-emerald-700/30";

  // ---- 3. お客様情報 ----
  if (step === "info") return shell(<>
    {summary}{errBox}
    <h2 className="px-4 pt-4 text-base font-bold">{t.info}</h2>
    <div className="px-4 mt-2 space-y-3">
      {prefilled && <div className="text-sm rounded-lg px-3 py-2 text-white" style={{ background: "#06c755" }} data-testid="liff-prefilled">{lang === "en" ? "We filled in your details from last time. Please check and edit if anything has changed." : "前回のお客様情報を入れました。変わっていなければ、そのまま「次へ」で大丈夫です。"}</div>}
      <label className="block text-sm font-semibold">{t.name} <span className="text-rose-600 text-xs">{t.required}</span><input className={inputCls} autoComplete="name" placeholder={t.namePh} value={info.name} onChange={e => setInfo({ ...info, name: e.target.value })} /></label>
      <label className="block text-sm font-semibold">{t.kana} {lang === "ja" && <span className="text-rose-600 text-xs">{t.required}</span>}<input className={inputCls} placeholder={t.kanaPh} value={info.kana} onChange={e => setInfo({ ...info, kana: e.target.value })} /></label>
      <label className="block text-sm font-semibold">{t.phone} <span className="text-rose-600 text-xs">{t.required}</span><input className={inputCls} type="tel" inputMode="tel" autoComplete="tel" placeholder="090-1234-5678" value={info.phone} onChange={e => setInfo({ ...info, phone: e.target.value })} /><span className="block text-[11px] text-stone-500 font-normal mt-1">{t.phoneNote}</span></label>
      <label className="block text-sm font-semibold">{t.email} <span className="text-rose-600 text-xs">{t.required}</span><input className={inputCls} type="email" inputMode="email" autoComplete="email" placeholder="example@mail.com" value={info.email} onChange={e => setInfo({ ...info, email: e.target.value })} /></label>
    </div>
    {bottom(t.next, !!infoOk, () => go(questions.length ? "intake" : "confirm"), "date")}
  </>);

  // ---- 4. 事前問診 ----
  if (step === "intake") return shell(<>
    {summary}{errBox}
    <h2 className="px-4 pt-4 text-base font-bold">{t.intake}</h2>
    <p className="px-4 text-xs text-stone-500 mt-1">{t.intakeNote}</p>
    <div className="px-4 mt-3 space-y-4">
      {questions.map(q => { const opts = lang === "en" && q.options_en?.length === q.options?.length ? q.options_en! : q.options || []; const v = answers[q.id]; return (
        <fieldset key={q.id} className="bg-white rounded-2xl border border-stone-200 p-3">
          <legend className="text-sm font-semibold px-1">{L(q.label, q.label_en)} {q.required && <span className="text-rose-600 text-xs">{t.required}</span>}</legend>
          {q.type === "text" && <input className={inputCls} value={(v as string) || ""} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} />}
          {q.type === "textarea" && <textarea className={inputCls} rows={3} value={(v as string) || ""} onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })} />}
          {(q.type === "choice" || q.type === "multi") && <div className="flex flex-wrap gap-2 mt-1">
            {opts.map(o => { const on = q.type === "multi" ? ((v as string[]) || []).includes(o) : v === o; return (
              <button key={o} type="button" aria-pressed={on} onClick={() => setAnswers({ ...answers, [q.id]: q.type === "multi" ? (on ? ((v as string[]) || []).filter(x => x !== o) : [...((v as string[]) || []), o]) : o })}
                className={`px-3 py-2.5 rounded-xl border text-sm ${on ? "text-white border-transparent" : "bg-white border-stone-300"}`} style={on ? { background: ACCENT } : undefined}>{o}</button>); })}
          </div>}
        </fieldset>); })}
    </div>
    {bottom(t.next, missingQ.length === 0, () => go("confirm"), "info")}
  </>);

  // ---- 5. 確認 ----
  if (step === "confirm" && menu) {
    const dl = (() => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() - store.cancel_deadline_days); const [h, mi] = store.cancel_deadline_time.split(":").map(Number); d.setHours(h, mi || 0); return d.toISOString(); })();
    const ans = answerList(); const sx = cat.staff.find(s => s.id === staffId); const staffName = sx ? L(sx.name, sx.name_en) : undefined;
    const row = (k: string, v: React.ReactNode) => <div className="flex gap-3 py-2.5 border-b border-stone-100 last:border-0"><div className="w-24 shrink-0 text-xs text-stone-500 pt-0.5">{k}</div><div className="flex-1 text-sm">{v}</div></div>;
    return shell(<>
      {errBox}
      <h2 className="px-4 pt-4 text-base font-bold">{t.confirm}</h2>
      <div className="mx-4 mt-2 bg-white rounded-2xl border border-stone-200 px-4 py-1">
        {row(t.datetime, <b className="text-base">{fmtDate(date, lang)} {time}</b>)}
        {row(t.menu, <>{L(menu.name, menu.name_en)}{optLabel && `＋${optLabel}`}（{totalMin}{t.minutes}）{people > 1 && `・${t.people(people)}`}{coupon && <div className="text-xs text-[#b4472f]">{L(coupon.name, coupon.name_en)}</div>}</>)}
        {staffName && row(t.staff, `${staffName}${t.nominated}${nomFee ? `（${t.nomFee} ${yenFmt(nomFee)}）` : ""}`)}
        {row(t.price, <><b className="text-base">{yenFmt(totalPrice)}</b><span className="text-xs text-stone-500">{t.taxIn}</span>{coupon && base !== menu.price && <s className="text-xs text-stone-400 ml-2">{yenFmt(totalPrice - (base - menu.price) * (menu.price_per === "group" ? 1 : people))}</s>}{people > 1 && menu.price_per === "group" && <div className="text-[11px] text-stone-500">{t.perPair}</div>}{optPrice > 0 && <div className="text-[11px] text-stone-500">{t.option} {yenFmt(optPrice * people)} {t.included}</div>}{nomFee > 0 && <div className="text-[11px] text-stone-500">{t.nomFee} {yenFmt(nomFee)} {t.included}</div>}</>)}
        {row(t.name, <>{info.name}{info.kana && `（${info.kana}）`}<div className="text-xs text-stone-500">{info.phone}／{info.email}</div></>)}
        {ans.length > 0 && row(t.intake, <ul className="text-xs space-y-0.5">{ans.map(a => <li key={a.label}><span className="text-stone-500">{a.label}：</span>{a.answer}</li>)}</ul>)}
      </div>
      <div className="mx-4 mt-3 rounded-2xl bg-stone-100 px-4 py-3 text-xs text-stone-600">
        <div className="font-semibold text-stone-700 mb-1">{t.cancelRule}</div>
        <div>{t.deadline(fmtDateTime(dl, lang))}</div>
        {store.cancel_policy && <div className="mt-1 whitespace-pre-wrap">{store.cancel_policy}</div>}
      </div>
      {bottom(busy ? t.sending : t.submit, true, submit, questions.length ? "intake" : "info")}
    </>);
  }

  // ---- 6. 完了 ----
  if (step === "done" && result) {
    const link = `${origin}/r/${storeSlug}/cancel/${result.cancel_token}`;
    return shell(<>
      <div className="px-4 pt-8 text-center">
        <div className="mx-auto w-16 h-16 rounded-full flex items-center justify-center text-white text-3xl" style={{ background: ACCENT }} aria-hidden>✓</div>
        <h1 className="text-xl font-bold mt-3">{t.done}</h1>
        {lineLinked === "ok" && <div className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-white rounded-full px-3 py-1" style={{ background: "#06c755" }} data-testid="liff-booked">LINEでお知らせをお送りします</div>}
      </div>
      <div className="mx-4 mt-5 bg-white rounded-2xl border border-stone-200 p-4 text-center">
        <div className="text-xs text-stone-500">{t.bookingNo}</div>
        <div className="text-2xl font-bold tracking-wider tabular-nums" data-testid="booking-no">{result.booking_no}</div>
        <div className="mt-3 text-base font-semibold">{fmtDateTime(result.start_at, lang)}</div>
        <div className="text-sm text-stone-600">{L(result.menu_name, result.menu_name_en)}{result.options_label ? `＋${result.options_label}` : ""}{result.people > 1 ? `・${t.people(result.people)}` : ""}</div>
        {result.coupon_name && <div className="text-xs text-[#b4472f]">{result.coupon_name}</div>}
        <div className="mt-1 text-lg font-bold">{yenFmt(result.price_total ?? result.price * result.people)}<span className="text-xs font-normal text-stone-500">{t.taxIn}</span></div>
        {result.staff_name && staffId && <div className="text-xs text-stone-500 mt-1">{t.staff}：{result.staff_name}</div>}
      </div>
      <div className="mx-4 mt-3 bg-white rounded-2xl border border-stone-200 p-4">
        <div className="text-sm font-semibold mb-1">{t.cancelLink}</div>
        <div className="text-xs text-stone-500 mb-2">{t.deadline(fmtDateTime(result.deadline, lang))}</div>
        <div className="flex gap-2"><input readOnly className="flex-1 min-w-0 rounded-xl border border-stone-300 px-3 py-2 text-xs bg-stone-50" value={link} aria-label={t.cancelLink} /><button className="rounded-xl px-3 text-sm font-bold text-white" style={{ background: ACCENT }} onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true))}>{copied ? t.copied : t.copy}</button></div>
        <a className="block text-center text-sm underline mt-2" style={{ color: ACCENT }} href={`/r/${storeSlug}/cancel/${result.cancel_token}`}>{t.cancelTitle}</a>
      </div>
      <p className="mx-4 mt-3 text-xs text-stone-500 text-center">{t.keep}</p>
      <div className="px-4 mt-4"><button className="w-full py-3 rounded-2xl border border-stone-300 bg-white" onClick={() => { setResult(null); setMenu(null); setCoupon(null); setOptSel([]); setDate(""); setTime(""); setAnswers({}); setAvail({}); go("menu"); }}>{t.another}</button></div>
    </>);
  }
  return shell(null);
}
