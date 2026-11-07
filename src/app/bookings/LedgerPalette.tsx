"use client";
// 予約台帳の上のチップ（パレット）。チップを台帳の行・時刻へドラッグ（マウス・指・Apple Pencil）して置く。
// ドラッグしにくいときは、チップを1回押して「選択中」にしてから、台帳の行を押しても置ける。
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BlockKind, ID, Menu } from "@/lib/db";
import { PALETTE_MAX, type PaletteChip } from "@/lib/ledgerPalette";

export interface BlockLook { label: string; short: string; bg: string; fg: string }
const sameChip = (a: PaletteChip | null, b: PaletteChip) => !!a && a.type === b.type && (a.type === "block" ? a.kind === (b as { kind: BlockKind }).kind : a.id === (b as { id: ID }).id);

export default function LedgerPalette({ blocks, menus, allMenus, isAdmin, armed, onArm, onDrop, onSave, saveNote }: {
  blocks: Record<BlockKind, BlockLook>;
  /** 台帳に出すメニュー（並び順どおり） */ menus: Menu[];
  /** 選べる技術メニュー（表示するメニューを選ぶ用） */ allMenus: Menu[];
  isAdmin: boolean;
  armed: PaletteChip | null;
  onArm: (c: PaletteChip | null) => void;
  onDrop: (c: PaletteChip, x: number, y: number) => void;
  /** 表示するメニューを保存（null＝既定に戻す） */ onSave: (ids: ID[] | null) => Promise<void>;
  saveNote?: string;
}) {
  const [ghost, setGhost] = useState<{ chip: PaletteChip; x: number; y: number; label: string; bg: string; fg: string } | null>(null);
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [picking, setPicking] = useState(false);
  // 画面上のヘッダー（ナビ）の下に貼りつける
  const [top, setTop] = useState(0);
  useEffect(() => { const h = document.querySelector("header"); if (!h) return; const f = () => setTop(h.getBoundingClientRect().height); f(); const ro = new ResizeObserver(f); ro.observe(h); return () => ro.disconnect(); }, []);

  function handlers(chip: PaletteChip, label: string, bg: string, fg: string) {
    return {
      onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0 && e.pointerType === "mouse") return;
        start.current = { x: e.clientX, y: e.clientY, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      },
      onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
        const s = start.current; if (!s) return;
        if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6) s.moved = true;
        if (s.moved) setGhost({ chip, x: e.clientX, y: e.clientY, label, bg, fg });
      },
      onPointerUp: (e: React.PointerEvent<HTMLButtonElement>) => {
        const s = start.current; start.current = null; setGhost(null);
        if (!s) return;
        if (s.moved) { onArm(null); onDrop(chip, e.clientX, e.clientY); }
        else onArm(sameChip(armed, chip) ? null : chip);
      },
      onPointerCancel: () => { start.current = null; setGhost(null); },
      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Escape") onArm(null); },
    };
  }
  const chipCls = "inline-flex items-center gap-1 min-h-7 max-sm:min-h-9 px-2 rounded-full text-xs font-semibold whitespace-nowrap select-none touch-none cursor-grab active:cursor-grabbing border shadow-sm";

  return (
    <div style={{ top }} className="sticky z-30 mb-2 rounded-[var(--radius-sheet)] border border-line bg-white/95 backdrop-blur px-2 py-1.5" data-testid="ledger-palette">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-ink-soft mr-1 hidden sm:inline">ドラッグで置く</span>
        {(Object.keys(blocks) as BlockKind[]).map(k => {
          const b = blocks[k]; const chip: PaletteChip = { type: "block", kind: k }; const on = sameChip(armed, chip);
          return <button key={k} type="button" aria-pressed={on} data-chip={`block:${k}`} title={`${b.label}：台帳の行へドラッグ（または押してから行を押す）`}
            className={`${chipCls} border-transparent ${on ? "ring-2 ring-offset-1 ring-sun" : ""}`} style={{ background: b.bg, color: b.fg }} {...handlers(chip, b.short === "IDL" ? "IDLE" : b.short === "BRK" ? "BREAK" : b.short, b.bg, b.fg)}>
            {k === "idle" ? "IDLE" : k === "break" ? "BREAK" : k === "close" ? "×" : "保証"}
          </button>;
        })}
        <span className="w-px h-6 bg-line mx-0.5" aria-hidden />
        {menus.map(m => {
          const chip: PaletteChip = { type: "menu", id: m.id }; const on = sameChip(armed, chip); const c = m.color || "#6f7b74";
          const label = m.short_name || m.name;
          return <button key={m.id} type="button" aria-pressed={on} data-chip={`menu:${m.id}`} title={`${m.name}（${m.duration_min}分）：台帳の行へドラッグすると予約の画面が開きます`}
            className={`${chipCls} text-ink ${on ? "ring-2 ring-offset-1 ring-sun" : ""}`} style={{ background: `color-mix(in srgb, ${c} 18%, white)`, borderColor: `color-mix(in srgb, ${c} 60%, white)`, borderLeft: `5px solid ${c}` }} {...handlers(chip, label, c, "#fff")}>
            {label}
          </button>;
        })}
        {menus.length === 0 && <span className="text-xs text-ink-mute">（台帳に出すメニューがありません）</span>}
        {isAdmin && <button type="button" className="btn-quiet ml-auto" onClick={() => setPicking(true)} data-testid="palette-pick">表示するメニューを選ぶ</button>}
      </div>
      {armed && <div className="text-xs text-[#7a4f12] mt-1" role="status">選択中：台帳の行の置きたい時刻を押してください（もう一度チップを押すとやめます）</div>}
      {/* 影は body に出す（このパレットは backdrop-blur のため、中に fixed を置くと位置がずれる）。マウスの先に重ねる */}
      {ghost && typeof document !== "undefined" && createPortal(<div className="fixed z-[60] pointer-events-none px-2 py-1 rounded-full text-xs font-bold shadow-lg opacity-90 whitespace-nowrap" style={{ left: ghost.x, top: ghost.y, transform: "translate(-50%, -120%)", background: ghost.bg, color: ghost.fg }} data-testid="palette-ghost">{ghost.label}</div>, document.body)}
      {picking && <PickDialog current={menus.map(m => m.id)} all={allMenus} onClose={() => setPicking(false)} onSave={async ids => { await onSave(ids); setPicking(false); }} note={saveNote} />}
    </div>
  );
}

function PickDialog({ current, all, onClose, onSave, note }: { current: ID[]; all: Menu[]; onClose: () => void; onSave: (ids: ID[] | null) => Promise<void>; note?: string }) {
  const [ids, setIds] = useState<ID[]>(current);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const name = (id: ID) => { const m = all.find(x => x.id === id); return m ? m.short_name || m.name : "（削除されたメニュー）"; };
  const move = (i: number, d: number) => { const j = i + d; if (j < 0 || j >= ids.length) return; const a = [...ids]; [a[i], a[j]] = [a[j], a[i]]; setIds(a); };
  async function save(v: ID[] | null) { setBusy(true); setErr(""); try { await onSave(v); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }
  return (
    <div className="fixed inset-0 bg-black/30 z-[70] flex items-end sm:items-center justify-center" onClick={onClose}>
      <div role="dialog" aria-label="台帳に出すメニュー" className="bg-white w-full sm:max-w-lg rounded-t-xl sm:rounded-xl p-4 max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="font-bold mb-1">台帳に出すメニュー（この店舗）</div>
        <div className="text-xs text-ink-soft mb-2">チェックしたメニューがチップになります（最大{PALETTE_MAX}件）。並び順は ↑↓ で。IDLE・BREAK・×・保証 はいつも出ます。</div>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <div className="text-xs font-semibold text-ink-soft mb-1">メニュー</div>
            <div className="space-y-1">{all.map(m => {
              const on = ids.includes(m.id);
              return <label key={m.id} className="flex items-center gap-2 min-h-10 px-2 rounded border border-line text-sm">
                <input type="checkbox" checked={on} disabled={!on && ids.length >= PALETTE_MAX} onChange={() => setIds(on ? ids.filter(x => x !== m.id) : [...ids, m.id])} />
                <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ background: m.color || "#999" }} />
                <span className="truncate">{m.short_name || m.name}</span>{m.web_visible === false && <span className="chip bg-paper text-ink-mute border border-line">ネット非掲載</span>}
              </label>;
            })}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-ink-soft mb-1">並び順（{ids.length}件）</div>
            <ol className="space-y-1" data-testid="palette-order">{ids.map((id, i) => <li key={id} className="flex items-center gap-1 min-h-10 px-2 rounded bg-paper text-sm">
              <span className="w-5 text-ink-mute tabular-nums">{i + 1}</span><span className="flex-1 truncate">{name(id)}</span>
              <button type="button" className="btn-quiet !min-h-9" aria-label="上へ" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
              <button type="button" className="btn-quiet !min-h-9" aria-label="下へ" onClick={() => move(i, 1)} disabled={i === ids.length - 1}>↓</button>
            </li>)}</ol>
          </div>
        </div>
        {note && <div className="text-xs text-ink-soft mt-2">{note}</div>}
        {err && <div className="text-sm text-danger mt-2">{err}</div>}
        <div className="flex flex-wrap justify-between gap-2 mt-3">
          <button type="button" className="btn" disabled={busy} onClick={() => save(null)}>既定に戻す</button>
          <div className="flex gap-2"><button type="button" className="btn" onClick={onClose}>閉じる</button><button type="button" className="btn-primary" disabled={busy} onClick={() => save(ids)}>保存</button></div>
        </div>
      </div>
    </div>
  );
}
