"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getRepo, isTestStore, type Store, type Staff } from "@/lib/db";
import { logout } from "@/components/AuthGate";
import { storeColor, getReportScope, setReportScope, REPORT_SCOPE_EVENT, reportAllStores } from "@/lib/storeScope";

/** ネット予約の新着バッジを更新したいときに投げるイベント */
export const INBOX_EVENT = "salon-app:inbox";

const items = [
  { href: "/bookings", label: "予約台帳" },
  { href: "/shifts", label: "シフト" },
  { href: "/pos", label: "会計" },
  { href: "/close", label: "レジ締め" },
  { href: "/ledger", label: "売上台帳" },
  { href: "/customers", label: "顧客・カルテ" },
  { href: "/inventory", label: "在庫" },
  { href: "/reports", label: "集計" },
  { href: "/line", label: "LINE" },
  { href: "/settings", label: "設定", admin: true },
];
const ROLE_LABEL: Record<string, string> = { owner: "オーナー", manager: "店長", staff: "スタッフ", viewer: "閲覧のみ" };

export default function Nav() {
  const path = usePathname();
  const [mode, setMode] = useState("");
  const [stores, setStores] = useState<Store[]>([]);
  const [cur, setCur] = useState<Store | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"all" | "store">("store");
  const [me, setMe] = useState<Staff | null>(null);
  const [unread, setUnread] = useState(0);
  const onReports = !!path?.startsWith("/reports");
  useEffect(() => {
    const r = getRepo(); void Promise.resolve().then(() => setMode(r.mode));
    r.store().then(setCur).catch(() => setErr(true));
    r.stores().then(setStores).catch(() => {});
    r.me().then(setMe).catch(() => {});
    const inbox = () => { r.notifications(true).then(n => setUnread(n ? n.filter(x => x.kind === "new_booking" || x.kind === "hpb_booking" || x.kind === "hpb_change" || x.kind === "hpb_attention" || x.kind === "line_change").length : 0)).catch(() => {}); };
    inbox(); const iv = setInterval(inbox, 60000); window.addEventListener(INBOX_EVENT, inbox);
    const sync = () => setScope(getReportScope()); void Promise.resolve().then(sync);
    window.addEventListener(REPORT_SCOPE_EVENT, sync);
    return () => { window.removeEventListener(REPORT_SCOPE_EVENT, sync); window.removeEventListener(INBOX_EVENT, inbox); clearInterval(iv); };
  }, []);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [open]);

  const curFull = stores.find(s => s.id === cur?.id) || cur || undefined;
  const color = storeColor(curFull, stores);
  const multi = stores.length > 1;
  const showAll = onReports && scope === "all" && multi;
  const allList = reportAllStores(stores, curFull);
  const allLabel = isTestStore(curFull) ? `全店（テスト店舗だけ）` : `全店（テスト店舗を除く${allList.length}店舗）`;
  const isAdmin = !me || me.role === "owner" || me.role === "manager";
  function pick(id: string) {
    setReportScope("store");
    if (id === cur?.id) { setOpen(false); return; }
    getRepo().switchStore(id); location.reload();
  }
  function pickAll() { setReportScope("all"); setOpen(false); }
  const test = isTestStore(curFull);
  const title = err ? "(店舗未設定)" : curFull?.name || "サロン台帳";

  // 会社ごとにまとめる
  const groups: { company: string; list: Store[] }[] = [];
  for (const s of stores) { const c = s.company_name || "（会社名なし）"; let g = groups.find(x => x.company === c); if (!g) groups.push(g = { company: c, list: [] }); g.list.push(s); }

  return (
    <header className="bg-canopy-deep text-white sticky top-0 z-40 shadow-[0_1px_0_rgba(0,0,0,.12)]">
      <div className="max-w-7xl mx-auto px-3 sm:px-5 flex flex-wrap lg:flex-nowrap items-center gap-x-3 gap-y-1 py-1.5 lg:py-0 lg:h-16">
        {multi ? (
          <button onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`表示中の店舗：${showAll ? "全店" : title}。押すと店舗を切り替えます`}
            className="order-1 flex items-center gap-2 bg-white text-ink rounded-[var(--radius-ctl)] pl-1.5 pr-2.5 py-1 min-h-11 hover:bg-moss active:bg-moss max-w-[72vw] lg:max-w-xs">
            <span className="w-2.5 self-stretch rounded" style={{ background: showAll ? "#57534e" : color }} />
            <span className="text-left leading-tight min-w-0">
              <span className="block text-[10px] text-ink-mute">{showAll ? "集計の対象" : "店舗"}</span>
              <span className="block font-bold text-[15px] truncate">{showAll ? allLabel : title}</span>
            </span>
            {test && !showAll && <span className="text-[10px] font-bold bg-amber-400 text-stone-900 rounded px-1.5 py-0.5 whitespace-nowrap">練習用</span>}
            <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" className="ml-1 text-ink-mute shrink-0"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
          </button>
        ) : (
          <Link href="/bookings" className="order-1 font-bold text-base whitespace-nowrap mr-2">{title}</Link>
        )}
        <nav aria-label="メニュー" className="order-3 lg:order-2 w-full lg:w-auto flex items-center gap-0.5 overflow-x-auto -mx-1 px-1 pb-1 lg:pb-0 [scrollbar-width:none]">
          {items.filter(i => !i.admin || isAdmin).map(i => (
            <Link key={i.href} href={i.href} aria-current={path?.startsWith(i.href) ? "page" : undefined} className={`relative inline-flex items-center min-h-11 px-3 rounded-[var(--radius-ctl)] text-sm whitespace-nowrap transition-colors ${path?.startsWith(i.href) ? "bg-white text-canopy-deep font-bold" : "text-white/90 hover:bg-white/10"}`}>
              {i.label}
              {i.href === "/bookings" && unread > 0 && <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-500 text-white text-[10px] font-bold align-middle" title={`新しい予約・お知らせ ${unread}件`}>{unread}</span>}
            </Link>
          ))}
        </nav>
        <div className="order-2 lg:order-3 ml-auto flex items-center gap-2">
          <span className="hidden sm:inline text-[10px] opacity-70 whitespace-nowrap">{mode === "memory" ? "デモ（端末内保存）" : "本番"}</span>
          {mode === "memory" && me && (
            <label className="text-[10px] flex items-center gap-1 opacity-90" title="デモだけ：役割を切り替えて権限の違いを試せます">
              <span className="hidden sm:inline whitespace-nowrap">ログイン中</span>
              <select aria-label="デモのログイン中の役割" className="bg-white text-ink text-xs rounded px-1 py-1 min-h-8" value={me.role} onChange={async e => { const { setDemoRole } = await import("@/lib/db/memory"); setDemoRole(e.target.value as "owner" | "manager" | "staff"); location.reload(); }}>
                <option value="owner">オーナー</option><option value="manager">店長</option><option value="staff">スタッフ</option>
              </select>
            </label>
          )}
          {mode === "supabase" && me && <span className="text-[10px] opacity-80 whitespace-nowrap">{me.name}（{ROLE_LABEL[me.role]}）</span>}
          {mode === "supabase" && <button onClick={logout} className="text-xs underline opacity-80 whitespace-nowrap">ログアウト</button>}
        </div>
      </div>
      {/* 今どの店舗か：店舗色の帯 */}
      {test ? <div className="bg-[#f2c94c] text-ink text-xs text-center py-1 px-3 font-semibold">練習用のテスト店舗<span className="hidden sm:inline">です。ここで入力したデータは本番の店舗には出ません</span></div>
        : multi && <div className="h-1.5" style={{ background: showAll ? "#57534e" : color }} />}

      {open && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-end sm:items-start justify-center sm:pt-16" onClick={() => setOpen(false)}>
          <div role="dialog" aria-label="店舗を切り替える" className="bg-white text-stone-900 w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b sticky top-0 bg-white">
              <div className="font-bold">店舗を切り替える</div>
              <button className="btn" onClick={() => setOpen(false)}>閉じる</button>
            </div>
            <div className="p-3 space-y-3">
              {onReports && (
                <button onClick={pickAll} className={`w-full flex items-center gap-3 rounded-xl border-2 px-3 py-3 text-left min-h-[56px] ${showAll ? "border-stone-700 bg-stone-50" : "border-stone-200 hover:bg-stone-50"}`}>
                  <span className="w-3 self-stretch rounded" style={{ background: "#57534e" }} />
                  <span className="flex-1"><span className="block font-bold">{allLabel}</span><span className="block text-xs text-stone-500">集計画面だけ。{isTestStore(curFull) ? "テスト店舗だけを合計（練習用）" : `${allList.map(s => s.name).join("・")} を合計。テスト店舗（練習用）は入れません`}</span></span>
                  {showAll && <span className="text-emerald-700 font-bold">✓</span>}
                </button>
              )}
              {groups.map(g => (
                <div key={g.company}>
                  <div className="text-xs text-stone-500 mb-1 px-1">{g.company}</div>
                  <div className="space-y-1.5">
                    {g.list.map(s => { const on = s.id === cur?.id && !showAll; return (
                      <button key={s.id} onClick={() => pick(s.id)} className={`w-full flex items-center gap-3 rounded-xl border-2 px-3 py-3 text-left min-h-[56px] ${on ? "border-stone-700 bg-stone-50" : "border-stone-200 hover:bg-stone-50"}`}>
                        <span className="w-3 self-stretch rounded" style={{ background: storeColor(s, stores) }} />
                        <span className="flex-1 min-w-0"><span className="block font-bold truncate">{s.name}</span><span className="block text-xs text-stone-500 truncate">{s.company_name || ""}</span></span>
                        {isTestStore(s) && <span className="text-[10px] font-bold bg-amber-400 text-stone-900 rounded px-1.5 py-0.5">練習用</span>}
                        {on && <span className="text-emerald-700 font-bold">✓</span>}
                      </button>); })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
