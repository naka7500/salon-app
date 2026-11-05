"use client";
/* eslint-disable @next/next/no-img-element -- カルテの画像は期限つきURL・data: URL（next/image の最適化は使えない） */
// カルテの手書きページの表示：小さい見本・大きく見る・印刷
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export interface ShownPage { key: string; url?: string; label?: string }

/** 手書きページの小さい見本（押すと大きく見る） */
export function PageThumbs({ pages, onOpen, size = "md" }: { pages: ShownPage[]; onOpen: (i: number) => void; size?: "sm" | "md" }) {
  if (!pages.length) return null;
  return (
    <div className={`grid gap-1.5 mt-1 ${size === "sm" ? "grid-cols-4" : "grid-cols-2 sm:grid-cols-3"}`}>
      {pages.map((p, i) => (
        <button key={p.key} type="button" onClick={() => onOpen(i)} aria-label={`手書き ${i + 1}ページ目を大きく見る`}
          className="relative aspect-[1414/1000] rounded border border-line bg-white overflow-hidden hover:ring-2 hover:ring-canopy/30">
          {p.url ? <img src={p.url} alt={`手書き ${i + 1}ページ目`} className="w-full h-full object-contain" loading="lazy" /> : <span className="text-[11px] text-ink-mute">読み込み中…</span>}
          <span className="absolute left-1 bottom-1 chip bg-white/90 border border-line text-ink-soft">{p.label || `${i + 1}`}</span>
        </button>
      ))}
    </div>
  );
}

/** 大きく見る（前後のページ・編集・印刷） */
export function PageLightbox({ pages, index, onClose, onEdit, onPrint, title }: { pages: ShownPage[]; index: number; onClose: () => void; onEdit?: () => void; onPrint?: () => void; title: string }) {
  const [i, setI] = useState(index);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowLeft") setI(x => Math.max(0, x - 1)); if (e.key === "ArrowRight") setI(x => Math.min(pages.length - 1, x + 1)); };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [pages.length, onClose]);
  const p = pages[Math.min(i, pages.length - 1)];
  return (
    <div className="fixed inset-0 z-[55] bg-black/70 flex flex-col" role="dialog" aria-modal="true" aria-label={`手書き：${title}`} onClick={onClose}>
      <div className="bg-white px-3 py-2 flex flex-wrap items-center gap-2" onClick={e => e.stopPropagation()}>
        <div className="font-semibold text-sm mr-2">{title}</div>
        <span className="text-sm text-ink-soft tabular-nums">{i + 1} / {pages.length}</span>
        <button className="btn" disabled={i <= 0} onClick={() => setI(i - 1)} aria-label="前のページ">‹ 前</button>
        <button className="btn" disabled={i >= pages.length - 1} onClick={() => setI(i + 1)} aria-label="次のページ">次 ›</button>
        <div className="ml-auto flex gap-2">
          {onPrint && <button className="btn" onClick={onPrint}>印刷</button>}
          {onEdit && <button className="btn-primary" onClick={onEdit}>このカルテの手書きを編集</button>}
          <button className="btn" onClick={onClose}>閉じる</button>
        </div>
      </div>
      <div className="flex-1 min-h-0 p-3 grid place-items-center">
        {p?.url ? <img src={p.url} alt={`手書き ${i + 1}ページ目`} className="max-w-full max-h-full object-contain bg-white rounded shadow" onClick={e => e.stopPropagation()} /> : <div className="text-white text-sm">読み込み中…</div>}
      </div>
    </div>
  );
}

/** 印刷用の紙面（画面には出さない）。画像が読み込めたら印刷ダイアログを開き、閉じたら onDone */
export function PrintSheet({ children, imageCount, onDone }: { children: React.ReactNode; imageCount: number; onDone: () => void }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!el) return;
    document.body.classList.add("printing-karte");
    let done = false;
    const finish = () => { if (done) return; done = true; document.body.classList.remove("printing-karte"); onDone(); };
    const go = () => { window.addEventListener("afterprint", finish, { once: true }); window.print(); setTimeout(finish, 60000); };
    const imgs = [...el.querySelectorAll("img")];
    Promise.all(imgs.map(im => (im.complete ? Promise.resolve() : new Promise(r => { im.onload = im.onerror = () => r(null); })))).then(() => setTimeout(go, 50));
    return () => { document.body.classList.remove("printing-karte"); };
  }, [el, imageCount, onDone]);
  if (typeof document === "undefined") return null;
  return createPortal(<div ref={setEl} className="print-sheet">{children}</div>, document.body);
}
