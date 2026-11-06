"use client";
// 設定画面の共通部品：タブ・管理者だけ・準備中の表示・曜日の選択
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getRepo, type Staff, type Capabilities } from "@/lib/db";
import { WD_JA } from "@/lib/web";

const TABS = [{ href: "/settings", label: "店舗・ネット予約" }, { href: "/settings/menus", label: "メニュー" }, { href: "/settings/coupons", label: "クーポン" }, { href: "/settings/staff", label: "スタッフ" }, { href: "/settings/karte", label: "カルテ背景" }, { href: "/settings/hpb", label: "HPB連携" }];

export function useAdmin() {
  const [me, setMe] = useState<Staff | null | undefined>(undefined);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  useEffect(() => { const r = getRepo(); r.me().then(setMe).catch(() => setMe(null)); r.capabilities().then(setCaps).catch(() => {}); }, []);
  const isAdmin = me === undefined ? undefined : !!me && (me.role === "owner" || me.role === "manager");
  return { me, isAdmin, caps };
}

export function SettingsFrame({ title, children, isAdmin, notReady }: { title: string; children: React.ReactNode; isAdmin: boolean | undefined; notReady?: string | false | null }) {
  const path = usePathname();
  return (
    <div className="max-w-5xl">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h1 className="text-xl font-bold mr-2">{title}</h1>
        <div className="seg" role="tablist">
          {TABS.map(t => <Link key={t.href} href={t.href} role="tab" aria-selected={path === t.href}>{t.label}</Link>)}
        </div>
      </div>
      {isAdmin === undefined ? <div className="text-stone-500">読み込み中…</div>
        : !isAdmin ? <div className="card text-sm">この画面はオーナー・店長だけが使えます。変更が必要なときは店長に連絡してください。</div>
        : <>{notReady && <div className="mb-3 text-sm px-3 py-2 rounded bg-amber-50 border border-amber-300 text-amber-900">{notReady}</div>}{children}</>}
    </div>
  );
}

export function WeekdayPicker({ value, onChange }: { value: number[] | null | undefined; onChange: (v: number[] | null) => void }) {
  const v = value || [];
  const set = (x: number[]) => onChange(x.length ? [...x].sort() : null);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {WD_JA.map((w, i) => { const on = v.includes(i); return <button type="button" key={i} onClick={() => set(on ? v.filter(x => x !== i) : [...v, i])} className={`w-8 h-8 rounded border text-sm ${on ? "bg-canopy text-white border-canopy" : "bg-white"} ${i === 0 ? "text-rose-600" : i === 6 ? "text-sky-700" : ""} ${on ? "!text-white" : ""}`}>{w}</button>; })}
      <button type="button" className="btn text-xs" onClick={() => set([1, 2, 3, 4, 5])}>平日</button>
      <button type="button" className="btn text-xs" onClick={() => set([0, 6])}>土日</button>
      <button type="button" className="btn text-xs" onClick={() => onChange(null)}>毎日</button>
    </div>
  );
}

export function Field({ label, children, hint, className = "" }: { label: string; children: React.ReactNode; hint?: string; className?: string }) {
  return <label className={`block ${className}`}><span className="lbl">{label}</span>{children}{hint && <span className="block text-[11px] text-stone-400 mt-0.5">{hint}</span>}</label>;
}
