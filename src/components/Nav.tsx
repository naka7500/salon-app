"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getRepo, type Store } from "@/lib/db";
import { logout } from "@/components/AuthGate";

const items = [
  { href: "/bookings", label: "予約台帳" },
  { href: "/pos", label: "会計" },
  { href: "/close", label: "レジ締め" },
  { href: "/customers", label: "顧客・カルテ" },
  { href: "/inventory", label: "在庫" },
  { href: "/reports", label: "売上" },
];

export default function Nav() {
  const path = usePathname();
  const [storeName, setStoreName] = useState("");
  const [mode, setMode] = useState("");
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState("");
  useEffect(() => { const r = getRepo(); setMode(r.mode); r.store().then(s => { setStoreName(s.name); setStoreId(s.id); }).catch(() => setStoreName("(店舗未設定)")); r.stores().then(setStores).catch(() => {}); }, []);
  function switchStore(id: string) { getRepo().switchStore(id); location.reload(); }
  return (
    <header className="bg-[#2f6b4f] text-white">
      <div className="max-w-7xl mx-auto px-3 sm:px-5 flex items-center gap-2 h-12 overflow-x-auto">
        <Link href="/bookings" className="font-bold whitespace-nowrap mr-2">{storeName || "サロン台帳"}</Link>
        {items.map(i => (
          <Link key={i.href} href={i.href} className={`px-3 py-1.5 rounded text-sm whitespace-nowrap ${path?.startsWith(i.href) ? "bg-white text-[#2f6b4f] font-semibold" : "hover:bg-white/15"}`}>{i.label}</Link>
        ))}
        {mode === "memory" && stores.length > 1 && <select className="ml-auto text-xs text-stone-800 rounded px-1 py-0.5" value={storeId} onChange={e => switchStore(e.target.value)}>{stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        <span className={`${mode === "memory" && stores.length > 1 ? "ml-2" : "ml-auto"} text-[10px] opacity-70 whitespace-nowrap`}>{mode === "memory" ? "デモ（端末内保存）" : "本番"}</span>
        {mode === "supabase" && <button onClick={logout} className="ml-2 text-xs underline opacity-80 whitespace-nowrap">ログアウト</button>}
      </div>
    </header>
  );
}
