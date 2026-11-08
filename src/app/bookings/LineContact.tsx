"use client";
// 予約台帳の「LINEで連絡」（予約詳細）と「この日のお客様に連絡」（スタッフの急なお休みなど）。
//  ・人が文面を確かめて、確認の画面で「送る」を押したときだけ送る（自動では何も送らない）
//  ・「LINE連携を使う」がオフでも送れる（秘密が保存済みなら）。送る前の確かめは、サーバがもう一度1人ずつ行う
//  ・LINEとつながっていない・配信停止中のお客様は、電話番号を出す（押すと電話をかけられる）
import { useCallback, useEffect, useMemo, useState } from "react";
import { getRepo, hm, type Booking, type Customer, type LineLink, type LineLinkRequest, type Staff, type Store, type ManualResult } from "@/lib/db";
import { REQUEST_TTL_DAYS, isOwnerCheck } from "@/lib/line/linkPolicy";
import { LINE_STATUS_LABEL, MANUAL_PER_CUSTOMER_PER_HOUR, MANUAL_TEXT_MAX, absenceTemplate, absenceTemplateRaw, directTemplate, fillManualText, lineStatusOf, manualTextError, quotaLeft, type LineStatus } from "@/lib/line/manual";

/** 画面で使う LINE の材料（0015 未適用なら null） */
export interface LineInfo { credentials: boolean; used: number; limit: number; demo: boolean }

/** LINE の材料を読む（設定・今月の通数）。0015 未適用・読めないときは null */
export function useLineInfo() {
  const repo = getRepo();
  const [info, setInfo] = useState<LineInfo | null>(null);
  const reload = useCallback(async () => {
    try {
      const st = await repo.lineSettings();
      if (!st) { setInfo(null); return; }
      const used = await repo.lineMonthUsage();
      setInfo({ credentials: !!st.secret_set_at && !!st.token_set_at, used, limit: st.plan_limit ?? 200, demo: repo.mode === "memory" });
    } catch { setInfo(null); }
  }, [repo]);
  useEffect(() => { void Promise.resolve().then(reload); }, [reload]);
  const onSent = useCallback((used?: number) => { if (used !== undefined) setInfo(i => (i ? { ...i, used } : i)); else void reload(); }, [reload]);
  return { info, reload, onSent };
}

const STATUS_CLS: Record<LineStatus, string> = { linked: "bg-[#e6f8ee] text-[#05612f] border-[#9fdcb8]", none: "bg-stone-100 text-stone-600 border-stone-300", stopped: "bg-amber-50 text-amber-900 border-amber-300" };
const SHORT: Record<LineStatus, string> = { linked: "つながっている", none: "つながっていない", stopped: "配信停止中" };
export function LineStatusChip({ status }: { status: LineStatus }) {
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-xs font-semibold ${STATUS_CLS[status]}`} title={LINE_STATUS_LABEL[status]} data-testid="line-status" data-status={status}><span className="font-bold">LINE</span>{SHORT[status]}</span>;
}
const canContact = (b: Pick<Booking, "status">) => b.status === "booked" || b.status === "arrived";
const telOf = (p?: string | null) => (p || "").replace(/[^\d+]/g, "");

function QuotaLine({ info, n = 1 }: { info: LineInfo; n?: number }) {
  const left = quotaLeft(info.used, info.limit);
  return <div className={`text-xs ${left < n ? "text-danger font-semibold" : "text-ink-soft"}`} data-testid="line-quota">今月あと <b className="tabular-nums">{left}</b>通 送れます（上限 {info.limit}通・今月 {info.used}通）{left < n ? "。足りない分は送れません" : ""}</div>;
}
function NotReady({ info }: { info: LineInfo }) {
  if (info.credentials || info.demo) return null;
  return <div className="text-xs text-ink-soft">LINEの秘密（チャネルシークレット・アクセストークン）が未保存のため、LINEでは送れません（設定＞LINE連携）。お電話で連絡してください。</div>;
}

// ---------------------------------------------------------------------------
// 予約詳細：LINEの状態と「LINEで連絡」
// ---------------------------------------------------------------------------
export function LineContactBox({ booking, customer, info, store, menuText, onSent }: {
  booking: Booking; customer: Customer | null; info: LineInfo; store: Store | null; menuText: string; onSent?: (used?: number) => void;
}) {
  // その場で読み直す（台帳の日付と違う日の予約を開いたときも正しく出す）
  const [link, setLink] = useState<LineLink | null | undefined>(undefined);
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let on = true;
    if (!booking.customer_id) return;
    getRepo().lineLinks([booking.customer_id]).then(ls => { if (on) setLink(ls?.find(l => l.customer_id === booking.customer_id) ?? null); }).catch(() => { if (on) setLink(null); });
    return () => { on = false; };
  }, [booking.customer_id, rev]);
  const status = lineStatusOf(link);
  const [open, setOpen] = useState(false);
  const name = customer?.name || booking.customer_name || "";
  if (link === undefined) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-sm" data-testid="line-contact-box">
      <LineStatusChip status={status} />
      {status === "linked" && canContact(booking) && (info.credentials || info.demo)
        ? <button className="btn !min-h-8 text-xs border-[#06c755] text-[#05612f]" onClick={() => setOpen(true)} data-testid="line-contact-open">LINEで連絡</button>
        : status === "linked" && canContact(booking) ? <NotReady info={info} />
        : status !== "linked" && customer?.phone ? <a className="text-xs underline text-canopy-deep" href={`tel:${telOf(customer.phone)}`}>電話する（{customer.phone}）</a> : null}
      {open && <ContactDialog title={name ? `${name}様にLINEで連絡` : "お客様にLINEで連絡"} info={info}
        items={[{ booking, name, menu: menuText }]} initial={fillManualText(absenceTemplateRaw(store?.name || "", store?.phone), { customerName: name, startAt: booking.start_at, menu: menuText })}
        single onClose={() => setOpen(false)} onSent={onSent} />}
      {booking.customer_id && <LinkRequestBox customerId={booking.customer_id} currentLink={link} onChanged={() => setRev(r => r + 1)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 文面の入力 → 確認 → 送る（1人でも、まとめてでも）
// ---------------------------------------------------------------------------
type Target = { booking: Booking; name: string; menu: string };
function ContactDialog({ title, info, items, initial, single, onClose, onSent }: {
  title: string; info: LineInfo; items: Target[]; initial: string; single?: boolean; onClose: () => void; onSent?: (used?: number) => void;
}) {
  const repo = getRepo();
  const [text, setText] = useState(initial);
  const [step, setStep] = useState<"edit" | "confirm" | "done">("edit");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [results, setResults] = useState<ManualResult[] | null>(null);
  const [summary, setSummary] = useState("");
  const filled = useMemo(() => items.map(t => ({ ...t, text: single ? text.trim() : fillManualText(text, { customerName: t.name, startAt: t.booking.start_at, menu: t.menu }).trim() })), [items, text, single]);
  const textErr = filled.map(f => manualTextError(f.text)).find(Boolean) || null;
  const left = quotaLeft(info.used, info.limit);
  const longest = Math.max(0, ...filled.map(f => f.text.length));
  async function send() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const r = await repo.lineContact(filled.map(f => ({ booking_id: f.booking.id, text: f.text })));
      setResults(r.results); setSummary(r.message); setStep("done");
      onSent?.(r.used);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  const nameOf = (id: string) => items.find(t => t.booking.id === id)?.name || "お客様";
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-3" onClick={e => { e.stopPropagation(); if (!busy) onClose(); }}>
      <div role="dialog" aria-label={title} className="bg-white w-full sm:max-w-lg rounded-t-xl sm:rounded-xl p-4 max-h-[92vh] overflow-auto shadow-2xl border-t-4 border-[#06c755]" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2"><div className="font-bold">{title}</div><button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
        {info.demo && <div className="text-xs mb-2 px-2 py-1 rounded bg-sky-50 border border-sky-200 text-sky-900">デモなので、LINEには届きません（受信箱に記録だけ残ります）。</div>}
        {err && <div className="text-sm text-danger mb-2" role="alert">{err}</div>}
        {step === "edit" && <>
          <label className="lbl" htmlFor="line-contact-text">送る文面（直せます）</label>
          <textarea id="line-contact-text" className="inp w-full min-h-[16rem] text-sm leading-relaxed" value={text} onChange={e => setText(e.target.value)} data-testid="line-contact-text" />
          <div className="flex flex-wrap justify-between gap-2 text-xs mt-1">
            <span className={longest > MANUAL_TEXT_MAX ? "text-danger font-semibold" : "text-ink-soft"}>{longest} / {MANUAL_TEXT_MAX}文字</span>
            {!single && <span className="text-ink-soft">{"{お名前}・{日時}・{メニュー}"} は、お一人ずつ入れ替えて送ります</span>}
          </div>
          <QuotaLine info={info} n={items.length} />
          {textErr && <div className="text-xs text-danger mt-1">{textErr}</div>}
          <div className="flex justify-end gap-2 mt-3">
            <button className="btn" onClick={onClose}>やめる</button>
            <button className="btn-primary" disabled={!!textErr || left < 1 || !items.length} onClick={() => setStep("confirm")} data-testid="line-contact-next">確認へ</button>
          </div>
        </>}
        {step === "confirm" && <>
          <div className="rounded-lg border-2 border-amber-400 bg-amber-50 px-3 py-2 mb-2 font-bold text-amber-950" role="alert" data-testid="line-contact-confirm">
            {single ? `この内容で${items[0].name || "お客"}様に送ります。よろしいですか？` : `この内容で${items.length}人のお客様に、お一人ずつ送ります。よろしいですか？`}
          </div>
          {single
            ? <pre className="text-sm whitespace-pre-wrap font-sans bg-paper border border-line rounded p-2 max-h-72 overflow-auto">{filled[0]?.text}</pre>
            : <div className="space-y-1 max-h-72 overflow-auto">{filled.map(f => (
                <details key={f.booking.id} className="border border-line rounded p-2 text-sm"><summary className="cursor-pointer"><b>{f.name || "お客"}様</b>　{hm(f.booking.start_at)}〜</summary><pre className="whitespace-pre-wrap font-sans text-xs mt-1">{f.text}</pre></details>
              ))}</div>}
          <QuotaLine info={info} n={items.length} />
          <div className="flex justify-end gap-2 mt-3">
            <button className="btn" disabled={busy} onClick={() => setStep("edit")}>戻って直す</button>
            <button className="btn-primary !bg-[#06c755] hover:!bg-[#05a648]" disabled={busy} aria-busy={busy} onClick={send} data-testid="line-contact-send">{busy ? "送っています…" : "送る"}</button>
          </div>
        </>}
        {step === "done" && results && <>
          <div className="font-semibold mb-2" role="status">{summary}</div>
          <ul className="space-y-1 text-sm" data-testid="line-contact-results">
            {results.map(r => <li key={r.booking_id} className={`px-2 py-1 rounded border ${r.ok ? "border-[#9fdcb8] bg-[#e6f8ee]" : "border-rose-200 bg-rose-50"}`}><b>{nameOf(r.booking_id)}様</b>：{r.ok ? "✓ " : "× "}{r.message}</li>)}
          </ul>
          <div className="text-xs text-ink-soft mt-2">お客様からのお返事は、LINE Official Account Manager（LINE公式アカウントのアプリ）のチャットに届きます。送った内容は「LINE受信箱」の「送ったものも」で見返せます。</div>
          <div className="flex justify-end mt-3"><button className="btn-primary" onClick={onClose}>閉じる</button></div>
        </>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 日表示：この日のお客様に連絡（スタッフの急なお休みなど）
// ---------------------------------------------------------------------------
export function DayContactDialog({ date, bookings, staff, customers, links, info, store, menuText, onClose, onSent }: {
  date: string; bookings: Booking[]; staff: Staff[]; customers: Customer[]; links: Map<string, LineLink> | null; info: LineInfo | null; store: Store | null;
  menuText: (b: Booking) => string; onClose: () => void; onSent?: (used?: number) => void;
}) {
  // 連絡する予約：キャンセル・ブロック・会計済みは除く。ペアは「お客様のいる行」だけ
  const rows = useMemo(() => bookings.filter(b => canContact(b) && b.customer_id).sort((a, b) => a.start_at.localeCompare(b.start_at)), [bookings]);
  const staffIds = [...new Set(rows.map(b => b.staff_id).filter(Boolean) as string[])];
  const pairStaff = (b: Booking) => bookings.filter(x => !!b.pair_group && x.pair_group === b.pair_group).map(x => x.staff_id).filter(Boolean) as string[];
  const [who, setWho] = useState<string>("all");
  const shown = rows.filter(b => who === "all" || b.staff_id === who || pairStaff(b).includes(who));
  const cust = (b: Booking) => customers.find(c => c.id === b.customer_id) || null;
  const nameOf = (b: Booking) => cust(b)?.name || b.customer_name || "（名前なし）";
  const statusOf = (b: Booking): LineStatus => (links ? lineStatusOf(b.customer_id ? links.get(b.customer_id) : null) : "none");
  const canLine = !!info && (info.credentials || info.demo);
  const linked = shown.filter(b => statusOf(b) === "linked");
  const others = shown.filter(b => statusOf(b) !== "linked");
  const [off, setOff] = useState<Set<string>>(new Set());
  const picked = linked.filter(b => !off.has(b.id));
  const [compose, setCompose] = useState(false);
  const staffName = (id?: string | null) => staff.find(s => s.id === id)?.name || "";
  const d = new Date(`${date}T00:00:00`);
  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div role="dialog" aria-label="この日のお客様に連絡" className="bg-white w-full sm:max-w-2xl rounded-t-xl sm:rounded-xl p-4 max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()} data-testid="day-contact">
        <div className="flex items-center justify-between mb-1"><div className="font-bold">この日のお客様に連絡（{d.getMonth() + 1}月{d.getDate()}日）</div><button className="btn" onClick={onClose}>閉じる</button></div>
        <div className="text-xs text-ink-soft mb-2">スタッフの急なお休みなどで、お客様に連絡するときに使います。LINEとつながっているお客様にはまとめてLINEで、つながっていないお客様にはお電話で。</div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <label className="lbl !mb-0" htmlFor="day-contact-staff">担当</label>
          <select id="day-contact-staff" className="inp" value={who} onChange={e => { setWho(e.target.value); setOff(new Set()); }} data-testid="day-contact-staff">
            <option value="all">全員</option>
            {staffIds.map(id => <option key={id} value={id}>{staffName(id) || "（担当）"}</option>)}
          </select>
          <span className="text-sm text-ink-soft">予約 {shown.length}件（キャンセル済みは出しません）</span>
        </div>
        {!info && <div className="text-xs text-ink-soft mb-2">LINE連携は準備中です（DB更新 0015 の後に使えます）。お電話で連絡してください。</div>}
        {info && <NotReady info={info} />}

        <div className="font-semibold text-sm mt-2 mb-1">LINEで連絡できるお客様（{linked.length}人）</div>
        {linked.length === 0 ? <div className="text-xs text-ink-soft mb-2">いません。</div> : (
          <ul className="divide-y divide-line border border-line rounded mb-2">
            {linked.map(b => (
              <li key={b.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                <input type="checkbox" className="w-5 h-5" checked={!off.has(b.id)} disabled={!canLine} aria-label={`${nameOf(b)}様に送る`} onChange={e => setOff(prev => { const n = new Set(prev); if (e.target.checked) n.delete(b.id); else n.add(b.id); return n; })} />
                <span className="tabular-nums w-12">{hm(b.start_at)}</span>
                <span className="font-semibold">{nameOf(b)}様</span>
                <span className="text-xs text-ink-soft truncate flex-1">{menuText(b)}{staffName(b.staff_id) ? `／${staffName(b.staff_id)}` : ""}</span>
                <LineStatusChip status="linked" />
              </li>
            ))}
          </ul>
        )}
        {linked.length > 0 && info && canLine && <div className="flex flex-wrap items-center gap-2 mb-3">
          <button className="btn-primary !bg-[#06c755] hover:!bg-[#05a648]" disabled={!picked.length} onClick={() => setCompose(true)} data-testid="day-contact-compose">選んだ {picked.length}人にLINEで連絡</button>
          <QuotaLine info={info} n={picked.length} />
        </div>}

        <div className="font-semibold text-sm mt-2 mb-1">お電話で連絡するお客様（{others.length}人）</div>
        {others.length === 0 ? <div className="text-xs text-ink-soft">いません。</div> : (
          <ul className="divide-y divide-line border border-line rounded">
            {others.map(b => { const c = cust(b); return (
              <li key={b.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-sm">
                <span className="tabular-nums w-12">{hm(b.start_at)}</span>
                <span className="font-semibold">{nameOf(b)}様</span>
                <span className="text-xs text-ink-soft truncate flex-1">{menuText(b)}{staffName(b.staff_id) ? `／${staffName(b.staff_id)}` : ""}</span>
                <LineStatusChip status={statusOf(b)} />
                {c?.phone ? <a className="btn !min-h-8 text-xs" href={`tel:${telOf(c.phone)}`} data-testid="day-contact-tel">電話 {c.phone}</a> : <span className="text-xs text-danger">電話番号なし</span>}
              </li>); })}
          </ul>
        )}
        {compose && info && <ContactDialog title={`${picked.length}人のお客様にLINEで連絡`} info={info}
          items={picked.map(b => ({ booking: b, name: cust(b)?.name || b.customer_name || "", menu: menuText(b) }))}
          initial={absenceTemplateRaw(store?.name || "", store?.phone)}
          onClose={() => setCompose(false)} onSent={onSent} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 顧客詳細：LINEの状態と「LINEで連絡」（予約に結びつけない1人あて）
// ---------------------------------------------------------------------------
export function CustomerLineContact({ customer, link, info, store, nextBooking, nextMenu, onSent, onLinkChanged }: {
  customer: Customer; link: LineLink | null | undefined; info: LineInfo | null; store: Store | null;
  nextBooking: Booking | null; nextMenu: string; onSent?: (used?: number) => void; onLinkChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (link === undefined) return null;
  const status = lineStatusOf(link);
  const canLine = status === "linked" && !!info && (info.credentials || info.demo);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="customer-line-contact">
      <LineStatusChip status={status} />
      {canLine && <button className="btn !min-h-9 text-xs border-[#06c755] text-[#05612f] max-sm:!min-h-11" onClick={() => setOpen(true)} data-testid="customer-line-open">LINEで連絡</button>}
      {status === "linked" && info && !canLine && <NotReady info={info} />}
      {status === "linked" && !info && <span className="text-xs text-ink-soft">LINE連携は準備中です（DB更新 0015 の後に使えます）。</span>}
      {status !== "linked" && customer.phone && <a className="btn !min-h-9 text-xs max-sm:!min-h-11" href={`tel:${telOf(customer.phone)}`} data-testid="customer-tel-line">電話する（{customer.phone}）</a>}
      {status === "none" && <div className="basis-full text-xs text-ink-soft" data-testid="customer-line-howto">
        LINEとはまだつながっていません。下の「LINEでお知らせ（QR）」をお客様のスマホで読んでいただく（会計のときにも出せます）と、つながります。LINEの中からのご予約は LINE のアカウントごとに別のお客様として登録されるので、同じ電話番号のお客様がいれば「統合する」で1人にまとめてください。
      </div>}
      {status === "stopped" && <div className="basis-full text-xs text-ink-soft">{link?.needs_confirm ? "LINEの持ち主の確認待ちのため、LINEでは送っていません（下の確認をしてください）。" : "配信停止中（お知らせ停止・ブロック）のため、LINEでは送れません。"}お電話で連絡してください。</div>}
      {open && info && <CustomerContactDialog customer={customer} info={info} store={store} nextBooking={nextBooking} nextMenu={nextMenu} onClose={() => setOpen(false)} onSent={onSent} />}
      <LinkRequestBox customerId={customer.id} currentLink={link} onChanged={onLinkChanged} />
    </div>
  );
}

function CustomerContactDialog({ customer, info, store, nextBooking, nextMenu, onClose, onSent }: {
  customer: Customer; info: LineInfo; store: Store | null; nextBooking: Booking | null; nextMenu: string; onClose: () => void; onSent?: (used?: number) => void;
}) {
  const repo = getRepo();
  const name = customer.name || "";
  const storeName = store?.name || "";
  const [text, setText] = useState(() => directTemplate({ customerName: name, storeName, phone: store?.phone }));
  const [step, setStep] = useState<"edit" | "confirm" | "done">("edit");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const t = text.trim();
  const textErr = manualTextError(t);
  const left = quotaLeft(info.used, info.limit);
  async function send() {
    if (busy) return;
    setBusy(true); setErr("");
    try {
      const r = await repo.lineContactCustomer(customer.id, t);
      setResult({ ok: r.ok, message: r.message }); setStep("done");
      onSent?.(r.used);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  const title = name ? `${name}様にLINEで連絡` : "お客様にLINEで連絡";
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center p-0 sm:p-3" onClick={() => { if (!busy) onClose(); }}>
      <div role="dialog" aria-label={title} className="bg-white w-full sm:max-w-lg rounded-t-xl sm:rounded-xl p-4 max-h-[92vh] overflow-auto shadow-2xl border-t-4 border-[#06c755]" onClick={e => e.stopPropagation()} data-testid="customer-line-dialog">
        <div className="flex items-center justify-between mb-2"><div className="font-bold">{title}</div><button className="btn" disabled={busy} onClick={onClose}>閉じる</button></div>
        {info.demo && <div className="text-xs mb-2 px-2 py-1 rounded bg-sky-50 border border-sky-200 text-sky-900">デモなので、LINEには届きません（受信箱に記録だけ残ります）。</div>}
        {err && <div className="text-sm text-danger mb-2" role="alert">{err}</div>}
        {step === "edit" && <>
          {nextBooking && <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
            <span className="text-ink-soft">次のご予約：{fillManualText("{日時}", { startAt: nextBooking.start_at })}{nextMenu ? `「${nextMenu}」` : ""}</span>
            <button type="button" className="btn !min-h-8 text-xs max-sm:!min-h-11" data-testid="customer-line-absence"
              onClick={() => setText(absenceTemplate({ storeName, customerName: name, startAt: nextBooking.start_at, menu: nextMenu, phone: store?.phone }))}>急なお休みの文面を入れる</button>
          </div>}
          <label className="lbl" htmlFor="customer-line-text">送る文面（直せます）</label>
          <textarea id="customer-line-text" className="inp w-full min-h-[14rem] text-sm leading-relaxed" value={text} onChange={e => setText(e.target.value)} data-testid="customer-line-text" />
          <div className="flex flex-wrap justify-between gap-2 text-xs mt-1">
            <span className={t.length > MANUAL_TEXT_MAX ? "text-danger font-semibold" : "text-ink-soft"}>{t.length} / {MANUAL_TEXT_MAX}文字</span>
            <span className="text-ink-soft">同じお客様へは1時間に{MANUAL_PER_CUSTOMER_PER_HOUR}通まで</span>
          </div>
          <QuotaLine info={info} />
          {textErr && <div className="text-xs text-danger mt-1">{textErr}</div>}
          <div className="flex justify-end gap-2 mt-3">
            <button className="btn" onClick={onClose}>やめる</button>
            <button className="btn-primary" disabled={!!textErr || left < 1} onClick={() => setStep("confirm")} data-testid="customer-line-next">確認へ</button>
          </div>
        </>}
        {step === "confirm" && <>
          <div className="rounded-lg border-2 border-amber-400 bg-amber-50 px-3 py-2 mb-2 font-bold text-amber-950" role="alert" data-testid="customer-line-confirm">
            この内容で{name || "お客"}様に送ります。よろしいですか？
          </div>
          <pre className="text-sm whitespace-pre-wrap font-sans bg-paper border border-line rounded p-2 max-h-72 overflow-auto">{t}</pre>
          <QuotaLine info={info} />
          <div className="flex justify-end gap-2 mt-3">
            <button className="btn" disabled={busy} onClick={() => setStep("edit")}>戻って直す</button>
            <button className="btn-primary !bg-[#06c755] hover:!bg-[#05a648]" disabled={busy} aria-busy={busy} onClick={send} data-testid="customer-line-send">{busy ? "送っています…" : "送る"}</button>
          </div>
        </>}
        {step === "done" && result && <>
          <div className={`px-2 py-1 rounded border text-sm font-semibold ${result.ok ? "border-[#9fdcb8] bg-[#e6f8ee]" : "border-rose-200 bg-rose-50"}`} role="status" data-testid="customer-line-result">{result.ok ? "✓ " : "× "}{result.message}</div>
          <div className="text-xs text-ink-soft mt-2">お客様からのお返事は、LINE Official Account Manager（LINE公式アカウントのアプリ）のチャットに届きます。送った内容は「LINE受信箱」の「送ったものも」で見返せます。</div>
          <div className="flex justify-end gap-2 mt-3">
            {!result.ok && <button className="btn" onClick={() => setStep("edit")}>文面に戻る</button>}
            <button className="btn-primary" onClick={onClose}>閉じる</button>
          </div>
        </>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LINE連携の確認待ち（0020）。0022（案B）以降、LINE予約からは確認待ちを作らない（LINEのユーザーIDが本人＝予約と一緒につながる）。
// 0022 より前に作られて残っているものの決着のためだけに残している（通常は何も出ない）。
// ---------------------------------------------------------------------------
export function LinkRequestBox({ customerId, currentLink, onChanged }: { customerId: string; currentLink: LineLink | null | undefined; onChanged?: () => void }) {
  const repo = getRepo();
  const [reqs, setReqs] = useState<LineLinkRequest[]>([]);
  const [ask, setAsk] = useState<{ req: LineLinkRequest; decision: "approve" | "reject" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    try { setReqs((await repo.lineLinkRequests([customerId])) ?? []); } catch { setReqs([]); }
  }, [repo, customerId]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  if (!reqs.length && !msg) return null;
  const takesOver = (r: LineLinkRequest) => !!currentLink?.customer_id && currentLink.line_user_id !== r.line_user_id;
  const decide = async () => {
    if (!ask) return;
    setBusy(true);
    try {
      const r = await repo.decideLineLinkRequest(ask.req.id, ask.decision);
      setMsg({ ok: r.ok, text: r.message });
      setAsk(null);
      await load();
      onChanged?.();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); setAsk(null); await load(); }
    finally { setBusy(false); }
  };
  const dateOf = (iso: string) => { const d = new Date(iso); return `${d.getMonth() + 1}/${d.getDate()} ${hm(iso)}`; };
  return (
    <div className="basis-full space-y-2" data-testid="line-link-requests">
      {reqs.map(r => (
        <div key={r.id} className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="line-link-request">
          <div className="font-semibold">{isOwnerCheck(r, currentLink) ? "LINEの持ち主の確認" : "LINE連携の確認待ち"}：LINE名『{r.display_name || "（名前なし）"}』</div>
          <div className="text-xs mt-0.5">{isOwnerCheck(r, currentLink)
            ? `今つながっているこのLINEは、LINEからのネット予約で新しく登録されたときのものです。${dateOf(r.created_at)} に別の予約がこのお客様に入ったため、ご本人のLINEか確かめるまで、前日確認などのお知らせを止めています。`
            : `${dateOf(r.created_at)} にLINEの中のネット予約で、このお客様の電話番号が使われました。ご本人のLINEか、ご来店時に確かめてからつないでください。`}（{REQUEST_TTL_DAYS}日で期限切れ）</div>
          {ask?.req.id === r.id ? (
            <div className="mt-2 rounded border border-amber-400 bg-white p-2" role="alertdialog" aria-label="LINE連携の確認">
              {ask.decision === "approve" ? <>
                <div className="text-sm">{isOwnerCheck(r, currentLink) ? `LINE名『${r.display_name || "（名前なし）"}』をこのお客様ご本人のLINEとして、お知らせを再開します。` : `LINE名『${r.display_name || "（名前なし）"}』を、このお客様につなぎます。`}</div>
                {takesOver(r) && <div className="mt-1 text-sm font-bold text-danger" data-testid="line-link-takeover">今つながっているLINE{currentLink?.display_name ? `（『${currentLink.display_name}』）` : ""}は外れます。前のLINEには「送り先が変更されました」と1通届きます（友だちのままのとき・今月の通数に数えます）。</div>}
              </> : <div className="text-sm">{isOwnerCheck(r, currentLink) ? "このLINEをお客様から外します。以後このLINEには何も届きません。" : "つながないことにします。お客様のLINEには何も届きません。"}</div>}
              <div className="mt-2 flex gap-2">
                <button className={`btn text-xs ${ask.decision === "approve" ? "border-[#06c755] text-[#05612f]" : ""}`} disabled={busy} onClick={decide} data-testid="line-link-confirm">{busy ? "…" : ask.decision === "approve" ? (isOwnerCheck(r, currentLink) ? "合っている" : "つなぐ") : isOwnerCheck(r, currentLink) ? "外す" : "つながない"}</button>
                <button className="btn text-xs" disabled={busy} onClick={() => setAsk(null)}>やめる</button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="btn !min-h-8 text-xs border-[#06c755] text-[#05612f] max-sm:!min-h-11" onClick={() => { setMsg(null); setAsk({ req: r, decision: "approve" }); }} data-testid="line-link-approve">{isOwnerCheck(r, currentLink) ? "この方のLINEで合っている" : "この方のLINEとつなぐ"}</button>
              <button className="btn !min-h-8 text-xs max-sm:!min-h-11" onClick={() => { setMsg(null); setAsk({ req: r, decision: "reject" }); }} data-testid="line-link-reject">{isOwnerCheck(r, currentLink) ? "このLINEを外す" : "つながない"}</button>
            </div>
          )}
        </div>
      ))}
      {msg && <div className={`text-xs px-2 py-1 rounded border ${msg.ok ? "bg-moss border-line text-canopy-deep" : "bg-amber-50 border-amber-300 text-amber-900"}`} role="status">{msg.text}</div>}
    </div>
  );
}
