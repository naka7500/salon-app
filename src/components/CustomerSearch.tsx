"use client";
// お客様を探して選ぶ（名前・カナ・電話。入力のたびにサーバで検索する＝何千人いても全員から探せる）
import { useEffect, useRef, useState } from "react";
import { getRepo, type Customer } from "@/lib/db";

export default function CustomerSearch({ value, onPick, compact, placeholder, onCreate }: {
  value: Customer | null; onPick: (c: Customer | null) => void; compact?: boolean; placeholder?: string;
  /** 見つからないとき「新規登録」（名前を渡す） */ onCreate?: (name: string) => Promise<Customer>;
}) {
  const repo = getRepo();
  const [q, setQ] = useState("");
  const [list, setList] = useState<Customer[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const k = q.trim();
    if (!k) { void Promise.resolve().then(() => setList([])); return; }
    const my = ++seq.current;
    const t = setTimeout(() => {
      setLoading(true);
      repo.customers(k, { limit: 30 }).then(r => { if (my === seq.current) setList(r); }).catch(() => { if (my === seq.current) setList([]); }).finally(() => { if (my === seq.current) setLoading(false); });
    }, 250);
    return () => clearTimeout(t);
  }, [repo, q]);

  if (value) return (
    <div className={`flex items-center gap-1 ${compact ? "" : "w-full"}`} data-testid="customer-picked">
      <span className="text-sm font-semibold truncate">{value.name}</span>{value.phone && <span className="text-xs text-ink-mute">{value.phone}</span>}
      <button type="button" className="btn-quiet !min-h-8 text-xs" onClick={() => { onPick(null); setQ(""); }}>変更</button>
    </div>
  );
  return (
    <div className={`relative ${compact ? "w-48" : "w-full"}`}>
      <input className="inp w-full text-sm" value={q} placeholder={placeholder || "お客様を検索（名前・カナ・電話）"} aria-label="お客様を検索" data-testid="customer-search"
        onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
      {open && q.trim() && (
        <div className="absolute z-50 mt-1 left-0 right-0 bg-white border border-line rounded-[var(--radius-ctl)] shadow-lg max-h-72 overflow-auto" role="listbox">
          {loading && <div className="px-3 py-2 text-xs text-ink-mute">検索中…</div>}
          {!loading && list.length === 0 && <div className="px-3 py-2 text-xs text-ink-mute">見つかりません</div>}
          {list.map(c => <button key={c.id} type="button" role="option" aria-selected={false} className="w-full text-left px-3 py-2 text-sm hover:bg-moss min-h-10" onMouseDown={e => e.preventDefault()} onClick={() => { onPick(c); setOpen(false); setQ(""); }}>
            <span className="font-semibold">{c.name}</span> <span className="text-xs text-ink-mute">{c.kana || ""} {c.phone || ""}</span></button>)}
          {list.length >= 30 && <div className="px-3 py-1.5 text-[11px] text-ink-mute">30人まで表示しています。もう少し詳しく入れてください</div>}
          {onCreate && !loading && <button type="button" className="w-full text-left px-3 py-2 text-sm text-canopy border-t border-line min-h-10" onMouseDown={e => e.preventDefault()} onClick={async () => { const c = await onCreate(q.trim()); onPick(c); setOpen(false); setQ(""); }}>＋「{q.trim()}」で新規登録</button>}
        </div>
      )}
    </div>
  );
}
