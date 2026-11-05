"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getRepo, isTestStore, type Store } from "@/lib/db";
import { logout } from "@/components/AuthGate";
import { storeColor, getReportScope, setReportScope, REPORT_SCOPE_EVENT } from "@/lib/storeScope";

const items = [
  { href: "/bookings", label: "予約台帳" },
  { href: "/shifts", label: "シフト" },
  { href: "/pos", label: "会計" },
  { href: "/close", label: "レジ締め" },
  { href: "/ledger", label: "売上台帳" },
  { href: "/customers", label: "顧客・カルテ" },
  { href: "/inventory", label: "在庫" },
  { href: "/reports", label: "集計" },
];

export default function Nav() {
  const path = usePathname();
  const [mode, setMode] = useState("");
  const [stores, setStores] = useState<Store[]>([]);
  const [cur, setCur] = useState<Store | null>(null);
  const [err, setErr] = useState(false);
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"all" | "store">("store");
  const onReports = !!path?.startsWith("/reports");
  useEffect(() => {
    const r = getRepo(); void Promise.resolve().then(() => setMode(r.mode));
    r.store().then(setCur).catch(() => setErr(true));
    r.stores().then(setStores).catch(() => {});
    const sync = () => setScope(getReportScope()); void Promise.resolve().then(sync);
    window.addEventListener(REPORT_SCOPE_EVENT, sync); return () => window.removeEventListener(REPORT_SCOPE_EVENT, sync);
  }, []);
  useEffect(() => { if (!open) return; const k = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [open]);

  const curFull = stores.find(s => s.id === cur?.id) || cur || undefined;
  const color = storeColor(curFull, stores);
  const multi = stores.length > 1;
  const showAll = onReports && scope === "all" && multi;
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
    <header className="bg-[#2f6b4f] text-white">
      <div className="max-w-7xl mx-auto px-3 sm:px-5 flex flex-wrap md:flex-nowrap items-center gap-x-2 gap-y-1 py-1.5 md:py-0 md:h-14">
        {multi ? (
          <button onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`表示中の店舗：${showAll ? "全店" : title}。押すと店舗を切り替えます`}
            className="order-1 flex items-center gap-2 bg-white text-stone-900 rounded-lg pl-1.5 pr-3 py-1 min-h-[44px] shadow-sm hover:bg-stone-50 active:bg-stone-100 max-w-[70vw] md:max-w-xs">
            <span className="w-2.5 self-stretch rounded" style={{ background: showAll ? "#57534e" : color }} />
            <span className="text-left leading-tight min-w-0">
              <span className="block text-[10px] text-stone-500">{showAll ? "集計の対象" : "表示中の店舗"}</span>
              <span className="block font-bold text-[15px] truncate">{showAll ? `全店（${stores.length}店舗の合計）` : title}</span>
            </span>
            {test && !showAll && <span className="text-[10px] font-bold bg-amber-400 text-stone-900 rounded px-1.5 py-0.5 whitespace-nowrap">練習用</span>}
            <span className="text-stone-500 text-sm ml-1">▼</span>
          </button>
        ) : (
          <Link href="/bookings" className="order-1 font-bold text-base whitespace-nowrap mr-2">{title}</Link>
        )}
        <nav className="order-3 md:order-2 w-full md:w-auto flex items-center gap-1 overflow-x-auto -mx-1 px-1 pb-0.5 md:pb-0">
          {items.map(i => (
            <Link key={i.href} href={i.href} className={`px-3 py-1.5 rounded text-sm whitespace-nowrap ${path?.startsWith(i.href) ? "bg-white text-[#2f6b4f] font-semibold" : "hover:bg-white/15"}`}>{i.label}</Link>
          ))}
        </nav>
        <div className="order-2 md:order-3 ml-auto flex items-center gap-2">
          <span className="text-[10px] opacity-70 whitespace-nowrap">{mode === "memory" ? "デモ（端末内保存）" : "本番"}</span>
          {mode === "supabase" && <button onClick={logout} className="text-xs underline opacity-80 whitespace-nowrap">ログアウト</button>}
        </div>
      </div>
      {/* 今どの店舗か：店舗色の帯 */}
      {test ? <div className="bg-amber-400 text-stone-900 text-xs text-center py-1 font-semibold">練習用のテスト店舗です。ここで入力したデータは本番の店舗には出ません。</div>
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
                  <span className="flex-1"><span className="block font-bold">全店（見られる店舗の合計）</span><span className="block text-xs text-stone-500">集計画面だけ。{stores.length}店舗を合計して表示</span></span>
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
