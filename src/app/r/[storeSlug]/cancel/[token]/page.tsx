"use client";
// お客様のキャンセル（予約完了画面のリンクから）。期限を過ぎたらキャンセル不可＋店舗の電話を表示。
import { use, useEffect, useState } from "react";
import { getPublicApi, errorText, type PublicBookingView } from "@/lib/web";
import { T, fmtDateTime, yenFmt, initialLang, LANG_KEY, type Lang } from "../../../i18n";

const ACCENT = "#2d5d49";

export default function CancelPage({ params }: { params: Promise<{ storeSlug: string; token: string }> }) {
  const { storeSlug, token } = use(params);
  const api = getPublicApi();
  const [lang, setLangState] = useState<Lang>("ja"); const t = T[lang];
  const [b, setB] = useState<PublicBookingView | null | undefined>(undefined);
  const [err, setErr] = useState(""); const [done, setDone] = useState(false); const [ask, setAsk] = useState(false); const [busy, setBusy] = useState(false);
  const setLang = (l: Lang) => { setLangState(l); try { localStorage.setItem(LANG_KEY, l); } catch {} };
  useEffect(() => { void Promise.resolve().then(() => setLangState(initialLang())); }, []);
  useEffect(() => { api.bookingByToken(token).then(setB).catch(e => { setB(null); setErr(errorText(e, "ja")); }); }, [api, token]);

  async function cancel() {
    setBusy(true); setErr("");
    try { await api.cancelBooking(token); setDone(true); setAsk(false); setB(await api.bookingByToken(token)); }
    catch (e) { setErr(errorText(e, lang)); setAsk(false); setB(await api.bookingByToken(token).catch(() => b)); }
    finally { setBusy(false); }
  }
  const phone = b?.store_phone;
  return (
    <div className="min-h-screen bg-paper text-stone-800">
      <div className="max-w-md mx-auto min-h-screen bg-[#fbfcfb] pb-10">
        <header className="flex items-center gap-2 px-4 h-14 border-b border-stone-200">
          <div className="flex-1 font-bold truncate">{b?.store_name || ""}</div>
          <div className="flex rounded-full border border-stone-300 overflow-hidden text-xs">{(["ja", "en"] as Lang[]).map(l => <button key={l} onClick={() => setLang(l)} aria-pressed={lang === l} className={`px-3 py-1.5 ${lang === l ? "text-white" : "text-stone-600"}`} style={lang === l ? { background: ACCENT } : undefined}>{l === "ja" ? "日本語" : "EN"}</button>)}</div>
        </header>
        <h1 className="px-4 pt-5 text-lg font-bold">{t.cancelTitle}</h1>
        {b === undefined && <div className="p-8 text-center text-stone-500">{t.loading}</div>}
        {b === null && <div className="m-4 rounded-xl bg-rose-50 border border-rose-200 p-3 text-sm">{err || errorText(new Error("not_found"), lang)}</div>}
        {b && <>
          <div className="mx-4 mt-3 bg-white rounded-2xl border border-stone-200 p-4 space-y-1">
            <div className="text-xs text-stone-500">{t.bookingNo}</div><div className="text-xl font-bold tracking-wider">{b.booking_no}</div>
            <div className="text-base font-semibold pt-2">{fmtDateTime(b.start_at, lang)}</div>
            <div className="text-sm text-stone-600">{lang === "en" && b.menu_name_en ? b.menu_name_en : b.menu_name}{b.price != null && `・${yenFmt(b.price)}`}</div>
            {b.customer_name && <div className="text-sm text-stone-600">{b.customer_name} {lang === "ja" ? "様" : ""}</div>}
            <div className="text-xs pt-1">{t.status}：<b>{b.status === "cancelled" ? t.alreadyCancelled : b.status === "done" ? t.statusDone : t.statusBooked}</b></div>
          </div>
          {err && <div role="alert" className="mx-4 mt-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm px-3 py-2">{err}</div>}
          {done && <div className="mx-4 mt-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-3 py-2">{t.cancelled}</div>}
          {b.status === "booked" && b.cancellable && !done && <div className="px-4 mt-4">
            <div className="text-xs text-stone-500 mb-2">{t.deadline(fmtDateTime(b.deadline, lang))}</div>
            <button className="w-full rounded-2xl py-4 text-base font-bold text-white bg-[#a8432f]" onClick={() => setAsk(true)}>{t.doCancel}</button>
          </div>}
          {b.status === "booked" && !b.cancellable && <div className="mx-4 mt-4 rounded-2xl bg-amber-50 border border-amber-200 p-4 text-sm">
            <div>{t.pastDeadline}</div>
            {phone && <a href={`tel:${phone.replace(/[^0-9+]/g, "")}`} className="mt-3 block text-center rounded-2xl py-3 font-bold text-white" style={{ background: ACCENT }}>{t.call} {phone}</a>}
          </div>}
          <a href={`/r/${b.slug || storeSlug}`} className="block text-center text-sm underline mt-6" style={{ color: ACCENT }}>{t.backToTop}</a>
        </>}
        {ask && <div className="fixed inset-0 z-30 bg-black/40 flex items-end justify-center" onClick={() => setAsk(false)}>
          <div role="alertdialog" className="bg-[#fbfcfb] w-full max-w-md rounded-t-3xl p-5" onClick={e => e.stopPropagation()}>
            <div className="font-bold mb-4">{t.cancelConfirm}</div>
            <div className="flex gap-2"><button className="flex-1 py-3 rounded-2xl border border-stone-300 bg-white" onClick={() => setAsk(false)}>{t.back}</button><button disabled={busy} className="flex-1 py-3 rounded-2xl font-bold text-white bg-[#a8432f] disabled:opacity-50" onClick={cancel}>{t.doCancel}</button></div>
          </div>
        </div>}
      </div>
    </div>
  );
}
