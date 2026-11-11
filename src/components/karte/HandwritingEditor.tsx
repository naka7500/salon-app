"use client";
/* eslint-disable @next/next/no-img-element -- 背景の見本は data: URL と期限つきURL（next/image の最適化は使えない） */
// カルテの手書き（全画面）。iPad＋Apple Pencil／指を優先、マウスでも書ける。
// ペン（6色・3太さ・筆圧）／蛍光ペン／消しゴム（線ごと）／元に戻す・やり直し／全部消す／ページの追加・削除／背景（標準・店の背景・写真）。
// 0024：ページに画像を置ける（線の下のレイヤー。動かす・大きさを変える・消す。「完了」で固定してまた書ける）。
// 保存は「線のデータ（あとで書き直せる）」と「背景＋画像＋手書きを1枚にした画像（表示・印刷用）」の両方。
import { useCallback, useEffect, useRef, useState } from "react";
import { getRepo, KARTE_PAGE_IMAGES_MAX, type KarteBackground, type KarteInk, type KartePageBg, type KartePageDraft, type KartePageImageDraft, type KarteStroke } from "@/lib/db";
import { PAGE_W, PAGE_H, builtinByKey, builtinDataUrl, type BuiltinTemplate } from "@/lib/karteTemplates";
import { drawAll, drawStroke, drawBackground, emptyInk, flatten, hitStrokes, loadImage, resizeImage, type PlacedImage } from "./ink";

export interface EditorPage { id: string; ink: KarteInk; bg: KartePageBg; opacity: number; images: KartePageImageDraft[] }
interface PageState extends EditorPage { undo: KarteStroke[][]; redo: KarteStroke[][] }
type Tool = "pen" | "hl" | "eraser";
/** 置いた画像の最小の大きさ（ページ座標） */
const IMG_MIN = 40;
/** 画像の長い辺（px）。これより大きい写真は縮めてから置く（1枚 1MB 以下が目安） */
const IMG_MAX_PX = 1600;

const PEN_COLORS = [{ c: "#1d2823", n: "黒" }, { c: "#d32f2f", n: "赤" }, { c: "#1f5fbf", n: "青" }, { c: "#2d7d46", n: "緑" }, { c: "#d6488f", n: "ピンク" }, { c: "#8a5a2b", n: "茶" }];
const HL_COLORS = [{ c: "#ffd400", n: "黄" }, { c: "#ff7eb9", n: "ピンク" }, { c: "#7ee081", n: "緑" }, { c: "#7ec8ff", n: "水色" }];
const WIDTHS: Record<Tool, number[]> = { pen: [2.5, 5, 10], hl: [16, 28, 44], eraser: [10, 22, 40] };
const W_LABEL = ["細", "中", "太"];
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
export const blankPage = (bg: KartePageBg = { kind: "none" }): EditorPage => ({ id: newId(), ink: emptyInk(), bg, opacity: bg.kind === "photo" ? 0.6 : 1, images: [] });
const imgKey = (im: KartePageImageDraft) => im.blob ? `blob:${im.id}` : `p:${im.path}`;
const bgKey = (bg: KartePageBg) => bg.kind === "none" ? "none" : bg.kind === "builtin" ? `b:${bg.key}` : bg.kind === "template" ? `t:${bg.id}` : bg.blob ? `blob:${(bg.blob as Blob & { _k?: string })._k ||= newId()}` : `p:${bg.path}`;

export default function HandwritingEditor({ title, initial, builtins, templates, imagesReady = true, onCancel, onSave }: {
  title: string; initial: EditorPage[];
  /** 出す順に並べた標準の背景 */ builtins: BuiltinTemplate[];
  /** 店の背景テンプレ（非表示のものは、すでに使っているページの表示のためだけに入れる） */ templates: KarteBackground[];
  /** 画像レイヤーを使えるか（DB更新 0024 の後）。false のときは「画像」ボタンを出さない */ imagesReady?: boolean;
  onCancel: () => void; onSave: (pages: KartePageDraft[]) => Promise<void>;
}) {
  const repo = getRepo();
  const [pages, setPages] = useState<PageState[]>(() => (initial.length ? initial : [blankPage()]).map(p => ({ ...p, images: p.images ?? [], undo: [], redo: [] })));
  // 画像レイヤー（0024）：imgSel＝いま動かしている画像のID（null＝ペンで書ける）
  const [imgSel, setImgSel] = useState<string | null>(null);
  const [imgPanel, setImgPanel] = useState(false);
  const [imgUrls, setImgUrls] = useState<Record<string, string>>({});
  const [cur, setCur] = useState(0);
  const [tool, setTool] = useState<Tool>("pen");
  const [penColor, setPenColor] = useState(PEN_COLORS[0].c);
  const [hlColor, setHlColor] = useState(HL_COLORS[0].c);
  const [wIdx, setWIdx] = useState<Record<Tool, number>>({ pen: 1, hl: 1, eraser: 1 });
  const [penSeen, setPenSeen] = useState(false);
  const [fingerDraw, setFingerDraw] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [panel, setPanel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const [tplUrls, setTplUrls] = useState<Record<string, string>>({});

  const stageRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLCanvasElement>(null), inkRef = useRef<HTMLCanvasElement>(null), liveRef = useRef<HTMLCanvasElement>(null);
  const pagesRef = useRef(pages); const curRef = useRef(cur); const viewRef = useRef(view);
  const opt = useRef({ tool, penColor, hlColor, wIdx, penSeen, fingerDraw });
  useEffect(() => { pagesRef.current = pages; curRef.current = cur; viewRef.current = view; opt.current = { tool, penColor, hlColor, wIdx, penSeen, fingerDraw }; });
  const imgCache = useRef(new Map<string, Promise<HTMLImageElement | null>>());
  const imgSelRef = useRef(imgSel); useEffect(() => { imgSelRef.current = imgSel; });
  const page = pages[Math.min(cur, pages.length - 1)];

  // 置いた画像の表示URL：保存前＝blob の URL（作ったら使い回す）、保存済み＝期限つきURL（あとから取る）
  const blobUrls = useRef(new Map<string, string>());
  const urlPending = useRef(new Set<string>());
  const urlOf = (im: KartePageImageDraft) => {
    if (im.blob) { let u = blobUrls.current.get(im.id); if (!u) { u = URL.createObjectURL(im.blob); blobUrls.current.set(im.id, u); } return u; }
    return im.path ? imgUrls[im.path] || "" : "";
  };
  useEffect(() => {
    const need: string[] = [];
    for (const p of pages) for (const im of p.images) if (!im.blob && im.path && !imgUrls[im.path] && !urlPending.current.has(im.path)) { need.push(im.path); urlPending.current.add(im.path); }
    if (!need.length) return;
    repo.karteFileUrls(need).then(m => setImgUrls(q => ({ ...q, ...m }))).catch(() => {}).finally(() => need.forEach(x => urlPending.current.delete(x)));
  }, [pages, repo, imgUrls]);
  useEffect(() => { const m = blobUrls.current; return () => { m.forEach(u => URL.revokeObjectURL(u)); m.clear(); }; }, []);
  /** 置いた画像を描くための HTMLImageElement（同じものは使い回す） */
  const resolveImg = useCallback((im: KartePageImageDraft): Promise<HTMLImageElement | null> => {
    const k = imgKey(im); const hit = imgCache.current.get(k); if (hit) return hit;
    const pr = (async () => {
      const blob = im.blob ?? (im.path ? await repo.karteFileBlob(im.path) : null);
      if (!blob) return null;
      const u = URL.createObjectURL(blob); return loadImage(u).finally(() => URL.revokeObjectURL(u));   // 読み込んだら URL は返す（メモリ。L6）
    })().catch(() => { imgCache.current.delete(k); return null; });
    imgCache.current.set(k, pr); return pr;
  }, [repo]);

  // 店の背景テンプレの見本URL
  useEffect(() => {
    const paths = templates.map(t => t.image_path).filter((x): x is string => !!x);
    if (paths.length) repo.karteFileUrls(paths).then(setTplUrls).catch(() => {});
  }, [repo, templates]);

  // 背景の画像（同じものは使い回す）
  const resolveBg = useCallback((bg: KartePageBg): Promise<HTMLImageElement | null> => {
    const k = bgKey(bg); const hit = imgCache.current.get(k); if (hit) return hit;
    const pr = (async () => {
      if (bg.kind === "none") return null;
      if (bg.kind === "builtin") return builtinByKey(bg.key) ? loadImage(builtinDataUrl(bg.key)) : null;
      let blob: Blob | null = null;
      if (bg.kind === "template") { const t = templates.find(x => x.id === bg.id); if (t?.builtin_key) return loadImage(builtinDataUrl(t.builtin_key)); if (!t?.image_path) return null; blob = await repo.karteFileBlob(t.image_path); }
      else blob = bg.blob ?? (bg.path ? await repo.karteFileBlob(bg.path) : null);
      if (!blob) return null;
      const u = URL.createObjectURL(blob); return loadImage(u).finally(() => URL.revokeObjectURL(u));
    })().catch(() => { imgCache.current.delete(k); return null; });
    imgCache.current.set(k, pr); return pr;
  }, [repo, templates]);

  // 画面の大きさ
  useEffect(() => {
    const el = stageRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const fit = stage.w && stage.h ? Math.min((stage.w - 16) / PAGE_W, (stage.h - 16) / PAGE_H) : 0;
  const cssW = Math.max(1, Math.floor(PAGE_W * fit)), cssH = Math.max(1, Math.floor(PAGE_H * fit));
  const ox = (stage.w - cssW) / 2, oy = (stage.h - cssH) / 2;
  const [dpr, setDpr] = useState(1);
  useEffect(() => { void Promise.resolve().then(() => setDpr(Math.min(3, window.devicePixelRatio || 1))); }, []);
  const pxW = Math.round(cssW * dpr), pxH = Math.round(cssH * dpr);

  const prep = (cv: HTMLCanvasElement | null) => { if (!cv) return null; const ctx = cv.getContext("2d")!; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.setTransform(cv.width / PAGE_W, 0, 0, cv.height / PAGE_H, 0, 0); return ctx; };
  const redrawInk = useCallback((items: KarteStroke[]) => { const ctx = prep(inkRef.current); if (ctx) drawAll(ctx, items); }, []);
  // 線を描き直す
  useEffect(() => { if (page) redrawInk(page.ink.items); }, [page, pxW, pxH, redrawInk]);
  // 背景を描き直す
  const pBg = page?.bg, pOp = page?.opacity ?? 1;
  useEffect(() => {
    if (!pBg) return; let off = false;
    resolveBg(pBg).then(img => { if (off) return; const ctx = prep(bgRef.current); if (ctx) drawBackground(ctx, img, pOp); });
    return () => { off = true; };
  }, [pBg, pOp, pxW, pxH, resolveBg]);

  // ---- ページの更新 ----
  const updatePage = useCallback((i: number, f: (p: PageState) => PageState) => { setPages(ps => ps.map((p, j) => (j === i ? f(p) : p))); setDirty(true); }, []);
  const commit = useCallback((items: KarteStroke[], before: KarteStroke[]) => {
    updatePage(curRef.current, p => ({ ...p, ink: { ...p.ink, items }, undo: [...p.undo.slice(-99), before], redo: [] }));
  }, [updatePage]);
  const undo = useCallback(() => updatePage(curRef.current, p => p.undo.length ? { ...p, ink: { ...p.ink, items: p.undo[p.undo.length - 1] }, undo: p.undo.slice(0, -1), redo: [...p.redo, p.ink.items] } : p), [updatePage]);
  const redo = useCallback(() => updatePage(curRef.current, p => p.redo.length ? { ...p, ink: { ...p.ink, items: p.redo[p.redo.length - 1] }, redo: p.redo.slice(0, -1), undo: [...p.undo, p.ink.items] } : p), [updatePage]);

  // ---- 入力（Pointer Events）----
  const act = useRef<{ id: number; touch: boolean; last: { clientX: number; clientY: number }; kind: "draw" | "erase"; stroke?: KarteStroke; before: KarteStroke[]; items: KarteStroke[] } | null>(null);
  const nav = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; mx: number; my: number; z: number; x: number; y: number } | null>(null);
  const raf = useRef(0);

  const toPage = (cx: number, cy: number) => { const r = inkRef.current!.getBoundingClientRect(); return [(cx - r.left) / r.width * PAGE_W, (cy - r.top) / r.height * PAGE_H]; };
  const drawLive = () => {
    raf.current = 0; const a = act.current; const ctx = prep(liveRef.current);
    if (ctx && a?.stroke) drawStroke(ctx, a.stroke);
  };
  const schedule = () => { if (!raf.current) raf.current = requestAnimationFrame(drawLive); };
  const stagePt = (e: { clientX: number; clientY: number }) => { const r = stageRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const startPinch = () => {
    const pts = [...nav.current.values()]; const v = viewRef.current;
    if (pts.length >= 2) pinch.current = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1, mx: (pts[0].x + pts[1].x) / 2, my: (pts[0].y + pts[1].y) / 2, z: v.z, x: v.x, y: v.y };
    else if (pts.length === 1) pinch.current = { d: 0, mx: pts[0].x, my: pts[0].y, z: v.z, x: v.x, y: v.y };
    else pinch.current = null;
  };
  const cancelStroke = () => { act.current = null; prep(liveRef.current); };

  // ---- 画像レイヤーの操作（imgSel があるとき：1本＝移動／角＝大きさ／2本＝拡大・縮小） ----
  const imgPts = useRef(new Map<number, { x: number; y: number }>());
  const imgAct = useRef<{ id: string; mode: "move" | "resize" | "pinch"; start: { x: number; y: number; w: number; h: number }; p0: { x: number; y: number }; anchor?: { x: number; y: number }; d0?: number } | null>(null);
  const updateImage = (id: string, f: (im: KartePageImageDraft) => KartePageImageDraft) => updatePage(curRef.current, p => ({ ...p, images: p.images.map(im => (im.id === id ? f(im) : im)) }));
  const clampImg = (r: { x: number; y: number; w: number; h: number }) => {
    const w = Math.max(IMG_MIN, r.w), h = Math.max(IMG_MIN, r.h * (w / r.w));
    return { x: Math.min(PAGE_W - IMG_MIN, Math.max(IMG_MIN - w, r.x)), y: Math.min(PAGE_H - IMG_MIN, Math.max(IMG_MIN - h, r.y)), w, h };
  };
  /** 角のつまみに触れたか（画面上 26px 以内）→ その角の向かいの角（固定する角） */
  const cornerHit = (im: KartePageImageDraft, x: number, y: number) => {
    const tol = 26 / (fit * (viewRef.current.z || 1));
    const cs = [[im.x, im.y, im.x + im.w, im.y + im.h], [im.x + im.w, im.y, im.x, im.y + im.h], [im.x, im.y + im.h, im.x + im.w, im.y], [im.x + im.w, im.y + im.h, im.x, im.y]];
    for (const [cx, cy, ax, ay] of cs) if (Math.hypot(x - cx, y - cy) <= tol) return { x: ax, y: ay };
    return null;
  };
  const inImg = (im: KartePageImageDraft, x: number, y: number) => x >= im.x && x <= im.x + im.w && y >= im.y && y <= im.y + im.h;
  function imgDown(e: React.PointerEvent): boolean {
    const sel = imgSelRef.current; if (!sel) return false;
    const pg = pagesRef.current[curRef.current]; const im = pg.images.find(i => i.id === sel);
    if (!im) { setImgSel(null); return false; }
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
    const [x, y] = toPage(e.clientX, e.clientY);
    imgPts.current.set(e.pointerId, { x, y });
    if (imgPts.current.size >= 2) {
      const pts = [...imgPts.current.values()];
      imgAct.current = { id: sel, mode: "pinch", start: { x: im.x, y: im.y, w: im.w, h: im.h }, p0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }, d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1 };
      return true;
    }
    const anchor = cornerHit(im, x, y);
    if (anchor) imgAct.current = { id: sel, mode: "resize", start: { x: im.x, y: im.y, w: im.w, h: im.h }, p0: { x, y }, anchor };
    else if (inImg(im, x, y)) imgAct.current = { id: sel, mode: "move", start: { x: im.x, y: im.y, w: im.w, h: im.h }, p0: { x, y } };
    else {
      // ほかの画像に触れたら、そちらを選ぶ（上にある＝あとに置いた物を優先）
      const other = [...pg.images].reverse().find(i => i.id !== sel && inImg(i, x, y));
      if (other) { setImgSel(other.id); imgAct.current = { id: other.id, mode: "move", start: { x: other.x, y: other.y, w: other.w, h: other.h }, p0: { x, y } }; }
      else imgAct.current = null;
    }
    e.preventDefault(); return true;
  }
  function imgMove(e: React.PointerEvent): boolean {
    if (!imgPts.current.has(e.pointerId)) return false;
    const [x, y] = toPage(e.clientX, e.clientY); imgPts.current.set(e.pointerId, { x, y });
    const a = imgAct.current; if (!a) return true;
    if (a.mode === "pinch") {
      const pts = [...imgPts.current.values()]; if (pts.length < 2) return true;
      const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y); const s = Math.max(0.05, d / (a.d0 || 1));
      const m = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const c0 = { x: a.start.x + a.start.w / 2, y: a.start.y + a.start.h / 2 };
      const c = { x: c0.x + (m.x - a.p0.x), y: c0.y + (m.y - a.p0.y) };
      const w = a.start.w * s, h = a.start.h * s;
      updateImage(a.id, im => ({ ...im, ...clampImg({ x: c.x - w / 2, y: c.y - h / 2, w, h }) }));
    } else if (a.mode === "move") {
      updateImage(a.id, im => ({ ...im, ...clampImg({ ...a.start, x: a.start.x + (x - a.p0.x), y: a.start.y + (y - a.p0.y) }) }));
    } else if (a.mode === "resize" && a.anchor) {
      // 固定する角から指までの大きさ（縦横の比は保つ）
      const ar = a.start.w / a.start.h; const dx = Math.abs(x - a.anchor.x), dy = Math.abs(y - a.anchor.y);
      let w = Math.max(IMG_MIN, Math.max(dx, dy * ar)); let h = w / ar;
      if (h < IMG_MIN) { h = IMG_MIN; w = h * ar; }
      const nx = x < a.anchor.x ? a.anchor.x - w : a.anchor.x, ny = y < a.anchor.y ? a.anchor.y - h : a.anchor.y;
      updateImage(a.id, im => ({ ...im, x: nx, y: ny, w, h }));
    }
    return true;
  }
  function imgUp(e: React.PointerEvent): boolean {
    if (!imgPts.current.has(e.pointerId)) return false;
    imgPts.current.delete(e.pointerId);
    if (imgPts.current.size === 0) imgAct.current = null;
    else if (imgPts.current.size === 1 && imgAct.current?.mode === "pinch") {
      // 1本になったら、その位置から移動に切り替える
      const im = pagesRef.current[curRef.current].images.find(i => i.id === imgAct.current!.id); const p = [...imgPts.current.values()][0];
      imgAct.current = im ? { id: im.id, mode: "move", start: { x: im.x, y: im.y, w: im.w, h: im.h }, p0: p } : null;
    }
    return true;
  }
  function roundImg(im: KartePageImageDraft): KartePageImageDraft { return { ...im, x: r1(im.x), y: r1(im.y), w: r1(im.w), h: r1(im.h) }; }

  function onDown(e: React.PointerEvent) {
    const o = opt.current;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (imgDown(e)) return;
    if (e.pointerType === "pen" && !o.penSeen) { setPenSeen(true); o.penSeen = true; }
    const touchNav = e.pointerType === "touch" && ((o.penSeen && !o.fingerDraw) || nav.current.size > 0 || !!act.current?.touch);
    if (touchNav) {
      // 2本目の指が来たら書きかけの線は取り消して、拡大・移動にする
      const a = act.current;
      if (a && a.touch) { if (a.kind === "erase" && a.items !== a.before) redrawInk(a.before); cancelStroke(); nav.current.set(a.id, stagePt(a.last)); }
      nav.current.set(e.pointerId, stagePt(e)); startPinch();
      try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
      return;
    }
    if (act.current) return;
    try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {}
    const [x, y] = toPage(e.clientX, e.clientY);
    const items = pagesRef.current[curRef.current].ink.items;
    if (o.tool === "eraser") {
      act.current = { id: e.pointerId, touch: e.pointerType === "touch", last: { clientX: e.clientX, clientY: e.clientY }, kind: "erase", before: items, items };
      eraseAt(x, y);
    } else {
      const pr = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
      const stroke: KarteStroke = { t: o.tool, c: o.tool === "pen" ? o.penColor : o.hlColor, w: WIDTHS[o.tool][o.wIdx[o.tool]], p: [r1(x), r1(y), r2(pr)] };
      act.current = { id: e.pointerId, touch: e.pointerType === "touch", last: { clientX: e.clientX, clientY: e.clientY }, kind: "draw", stroke, before: items, items };
      schedule();
    }
    e.preventDefault();
  }
  function eraseAt(x: number, y: number) {
    const a = act.current!; const r = WIDTHS.eraser[opt.current.wIdx.eraser];
    const hits = hitStrokes(a.items, x, y, r);
    if (hits.length) { const set = new Set(hits); a.items = a.items.filter((_, i) => !set.has(i)); redrawInk(a.items); }
  }
  function onMove(e: React.PointerEvent) {
    if (imgMove(e)) return;
    if (nav.current.has(e.pointerId)) {
      nav.current.set(e.pointerId, stagePt(e)); const pc = pinch.current; if (!pc) return;
      const pts = [...nav.current.values()];
      if (pts.length >= 2 && pc.d) {
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y); const mx = (pts[0].x + pts[1].x) / 2, my = (pts[0].y + pts[1].y) / 2;
        const z = Math.max(1, Math.min(4, pc.z * d / pc.d));
        const lx = (pc.mx - ox - pc.x) / pc.z, ly = (pc.my - oy - pc.y) / pc.z;
        setView(clampView({ z, x: mx - ox - z * lx, y: my - oy - z * ly }));
      } else if (pts.length === 1 && viewRef.current.z > 1) {
        setView(clampView({ z: pc.z, x: pc.x + pts[0].x - pc.mx, y: pc.y + pts[0].y - pc.my }));
      }
      return;
    }
    const a = act.current; if (!a || a.id !== e.pointerId) return;
    const ne = e.nativeEvent as PointerEvent;
    const list = typeof ne.getCoalescedEvents === "function" ? ne.getCoalescedEvents() : [];
    const evs = list.length ? list : [ne];
    a.last = { clientX: e.clientX, clientY: e.clientY };
    for (const ev of evs) {
      const [x, y] = toPage(ev.clientX, ev.clientY);
      if (a.kind === "erase") { eraseAt(x, y); continue; }
      const p = a.stroke!.p; const lx = p[p.length - 3], ly = p[p.length - 2];
      if (Math.hypot(x - lx, y - ly) < 0.8) continue;
      p.push(r1(x), r1(y), r2(ev.pointerType === "pen" && ev.pressure > 0 ? ev.pressure : 0.5));
    }
    if (a.kind === "draw") schedule();
  }
  function onUp(e: React.PointerEvent) {
    if (imgUp(e)) return;
    if (nav.current.has(e.pointerId)) { nav.current.delete(e.pointerId); startPinch(); return; }
    const a = act.current; if (!a || a.id !== e.pointerId) return;
    act.current = null;
    if (a.kind === "erase") { if (a.items.length !== a.before.length) commit(a.items, a.before); return; }
    if (e.type === "pointercancel" && a.stroke!.p.length < 9) { prep(liveRef.current); return; }
    const items = [...a.before, a.stroke!];
    redrawInk(items); prep(liveRef.current); commit(items, a.before);
  }
  const clampView = (v: { z: number; x: number; y: number }) => {
    if (v.z <= 1.001) return { z: 1, x: 0, y: 0 };
    const minX = cssW - cssW * v.z - ox * 0.8, minY = cssH - cssH * v.z - oy * 0.8;
    return { z: v.z, x: Math.min(ox * 0.8, Math.max(minX, v.x)), y: Math.min(oy * 0.8, Math.max(minY, v.y)) };
  };

  // キー操作：⌘Z／Ctrl+Z＝元に戻す、⇧⌘Z＝やり直し
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k);
  }, [undo, redo]);
  // 開いている間は後ろの画面をスクロールさせない
  useEffect(() => { const o = document.body.style.overflow; document.body.style.overflow = "hidden"; return () => { document.body.style.overflow = o; }; }, []);

  // ---- ページ ----
  function addPage() { const bg = page?.bg.kind === "builtin" || page?.bg.kind === "template" ? page.bg : { kind: "none" as const }; setPages(ps => [...ps, { ...blankPage(bg), undo: [], redo: [] }]); setCur(pages.length); setDirty(true); setView({ z: 1, x: 0, y: 0 }); setImgSel(null); }
  function deletePage() {
    if (pages.length <= 1) { if ((page.ink.items.length || page.images.length) && !confirm("このページの手書きと画像を全部消しますか？")) return; commit([], page.ink.items); updatePage(cur, p => ({ ...p, bg: { kind: "none" }, opacity: 1, images: [] })); setImgSel(null); return; }
    if (!confirm(`${cur + 1}ページ目を削除しますか？（保存するまでは元に戻せます：閉じて保存しなければ消えません）`)) return;
    setPages(ps => ps.filter((_, i) => i !== cur)); setCur(Math.max(0, cur - 1)); setDirty(true); setImgSel(null);
  }
  // ---- 画像レイヤー（0024） ----
  async function addImage(f: File | undefined) {
    if (!f) return;
    if (page.images.length >= KARTE_PAGE_IMAGES_MAX) { setMsg(`1ページに置ける画像は${KARTE_PAGE_IMAGES_MAX}枚までです`); return; }
    try {
      setMsg("画像を準備中…");
      const blob = await resizeImage(f, IMG_MAX_PX, 0.85);
      const u = URL.createObjectURL(blob); const img = await loadImage(u).finally(() => URL.revokeObjectURL(u));
      // 最初はページの6割の大きさで真ん中に（縦横の比はそのまま）
      const sc = Math.min((PAGE_W * 0.6) / img.naturalWidth, (PAGE_H * 0.6) / img.naturalHeight);
      const w = r1(img.naturalWidth * sc), h = r1(img.naturalHeight * sc);
      const im: KartePageImageDraft = { id: newId(), blob, x: r1((PAGE_W - w) / 2), y: r1((PAGE_H - h) / 2), w, h };
      updatePage(cur, p => ({ ...p, images: [...p.images, im] }));
      setImgSel(im.id); setImgPanel(false); setMsg("");
    } catch (e) { setMsg((e as Error).message); }
  }
  function deleteImage(id: string) {
    if (!confirm("この画像を消しますか？（保存するまでは、閉じて保存しなければ元のままです）")) return;
    updatePage(cur, p => ({ ...p, images: p.images.filter(im => im.id !== id) }));
    if (imgSel === id) setImgSel(null);
  }
  function finishImage() { if (imgSel) updateImage(imgSel, roundImg); setImgSel(null); }
  const setBg = (bg: KartePageBg, opacity?: number) => { updatePage(cur, p => ({ ...p, bg, opacity: opacity ?? (bg.kind === "photo" ? 0.6 : p.bg.kind === "photo" ? 1 : p.opacity) })); };
  async function pickPhoto(f: File | undefined) {
    if (!f) return;
    try { setMsg("写真を準備中…"); const blob = await resizeImage(f, 2000, 0.85); setBg({ kind: "photo", blob }, 0.6); setPanel(false); setMsg(""); }
    catch (e) { setMsg((e as Error).message); }
  }

  async function save() {
    setSaving(true); setMsg("");
    try {
      const out: KartePageDraft[] = [];
      for (const p of pagesRef.current) {
        const img = await resolveBg(p.bg);
        if (p.bg.kind !== "none" && !img) throw new Error("背景の画像を読み込めないページがあります。背景を選び直してください");
        const placed: PlacedImage[] = [];
        for (const im of p.images) { const el = await resolveImg(im); if (!el) throw new Error("置いた画像を読み込めないページがあります。その画像を消すか、置き直してください"); placed.push({ img: el, x: im.x, y: im.y, w: im.w, h: im.h }); }
        out.push({ id: p.id, strokes: p.ink, bg: p.bg, opacity: p.opacity, images: p.images.map(roundImg), image: await flatten(p.ink, img, p.opacity, p.bg.kind === "photo", placed) });
      }
      await onSave(out);
      setDirty(false);
    } catch (e) { setMsg((e as Error).message || "保存できませんでした"); }
    finally { setSaving(false); }
  }
  function close() { if (dirty && !confirm("保存せずに閉じますか？（書いた内容は消えます）")) return; onCancel(); }

  const colors = tool === "hl" ? HL_COLORS : PEN_COLORS;
  const curColor = tool === "hl" ? hlColor : penColor;
  const activeTpls = templates.filter(t => t.active && !t.builtin_key && t.image_path);
  const selImg = imgSel ? page?.images.find(im => im.id === imgSel) ?? null : null;
  const bgLabel = !page ? "" : page.bg.kind === "none" ? "背景なし" : page.bg.kind === "builtin" ? (builtinByKey(page.bg.key)?.name || "標準の背景") : page.bg.kind === "template" ? (templates.find(t => t.id === (page.bg as { id: string }).id)?.name || "店の背景") : "写真";

  return (
    <div className="fixed inset-0 z-[60] bg-[#e9ece9] flex flex-col select-none" role="dialog" aria-modal="true" aria-label={`手書き：${title}`} data-testid="hw-editor">
      {/* 上の道具 */}
      <div className="bg-white border-b border-line px-2 py-1.5 flex flex-wrap items-center gap-1.5">
        <button className="btn" onClick={close}>閉じる</button>
        <div className="text-sm font-semibold text-ink truncate max-w-[14rem] mr-1 hidden xl:block">{title}</div>
        <div className="seg" role="group" aria-label="道具">
          {([["pen", "ペン"], ["hl", "蛍光ペン"], ["eraser", "消しゴム"]] as const).map(([t, l]) => <button key={t} aria-pressed={tool === t} onClick={() => setTool(t)}>{l}</button>)}
        </div>
        {tool !== "eraser" && <div className="flex items-center gap-1" role="group" aria-label="色">
          {colors.map(c => <button key={c.c} aria-label={`色：${c.n}`} aria-pressed={curColor === c.c} onClick={() => (tool === "hl" ? setHlColor(c.c) : setPenColor(c.c))}
            className={`w-9 h-9 rounded-full border-2 grid place-items-center ${curColor === c.c ? "border-canopy" : "border-transparent"}`}><span className="w-6 h-6 rounded-full border border-black/10" style={{ background: c.c }} /></button>)}
        </div>}
        <div className="flex items-center gap-0.5" role="group" aria-label="太さ">
          {WIDTHS[tool].map((w, i) => <button key={i} aria-label={`太さ：${W_LABEL[i]}`} aria-pressed={wIdx[tool] === i} onClick={() => setWIdx({ ...wIdx, [tool]: i })}
            className={`w-10 h-10 rounded-[var(--radius-ctl)] grid place-items-center ${wIdx[tool] === i ? "bg-moss ring-1 ring-canopy" : "hover:bg-moss"}`}>
            <span className="rounded-full" style={{ width: Math.min(26, 4 + i * 7), height: Math.min(26, 4 + i * 7), background: tool === "eraser" ? "transparent" : curColor, border: tool === "eraser" ? "1.5px dashed #4a5750" : tool === "hl" ? "none" : "none", opacity: tool === "hl" ? 0.6 : 1 }} />
          </button>)}
        </div>
        <div className="flex items-center gap-1 ml-auto">
          <button className="btn w-11 text-lg" aria-label="元に戻す" title="元に戻す" disabled={!page?.undo.length} onClick={undo}>↶</button>
          <button className="btn w-11 text-lg" aria-label="やり直し" title="やり直し" disabled={!page?.redo.length} onClick={redo}>↷</button>
          <button className="btn" onClick={() => { if (page.ink.items.length) commit([], page.ink.items); }} disabled={!page?.ink.items.length}>全部消す</button>
          {imagesReady && <button className="btn" aria-expanded={imgPanel} data-testid="img-btn" onClick={() => { setImgPanel(!imgPanel); setPanel(false); }}>画像{page?.images.length ? `(${page.images.length})` : ""}</button>}
          <button className="btn" aria-expanded={panel} onClick={() => { setPanel(!panel); setImgPanel(false); }}>背景</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? "保存中…" : "保存"}</button>
        </div>
      </div>

      {/* 書くところ */}
      <div className="relative flex-1 min-h-0">
        <div ref={stageRef} className="absolute inset-0 overflow-hidden touch-none" style={{ touchAction: "none" }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={e => e.preventDefault()}>
          {fit > 0 && <div className="absolute shadow-[0_1px_4px_rgba(0,0,0,.18)] bg-white overflow-hidden" style={{ left: ox, top: oy, width: cssW, height: cssH, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
            <canvas ref={bgRef} width={pxW} height={pxH} className="absolute inset-0 w-full h-full" />
            {/* 置いた画像（線の下） */}
            {page?.images.map(im => <img key={im.id} src={urlOf(im) || ""} alt="" draggable={false} data-testid="page-image"
              className="absolute pointer-events-none select-none" style={{ left: im.x * fit, top: im.y * fit, width: im.w * fit, height: im.h * fit, opacity: urlOf(im) ? 1 : 0 }} />)}
            <canvas ref={inkRef} width={pxW} height={pxH} className="absolute inset-0 w-full h-full" data-testid="ink-canvas" />
            <canvas ref={liveRef} width={pxW} height={pxH} className="absolute inset-0 w-full h-full" style={{ cursor: imgSel ? "move" : tool === "eraser" ? "cell" : "crosshair" }} />
            {/* 選んでいる画像の枠と角のつまみ（操作はステージ側で受ける） */}
            {selImg && <div className="absolute pointer-events-none border-2 border-canopy" style={{ left: selImg.x * fit, top: selImg.y * fit, width: selImg.w * fit, height: selImg.h * fit, boxShadow: "0 0 0 1px #fff" }} data-testid="img-selection">
              {[[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy]) => <span key={`${cx}${cy}`} className="absolute w-5 h-5 rounded-full bg-white border-2 border-canopy" style={{ left: `calc(${cx * 100}% - 10px)`, top: `calc(${cy * 100}% - 10px)`, transform: `scale(${1 / view.z})` }} />)}
            </div>}
          </div>}
        </div>
        {msg && <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-white border border-line rounded px-3 py-1.5 text-sm shadow" role="status">{msg}</div>}
        {view.z > 1 && !imgSel && <button className="btn absolute top-2 right-2" onClick={() => setView({ z: 1, x: 0, y: 0 })}>等倍に戻す</button>}
        {/* 画像を動かしているとき */}
        {imgSel && <div className="absolute left-1/2 -translate-x-1/2 bottom-2 bg-white border border-line rounded-[var(--radius-sheet)] shadow-lg px-3 py-2 flex items-center gap-2 max-w-[96vw] whitespace-nowrap" data-testid="img-editbar" onPointerDown={e => e.stopPropagation()}>
          <span className="text-xs text-ink-soft"><span className="hidden sm:inline">画像を編集中：ドラッグで移動・角で大きさ・2本指で拡大</span><span className="sm:hidden">画像を編集中</span></span>
          <button className="btn-quiet text-danger" onClick={() => deleteImage(imgSel)}>削除</button>
          <button className="btn-primary" onClick={finishImage} data-testid="img-done">完了</button>
        </div>}

        {/* 画像を置く・一覧 */}
        {imgPanel && <div className="absolute top-0 right-0 bottom-0 w-[min(340px,92vw)] bg-white border-l border-line shadow-lg flex flex-col" data-testid="img-panel" onPointerDown={e => e.stopPropagation()}>
          <div className="flex items-center px-3 py-2 border-b border-line"><div className="font-bold">画像（{cur + 1}ページ目）</div><button className="btn-quiet ml-auto" onClick={() => setImgPanel(false)}>閉じる</button></div>
          <div className="overflow-y-auto p-3 space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <label className={`btn cursor-pointer ${page && page.images.length >= KARTE_PAGE_IMAGES_MAX ? "opacity-40 pointer-events-none" : ""}`}>カメラで撮る<input type="file" accept="image/*" capture="environment" className="sr-only" onChange={e => { void addImage(e.target.files?.[0]); e.target.value = ""; }} /></label>
              <label className={`btn cursor-pointer ${page && page.images.length >= KARTE_PAGE_IMAGES_MAX ? "opacity-40 pointer-events-none" : ""}`}>写真から選ぶ<input type="file" accept="image/*" className="sr-only" data-testid="img-file" onChange={e => { void addImage(e.target.files?.[0]); e.target.value = ""; }} /></label>
            </div>
            <div className="text-[11px] text-ink-mute">画像は線の下に置かれます。置いたあとは指やマウスで動かし、角で大きさを変えられます。「完了」を押すと固定され、その上にペンで書けます（1ページ{KARTE_PAGE_IMAGES_MAX}枚まで・長い辺{IMG_MAX_PX}pxに縮めて保存）。</div>
            {page && page.images.length > 0 && <div className="space-y-2">
              <div className="text-xs font-semibold text-ink-soft">このページの画像</div>
              {page.images.map((im, i) => <div key={im.id} className={`flex items-center gap-2 border rounded-[var(--radius-ctl)] p-1.5 ${imgSel === im.id ? "border-canopy bg-moss" : "border-line"}`} data-testid="img-row">
                <div className="w-16 h-12 bg-paper border border-line rounded overflow-hidden grid place-items-center">{urlOf(im) ? <img src={urlOf(im)} alt="" className="max-w-full max-h-full object-contain" /> : null}</div>
                <div className="text-sm flex-1">画像{i + 1}</div>
                <button className="btn text-xs" onClick={() => { setImgSel(im.id); setImgPanel(false); }}>動かす</button>
                <button className="btn-quiet text-danger text-xs" onClick={() => deleteImage(im.id)}>削除</button>
              </div>)}
            </div>}
          </div>
        </div>}

        {/* 背景を選ぶ */}
        {panel && <div className="absolute top-0 right-0 bottom-0 w-[min(380px,92vw)] bg-white border-l border-line shadow-lg flex flex-col" data-testid="bg-panel" onPointerDown={e => e.stopPropagation()}>
          <div className="flex items-center px-3 py-2 border-b border-line"><div className="font-bold">背景（{cur + 1}ページ目）</div><button className="btn-quiet ml-auto" onClick={() => setPanel(false)}>閉じる</button></div>
          <div className="overflow-y-auto p-3 space-y-3">
            <div>
              <div className="lbl">背景の濃さ（手書きが見やすいように薄くできます）</div>
              <div className="flex items-center gap-2"><input type="range" min={10} max={100} step={5} value={Math.round((page?.opacity ?? 1) * 100)} aria-label="背景の濃さ" className="flex-1 accent-[var(--color-canopy)]"
                onChange={e => updatePage(cur, p => ({ ...p, opacity: Number(e.target.value) / 100 }))} disabled={page?.bg.kind === "none"} /><span className="text-sm w-12 text-right tabular-nums">{Math.round((page?.opacity ?? 1) * 100)}%</span></div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="btn cursor-pointer">カメラで撮る<input type="file" accept="image/*" capture="environment" className="sr-only" onChange={e => { void pickPhoto(e.target.files?.[0]); e.target.value = ""; }} /></label>
              <label className="btn cursor-pointer">写真から選ぶ<input type="file" accept="image/*" className="sr-only" data-testid="bg-file" onChange={e => { void pickPhoto(e.target.files?.[0]); e.target.value = ""; }} /></label>
            </div>
            <BgChoice label="背景なし" selected={page?.bg.kind === "none"} onClick={() => setBg({ kind: "none" }, 1)} />
            <div className="text-xs font-semibold text-ink-soft pt-1">標準の背景</div>
            <div className="grid grid-cols-2 gap-2">
              {builtins.map(t => <BgChoice key={t.key} label={t.name} img={builtinDataUrl(t.key)} selected={page?.bg.kind === "builtin" && page.bg.key === t.key} onClick={() => setBg({ kind: "builtin", key: t.key }, 1)} />)}
            </div>
            {activeTpls.length > 0 && <>
              <div className="text-xs font-semibold text-ink-soft pt-1">お店の背景</div>
              <div className="grid grid-cols-2 gap-2">
                {activeTpls.map(t => <BgChoice key={t.id} label={t.name} img={tplUrls[t.image_path!]} selected={page?.bg.kind === "template" && page.bg.id === t.id} onClick={() => setBg({ kind: "template", id: t.id }, 1)} />)}
              </div>
            </>}
            <div className="text-[11px] text-ink-mute">写真は長い辺2000pxに縮めてから保存します。お店の背景は 設定＞カルテ背景 で追加できます（オーナー・店長）。</div>
          </div>
        </div>}
      </div>

      {/* 下：ページ */}
      <div className="bg-white border-t border-line px-2 py-1.5 flex flex-wrap items-center gap-1.5">
        <div className="flex items-center gap-1 overflow-x-auto" role="tablist" aria-label="ページ">
          {pages.map((p, i) => <button key={p.id} role="tab" aria-selected={i === cur} aria-label={`${i + 1}ページ目`} onClick={() => { setCur(i); setView({ z: 1, x: 0, y: 0 }); setImgSel(null); }}
            className={`min-w-11 h-10 px-2 rounded-[var(--radius-ctl)] border text-sm ${i === cur ? "bg-canopy text-white border-canopy font-semibold" : "bg-white border-line-strong"}`}>{i + 1}</button>)}
          <button className="btn" onClick={addPage} disabled={pages.length >= 20}>＋ページ</button>
        </div>
        <button className="btn-quiet text-danger" onClick={deletePage}>{pages.length > 1 ? "このページを削除" : "このページを白紙に"}</button>
        <span className="text-xs text-ink-soft ml-1 truncate">{bgLabel}{page && page.bg.kind !== "none" && ` ・濃さ${Math.round(page.opacity * 100)}%`}{page && page.images.length > 0 && ` ・画像${page.images.length}枚`}</span>
        <div className="ml-auto flex items-center gap-2 text-xs text-ink-soft">
          {penSeen ? <label className="flex items-center gap-1.5"><input type="checkbox" className="w-5 h-5" checked={fingerDraw} onChange={e => setFingerDraw(e.target.checked)} />指でも書く</label> : null}
          <span className="hidden sm:inline">{penSeen && !fingerDraw ? "ペンで書く・指は2本で拡大／1本で移動" : "2本指で拡大・移動"}</span>
        </div>
      </div>
    </div>
  );
}
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

function BgChoice({ label, img, selected, onClick }: { label: string; img?: string; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={selected} className={`text-left rounded-[var(--radius-ctl)] border p-1.5 w-full ${selected ? "border-canopy ring-2 ring-canopy/30 bg-moss" : "border-line-strong bg-white hover:bg-moss"}`}>
      {img !== undefined && <div className="aspect-[1414/1000] bg-paper rounded overflow-hidden mb-1 border border-line">{img ? <img src={img} alt="" className="w-full h-full object-contain" /> : null}</div>}
      <div className="text-xs text-ink leading-tight">{label}</div>
    </button>
  );
}
