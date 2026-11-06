"use client";
// 予約台帳の部品：右クリック（iPad は長押し）メニュー・予約日の変更・キャンセルの確認・予約トラッキング・予約詳細の上の段（カミングスーン風）
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { getRepo, hm, CHANNEL_LABEL, type Booking, type BookingHistoryEntry, type Coupon, type Customer, type Lane, type Menu, type Staff, type Store } from "@/lib/db";
import { bookingMenuLabel } from "@/lib/web";
import { trackingRows, type TrackField } from "@/lib/tracking";

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dateJa = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${WD[d.getDay()]}）`; };

// ---------- 右クリック／長押しのメニュー ----------
const Icon = ({ d }: { d: string }) => <svg aria-hidden viewBox="0 0 24 24" className="w-5 h-5 shrink-0 text-ink-soft" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
const ICONS = {
  move: "M4 7h16M4 7v12a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V7M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2M8 2v4M16 2v4M8 12h2M12 12h2M16 12h0M8 16h2M12 16h2",
  detail: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  cancel: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  track: "M12 7v5l3 2M21 12a9 9 0 1 1-3-6.7M21 4v4h-4",
};
export function BookingContextMenu({ x, y, booking, onClose, onMove, onDetail, onCancel, onTrack }: {
  x: number; y: number; booking: Booking; onClose: () => void; onMove: () => void; onDetail: () => void; onCancel: () => void; onTrack: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const editable = booking.status === "booked" || booking.status === "arrived";
  const items = [
    { key: "move", label: "予約日の変更", icon: ICONS.move, on: onMove, disabled: !editable },
    { key: "detail", label: "予約詳細", icon: ICONS.detail, on: onDetail, disabled: false },
    { key: "cancel", label: "予約のキャンセル", icon: ICONS.cancel, on: onCancel, disabled: !editable },
    { key: "track", label: "予約トラッキング", icon: ICONS.track, on: onTrack, disabled: false },
  ];
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const bs = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") || [])];
      const i = bs.indexOf(document.activeElement as HTMLButtonElement);
      bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length]?.focus();
    };
    const sc = () => onClose();
    window.addEventListener("keydown", k); window.addEventListener("resize", sc);
    return () => { window.removeEventListener("keydown", k); window.removeEventListener("resize", sc); };
  }, [onClose]);
  const W = 248, H = items.length * 52 + 12;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1200, vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(x, vw - W - 8)), top = Math.max(8, Math.min(y, vh - H - 8));
  return (
    <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={e => { e.preventDefault(); onClose(); }} data-testid="ctx-overlay">
      <div ref={ref} role="menu" aria-label="予約の操作" data-testid="booking-ctx-menu" className="absolute bg-white rounded-[var(--radius-sheet)] border border-line shadow-xl py-1.5" style={{ left, top, width: W }} onClick={e => e.stopPropagation()}>
        {items.map((it, i) => (
          <button key={it.key} role="menuitem" disabled={it.disabled} onClick={it.on}
            className={`w-full flex items-center gap-3 px-4 min-h-12 text-left text-[15px] text-ink hover:bg-moss focus:bg-moss focus:outline-none disabled:opacity-35 ${i < items.length - 1 ? "border-b border-line" : ""}`}>
            <Icon d={it.icon} /><span>{it.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------- 予約日の変更 ----------
export function MoveDialog({ booking, partners, staff, allStaff, store, customerName, onClose, onDone }: {
  booking: Booking; partners: Booking[]; staff: Staff[]; allStaff: Staff[]; store: Store | null; customerName: string; onClose: () => void; onDone: (date: string) => void;
}) {
  const repo = getRepo();
  const [d, setD] = useState(ymd(new Date(booking.start_at)));
  const [t, setT] = useState(hm(booking.start_at));
  const [sid, setSid] = useState(booking.staff_id || "");
  const [warn, setWarn] = useState(""); const [err, setErr] = useState(""); const [busy, setBusy] = useState(false);
  const dur = new Date(booking.end_at).getTime() - new Date(booking.start_at).getTime();
  const step = Math.max(5, store?.start_step_min ?? 30);
  const mins = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const times: string[] = []; { const o = store ? mins(store.open_time.slice(0, 5)) : 600, c = store ? mins(store.close_time.slice(0, 5)) : 1140; for (let m = o; m < c; m += Math.min(step, 15)) times.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`); }
  if (!times.includes(t)) times.unshift(t);
  async function save(force = false) {
    setErr(""); setBusy(true);
    try {
      const start = new Date(`${d}T${t}:00`); const end = new Date(start.getTime() + dur);
      if (!force) {
        const own = new Set([booking.id, ...partners.map(p => p.id)]);
        const day = await repo.bookingsOn(d);
        const hit = day.find(x => !own.has(x.id) && x.staff_id && x.staff_id === sid && x.status !== "cancelled" && x.status !== "noshow" && !(x.status === "block" && x.block_kind === "idle")
          && new Date(x.start_at).getTime() < end.getTime() && new Date(x.end_at).getTime() > start.getTime());
        if (hit) { setWarn(`${allStaff.find(s => s.id === sid)?.name || "担当"}さんは ${hm(hit.start_at)}〜${hm(hit.end_at)} にほかの予定（${hit.status === "block" ? "ブロック" : "予約"}）があります。`); setBusy(false); return; }
      }
      await repo.updateBooking(booking.id, { start_at: start.toISOString(), end_at: end.toISOString(), staff_id: sid || null });
      for (const p of partners) await repo.updateBooking(p.id, { start_at: start.toISOString(), end_at: end.toISOString() });
      onDone(d);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  const list = [...staff, ...allStaff.filter(s => s.id === booking.staff_id && !staff.some(x => x.id === s.id))];
  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div role="dialog" aria-label="予約日の変更" data-testid="move-dialog" className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-[var(--radius-sheet)] p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1"><h2 className="font-bold">予約日の変更</h2><button className="btn" onClick={onClose}>閉じる</button></div>
        <div className="text-sm text-ink-soft mb-3">{customerName} 様　今の予約：{dateJa(booking.start_at)} {hm(booking.start_at)}〜{hm(booking.end_at)}{partners.length ? "（ペア・2名分まとめて動かします）" : ""}</div>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="lbl" htmlFor="mv-date">日付</label><input id="mv-date" type="date" className="inp w-full" value={d} onChange={e => { setD(e.target.value); setWarn(""); }} /></div>
          <div><label className="lbl" htmlFor="mv-time">開始</label><select id="mv-time" className="inp w-full" value={t} onChange={e => { setT(e.target.value); setWarn(""); }}>{times.map(x => <option key={x} value={x}>{x}</option>)}</select></div>
          <div className="col-span-2"><label className="lbl" htmlFor="mv-staff">担当</label><select id="mv-staff" className="inp w-full" value={sid} onChange={e => { setSid(e.target.value); setWarn(""); }}><option value="">担当なし</option>{list.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
        </div>
        <div className="text-xs text-ink-mute mt-1">所要時間はそのまま（{Math.round(dur / 60000)}分）。{booking.channel === "hpb" ? "HPBの予約は、サロンボード側の日時は変わりません（お客様への連絡も忘れずに）。" : ""}</div>
        {warn && <div className="mt-2 text-sm px-3 py-2 rounded bg-sun-soft border border-[#ecd3a6] text-[#7a4f12]" role="alert">⚠ {warn}</div>}
        {err && <div className="mt-2 text-sm text-danger" role="alert">{err}</div>}
        <div className="flex justify-end gap-2 mt-3">
          <button className="btn" onClick={onClose}>やめる</button>
          {warn ? <button className="btn-primary !bg-sun hover:!bg-[#9a6519]" disabled={busy} onClick={() => save(true)}>それでも移動する</button>
            : <button className="btn-primary" disabled={busy || !d || !t} onClick={() => save()}>この日時に変更</button>}
        </div>
      </div>
    </div>
  );
}

// ---------- キャンセルの確認 ----------
export function CancelDialog({ booking, partners, customerName, menuText, onClose, onDone }: { booking: Booking; partners: Booking[]; customerName: string; menuText: string; onClose: () => void; onDone: () => void }) {
  const repo = getRepo();
  const [busy, setBusy] = useState(false); const [err, setErr] = useState("");
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => { ref.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  async function go() {
    setBusy(true); setErr("");
    try { for (const x of [booking, ...partners]) await repo.updateBooking(x.id, { status: "cancelled" }); onDone(); }
    catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-3" onClick={onClose}>
      <div role="alertdialog" aria-label="予約のキャンセル" data-testid="cancel-dialog" className="bg-white rounded-[var(--radius-sheet)] p-4 w-full max-w-sm shadow-2xl border-t-4 border-danger" onClick={e => e.stopPropagation()}>
        <div className="font-bold mb-1">この予約をキャンセルしますか？</div>
        <div className="text-sm mb-1">{customerName} 様／{dateJa(booking.start_at)} {hm(booking.start_at)}〜{hm(booking.end_at)}</div>
        <div className="text-sm text-ink-soft mb-2">{menuText}{partners.length ? "（ペア：2名分ともキャンセル）" : ""}</div>
        {booking.channel === "hpb" && <div className="text-xs text-[#7a1f45] bg-[#fdeef4] border border-[#f3c2d5] rounded px-2 py-1 mb-2">HPBの予約です。ここでキャンセルしても、サロンボード側はキャンセルされません。</div>}
        {booking.channel === "own" && booking.booking_no && <div className="text-xs text-ink-soft mb-2">ネット予約です。お客様へのキャンセルのご連絡は別にしてください。</div>}
        <div className="text-xs text-ink-mute mb-3">キャンセルは予約トラッキングに残ります。</div>
        {err && <div className="text-sm text-danger mb-2" role="alert">{err}</div>}
        <div className="flex justify-end gap-2"><button ref={ref} className="btn" onClick={onClose}>やめる</button><button className="btn-primary !bg-danger hover:!bg-[#8f1b12]" disabled={busy} onClick={go}>キャンセルする</button></div>
      </div>
    </div>
  );
}

// ---------- 予約トラッキング ----------
export function TrackingModal({ booking, customer, customerName, store, menus, staff, lanes, onClose }: {
  booking: Booking; customer: Customer | null; customerName: string; store: Store | null; menus: Menu[]; staff: Staff[]; lanes: Lane[]; onClose: () => void;
}) {
  const repo = getRepo();
  const [entries, setEntries] = useState<BookingHistoryEntry[] | null | undefined>(undefined);
  useEffect(() => { repo.bookingHistory(booking.id).then(setEntries).catch(() => setEntries(null)); }, [repo, booking.id]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const rows = entries === undefined ? [] : trackingRows(entries || [], booking, { menus, staff, lanes });
  const red = (f: TrackField, ch: TrackField[]) => (ch.includes(f) ? "text-danger font-semibold" : "");
  const no = customer?.external_id ? customer.external_id : null;
  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div role="dialog" aria-label="予約情報トラッキング" data-testid="tracking-modal" className="bg-white w-full sm:max-w-5xl rounded-t-xl sm:rounded-[var(--radius-sheet)] p-4 max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1"><h2 className="text-lg font-bold">予約情報トラッキング</h2><button className="btn" onClick={onClose}>閉じる</button></div>
        <div className="text-xs text-ink-soft mb-2 leading-relaxed">この予約の 登録・変更・キャンセル・削除 の記録です。<b>記録は消えません（期限なし）</b>。※カミングスーンは90日で消えます。変わった項目は赤字です。</div>
        <div className="font-bold mb-2">顧客名：{customerName} 様（{no ? `顧客番号：${no} / ` : ""}店舗名：{store?.name || "—"}）{booking.pair_group && <span className="ml-2 text-xs font-normal text-ink-soft">ペアの予約（代表の方の行の記録）</span>}</div>
        {entries === null && <div className="mb-2 text-sm px-3 py-2 rounded bg-sun-soft border border-[#ecd3a6] text-[#7a4f12]">予約トラッキングは準備中です（DB更新 0013 を流すと、その後の登録・変更・キャンセルが自動で記録されます）。下は予約の作成日時から推定した「登録」だけです。</div>}
        {entries === undefined ? <div className="state">読み込み中…</div> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse text-sm" data-testid="tracking-table">
              <thead><tr className="bg-[#3a3a3a] text-white">{["状態", "操作経路", "操作日時", "メニュー", "スタッフ", "予約開始", "予約終了"].map(h => <th key={h} className="px-2 py-2 font-medium text-center border border-[#3a3a3a]">{h}</th>)}</tr></thead>
              <tbody>{rows.map(r => (
                <tr key={r.key} data-changed={r.changed.join(",")}>
                  <td className={`px-2 py-2 border border-line text-center whitespace-nowrap ${r.state === "キャンセル" || r.state === "削除" ? "text-danger font-semibold" : ""}`}>{r.state}</td>
                  <td className="px-2 py-2 border border-line text-center">{r.route}</td>
                  <td className="px-2 py-2 border border-line text-right whitespace-nowrap tabular-nums">{r.at.split(" ")[0]}<br />{r.at.split(" ")[1]}</td>
                  <td className={`px-2 py-2 border border-line ${red("menu", r.changed)}`}>{r.menu}</td>
                  <td className={`px-2 py-2 border border-line ${red("staff", r.changed)}`}>{r.staff}</td>
                  <td className={`px-2 py-2 border border-line text-right whitespace-nowrap tabular-nums ${red("start", r.changed)}`}>{r.start.split(" ")[0]}<br />{r.start.split(" ")[1]}</td>
                  <td className={`px-2 py-2 border border-line text-right whitespace-nowrap tabular-nums ${red("end", r.changed)}`}>{r.end.split(" ")[0]}<br />{r.end.split(" ")[1]}</td>
                </tr>))}
                {!rows.length && <tr><td colSpan={7} className="px-2 py-4 text-center text-ink-mute border border-line">記録はまだありません</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        <div className="text-[11px] text-ink-mute mt-2">操作経路：ネット予約＝お客様が公式ネット予約から／予約台帳（名前）＝スタッフが台帳で／HPB取り込み＝HPBの予約メールから自動／自動処理＝システム。電話・LINE・OTAで受けて台帳に入れた予約は「電話（予約台帳・名前）」のように出ます。</div>
        <div className="flex justify-center mt-3"><button className="btn min-w-32" onClick={onClose}>閉じる</button></div>
      </div>
    </div>
  );
}

// ---------- 予約詳細：予約したメニューだけ ----------
export function BookedMenuSummary({ menuIds, menus, coupon, people, minutes, price, onEdit }: { menuIds: string[]; menus: Menu[]; coupon: Coupon | null; people: number; minutes: number; price: number; onEdit: () => void }) {
  const ms = menuIds.map(id => menus.find(m => m.id === id)).filter((m): m is Menu => !!m);
  const tech = ms.filter(m => m.category !== "option"), opts = ms.filter(m => m.category === "option");
  return (
    <div className="mt-2 mb-2 rounded-[var(--radius-ctl)] border border-line p-2" data-testid="booked-menu">
      <div className="flex items-center justify-between gap-2">
        <div className="lbl !mb-0">予約したメニュー（{minutes}分・¥{price.toLocaleString()}{people > 1 ? "・1組" : ""}）</div>
        <button type="button" className="btn !min-h-9 text-xs" onClick={onEdit} data-testid="change-menu">メニューを変更</button>
      </div>
      <div className="flex flex-wrap items-center gap-1 mt-1.5">
        {tech.map(m => <span key={m.id} className="inline-flex items-center px-2 py-1 rounded text-[13px] font-semibold text-white" style={{ background: m.color || "#2d5d49" }}>{m.name}<span className="ml-1.5 font-normal opacity-90">¥{m.price.toLocaleString()}</span></span>)}
        {opts.map(o => <span key={o.id} className="inline-flex items-center px-2 py-1 rounded text-[13px] border border-line-strong bg-paper">＋{o.name}{o.price ? <span className="ml-1 text-ink-soft">+¥{o.price.toLocaleString()}</span> : null}{o.duration_min ? <span className="ml-1 text-ink-soft">+{o.duration_min}分</span> : null}</span>)}
        {!ms.length && <span className="text-sm text-ink-mute">メニューが入っていません</span>}
        {coupon && <span className="chip bg-rose-50 text-rose-800 border border-rose-200">クーポン：{coupon.name}</span>}
      </div>
    </div>
  );
}

// ---------- 予約詳細の上の段（カミングスーンの予約詳細に近い並び） ----------
export function BookingFacts({ booking, customer, menus, lanes, staff, people, onNominated }: {
  booking: Partial<Booking>; customer: Customer | null; menus: Menu[]; lanes: Lane[]; staff: Staff[]; people: number; onNominated: (v: boolean) => void;
}) {
  const repo = getRepo();
  const [prev, setPrev] = useState<{ date: string; menu: string } | null | undefined>(undefined);
  const cid = booking.customer_id || null, start = booking.start_at || "";
  useEffect(() => {
    if (!cid) { void Promise.resolve().then(() => setPrev(null)); return; }
    (async () => {
      const [bs, ss, hv] = await Promise.all([repo.bookingsOfCustomer(cid).catch(() => []), repo.salesOfCustomer(cid).catch(() => []), repo.historicalVisits(cid).catch(() => null)]);
      const c: { date: string; menu: string }[] = [];
      for (const x of bs) if (x.status === "done" && x.id !== booking.id && x.start_at < start) c.push({ date: x.start_at, menu: bookingMenuLabel(x.menu_ids, menus) });
      for (const x of ss) if (x.status === "confirmed" && x.sold_at < start && !bs.some(y => y.id === x.booking_id)) c.push({ date: x.sold_at, menu: x.lines.filter(l => l.kind !== "product").map(l => l.name).join("・") });
      for (const h of hv || []) { const d = h.visited_on || h.last_visit_on; if (d && new Date(`${d}T12:00:00`).toISOString() < start) c.push({ date: new Date(`${d}T12:00:00`).toISOString(), menu: h.menu_text || "（前のPOSの来店）" }); }
      c.sort((a, b) => b.date.localeCompare(a.date));
      setPrev(c[0] || null);
    })();
  }, [repo, cid, start, booking.id, menus]);
  const lane = booking.lane_id ? lanes.find(l => l.id === booking.lane_id)?.name : null;
  const who = booking.staff_id ? staff.find(s => s.id === booking.staff_id)?.name : null;
  const no = booking.booking_no || (booking.external_ref ? `${CHANNEL_LABEL[booking.channel || "own"]} ${booking.external_ref}` : null);
  const comment = [...(booking.intake || []).map(a => `■${a.label}\n${a.answer || "—"}`)].join("\n");
  return (
    <div className="grid sm:grid-cols-2 gap-3 mb-3" data-testid="booking-facts">
      <div className="min-w-0">
        <div className="text-xs text-ink-soft border-b border-line pb-1">予約番号 <span className="text-ink font-medium tabular-nums">{no || "—"}</span><span className="ml-2 chip bg-paper border border-line">{CHANNEL_LABEL[booking.channel || "own"]}</span></div>
        {start && <div className="text-[17px] font-bold py-1.5 border-b border-line tabular-nums">{dateJa(start)}　{hm(start)} 〜 {booking.end_at ? hm(booking.end_at) : ""}</div>}
        <div className="py-1.5 border-b border-line">
          {customer ? <>
            <div className="text-xs text-ink-soft">{customer.external_id ? `No.${customer.external_id}　` : ""}{customer.kana || ""}</div>
            <div className="flex items-center gap-2"><span className="text-[17px] font-bold">{customer.name} 様</span><Link className="btn !min-h-8 text-xs ml-auto" href={`/customers/${customer.id}`}>詳細</Link></div>
            <div className="text-xs text-ink-soft tabular-nums">{customer.phone ? `☎ ${customer.phone}` : ""}{customer.birthday ? `　誕生日 ${customer.birthday.replace(/-/g, "/")}` : customer.birth_month ? `　生年月 ${customer.birth_month}` : ""}</div>
          </> : <div className="font-semibold">{booking.customer_name || "（お客様未登録）"}</div>}
        </div>
        <div className="py-1.5 border-b border-line">
          <div className="text-xs text-ink-soft mb-0.5">メニュー</div>
          <div className="text-sm font-semibold" data-testid="facts-menu">{bookingMenuLabel(booking.menu_ids || [], menus) || "—"}{people > 1 ? "（2名様）" : ""}</div>
        </div>
        <div className="flex items-center gap-2 py-1.5">
          <div className="text-sm min-w-0 flex-1 truncate" data-testid="facts-lane">{lane || "受付枠なし"}<span className="text-ink-soft">／担当 {who || "なし"}</span></div>
          <div className="seg" role="group" aria-label="指名・フリー">
            <button type="button" aria-pressed={!!booking.nominated} onClick={() => onNominated(true)}>指名</button>
            <button type="button" aria-pressed={!booking.nominated} onClick={() => onNominated(false)}>フリー</button>
          </div>
        </div>
      </div>
      <div className="min-w-0 space-y-2">
        <div className="grid grid-cols-2 gap-2 text-sm" data-testid="facts-prev">
          <div><div className="text-xs text-ink-soft">前回来店日</div><div className="font-semibold tabular-nums">{prev === undefined ? "…" : prev ? new Date(prev.date).toLocaleDateString("ja-JP") : "初めて（記録なし）"}</div></div>
          <div className="min-w-0"><div className="text-xs text-ink-soft">前回メニュー</div><div className="truncate" title={prev?.menu}>{prev ? prev.menu || "—" : "—"}</div></div>
        </div>
        <div className="rounded-[var(--radius-ctl)] bg-paper border border-line p-2"><div className="text-xs text-ink-soft mb-0.5">お客様からの予約コメント</div><div className="text-sm whitespace-pre-wrap max-h-28 overflow-auto">{comment || "—"}</div></div>
        <div className="rounded-[var(--radius-ctl)] border border-line p-2"><div className="text-xs text-ink-soft mb-0.5 flex items-center">接客メモ{customer && <Link href={`/customers/${customer.id}`} className="ml-auto text-canopy underline">お客様画面で書く</Link>}</div><div className="text-sm whitespace-pre-wrap max-h-24 overflow-auto">{customer?.note || "—"}</div></div>
      </div>
    </div>
  );
}
