"use client";
/* eslint-disable @next/next/no-img-element -- 背景の見本は data: URL と期限つきURL */
// 設定＞カルテ背景（owner/manager）：カルテの手書きの背景に使う画像。標準の線画の表示・非表示と、お店の画像の追加・並べ替え・使う店舗
import { useCallback, useEffect, useState } from "react";
import { getRepo, type KarteBackground, type Store } from "@/lib/db";
import { builtinDataUrl, builtinOrder, builtinByKey } from "@/lib/karteTemplates";
import { resizeImage } from "@/components/karte/ink";
import { SettingsFrame, useAdmin, Field } from "../SettingsParts";

const BT_LABEL: Record<string, string> = { eyelash: "まつげ", headspa: "ヘッドスパ", hair: "ヘア" };

export default function KarteBgSettingsPage() {
  const repo = getRepo();
  const { isAdmin, caps } = useAdmin();
  const [store, setStore] = useState<Store | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [rows, setRows] = useState<KarteBackground[] | null>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState<{ name: string; store_id: string; blob: Blob | null; url: string }>({ name: "", store_id: "", blob: null, url: "" });

  const load = useCallback(async () => {
    const r = await repo.karteBackgrounds(true).catch(() => null);
    setRows(r);
    const paths = (r || []).map(x => x.image_path).filter((x): x is string => !!x);
    if (paths.length) setUrls(await repo.karteFileUrls(paths).catch(() => ({})));
  }, [repo]);
  useEffect(() => {
    void Promise.resolve().then(load);
    repo.store().then(st => { setStore(st); repo.stores().then(ss => setStores(ss.filter(x => x.company_id === st.company_id))).catch(() => {}); });
  }, [repo, load]);
  const ready = !!caps?.karte10 && rows !== null;
  const builtinRows = new Map((rows || []).filter(r => r.builtin_key).map(r => [r.builtin_key!, r]));
  const own = (rows || []).filter(r => !r.builtin_key);

  async function run(f: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg("");
    try { await f(); setMsg(ok); await load(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  const toggleBuiltin = (key: string, active: boolean) => { const r = builtinRows.get(key); const t = builtinByKey(key)!; return run(() => repo.saveKarteBackground({ id: r?.id, builtin_key: key, name: r?.name || t.name, active, store_id: null }), active ? `「${t.name}」を手書き画面に出します` : `「${t.name}」を手書き画面に出さないようにしました`); };
  async function pick(f: File | undefined) {
    if (!f) return;
    try { const blob = await resizeImage(f, 2000, 0.85); if (add.url) URL.revokeObjectURL(add.url); setAdd({ ...add, blob, url: URL.createObjectURL(blob), name: add.name || f.name.replace(/\.[^.]+$/, "").slice(0, 40) }); }
    catch (e) { setMsg((e as Error).message); }
  }
  async function addOne() {
    if (!add.blob) { setMsg("画像を選んでください"); return; }
    if (!add.name.trim()) { setMsg("名前を入れてください"); return; }
    await run(() => repo.saveKarteBackground({ name: add.name.trim(), store_id: add.store_id || null, active: true }, add.blob), `「${add.name.trim()}」を追加しました`);
    if (add.url) URL.revokeObjectURL(add.url); setAdd({ name: "", store_id: "", blob: null, url: "" });
  }
  async function move(i: number, d: number) {
    const a = own[i], b = own[i + d]; if (!a || !b) return;
    await run(async () => { await repo.saveKarteBackground({ ...a, sort_order: b.sort_order }); await repo.saveKarteBackground({ ...b, sort_order: a.sort_order === b.sort_order ? a.sort_order + d : a.sort_order }); }, "並べ替えました");
  }
  async function replace(r: KarteBackground, f: File | undefined) { if (!f) return; const blob = await resizeImage(f, 2000, 0.85); await run(() => repo.saveKarteBackground({ ...r }, blob), `「${r.name}」の画像を差し替えました`); }
  const storeName = (sid: string | null) => (sid ? stores.find(s => s.id === sid)?.name || "（別の店舗）" : "全店舗");

  return (
    <SettingsFrame title="設定" isAdmin={isAdmin} notReady={caps && !ready && "お店の背景（画像のアップロード）と、標準の背景の表示・非表示は準備中です（DB更新 0010 の後に使えます）。標準の背景（線画）は今もカルテの手書き画面で使えます。"}>
      <div className="space-y-3">
        <div className="card">
          <div className="font-bold mb-1">標準の背景（線画）</div>
          <div className="text-xs text-ink-soft mb-3">アプリに入っている背景です。{store && <>この店舗（{BT_LABEL[store.business_type] || store.business_type}）では、この順番で手書き画面に出ます。</>}チェックを外すと、手書き画面に出なくなります（会社の全店舗で共通）。</div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {builtinOrder(store?.business_type).map(key => { const t = builtinByKey(key)!; const on = builtinRows.get(key)?.active !== false; return (
              <div key={key} data-testid={`builtin-${key}`} className={`rounded-[var(--radius-sheet)] border p-2 ${on ? "border-line" : "border-dashed border-line-strong opacity-60"}`}>
                <div className="aspect-[1414/1000] bg-white border border-line rounded overflow-hidden"><img src={builtinDataUrl(key)} alt={t.name} className="w-full h-full object-contain" /></div>
                <div className="text-sm font-semibold mt-1.5">{t.name}</div>
                <div className="text-[11px] text-ink-mute">{t.hint}</div>
                <label className="flex items-center gap-2 text-sm mt-1.5"><input type="checkbox" className="w-5 h-5" checked={on} disabled={!ready || busy} onChange={e => void toggleBuiltin(key, e.target.checked)} />手書き画面に出す</label>
              </div>); })}
          </div>
        </div>

        <div className="card">
          <div className="font-bold mb-1">お店の背景（画像）</div>
          <div className="text-xs text-ink-soft mb-3">お店で作ったカルテ用紙・デザイン表などの画像を追加できます。長い辺2000pxに縮めて保存します（PNG・JPEG）。使う店舗を「全店舗」にすると、会社のどの店舗でも使えます。</div>
          <div className="grid md:grid-cols-[220px_1fr] gap-3 items-start border border-line rounded-[var(--radius-sheet)] p-3 mb-3 bg-paper" data-testid="bg-add">
            <div className="aspect-[1414/1000] bg-white border border-line rounded grid place-items-center overflow-hidden">{add.url ? <img src={add.url} alt="追加する画像" className="w-full h-full object-contain" /> : <span className="text-xs text-ink-mute">画像を選ぶと見本が出ます</span>}</div>
            <div className="grid sm:grid-cols-2 gap-2">
              <div className="sm:col-span-2 flex flex-wrap gap-2">
                <label className={`btn cursor-pointer ${!ready ? "opacity-40 pointer-events-none" : ""}`}>画像を選ぶ<input type="file" accept="image/*" className="sr-only" data-testid="bg-upload" disabled={!ready} onChange={e => { void pick(e.target.files?.[0]); e.target.value = ""; }} /></label>
                <label className={`btn cursor-pointer ${!ready ? "opacity-40 pointer-events-none" : ""}`}>カメラで撮る<input type="file" accept="image/*" capture="environment" className="sr-only" disabled={!ready} onChange={e => { void pick(e.target.files?.[0]); e.target.value = ""; }} /></label>
              </div>
              <Field label="名前（手書き画面に出ます）"><input className="inp w-full" maxLength={40} value={add.name} disabled={!ready} onChange={e => setAdd({ ...add, name: e.target.value })} placeholder="例：ラシエル デザイン表" /></Field>
              <Field label="使う店舗"><select className="inp w-full" value={add.store_id} disabled={!ready} onChange={e => setAdd({ ...add, store_id: e.target.value })}><option value="">全店舗</option>{stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
              <div className="sm:col-span-2"><button className="btn-primary" disabled={!ready || busy || !add.blob} onClick={() => void addOne()}>追加する</button></div>
            </div>
          </div>
          {own.length === 0 ? <div className="state">まだお店の背景はありません</div> : (
            <div className="divide-y divide-line">
              {own.map((r, i) => (
                <div key={r.id} className={`py-2 grid grid-cols-[auto_120px_1fr] sm:grid-cols-[auto_150px_1fr_auto] gap-3 items-center ${r.active ? "" : "opacity-60"}`} data-testid="bg-row">
                  <div className="flex flex-col gap-1"><button className="btn text-xs" aria-label="上へ" disabled={i === 0 || busy} onClick={() => void move(i, -1)}>↑</button><button className="btn text-xs" aria-label="下へ" disabled={i === own.length - 1 || busy} onClick={() => void move(i, 1)}>↓</button></div>
                  <div className="aspect-[1414/1000] bg-white border border-line rounded overflow-hidden">{r.image_path && urls[r.image_path] ? <img src={urls[r.image_path]} alt={r.name} className="w-full h-full object-contain" /> : null}</div>
                  <div className="grid sm:grid-cols-2 gap-2">
                    <input className="inp w-full" maxLength={40} defaultValue={r.name} aria-label="名前" onBlur={e => { const v = e.target.value.trim(); if (v && v !== r.name) void run(() => repo.saveKarteBackground({ ...r, name: v }), "名前を変えました"); }} />
                    <select className="inp w-full" value={r.store_id || ""} aria-label="使う店舗" onChange={e => void run(() => repo.saveKarteBackground({ ...r, store_id: e.target.value || null }), "使う店舗を変えました")}>
                      <option value="">全店舗</option>{stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}{r.store_id && !stores.some(s => s.id === r.store_id) && <option value={r.store_id}>{storeName(r.store_id)}</option>}
                    </select>
                  </div>
                  <div className="col-span-3 sm:col-span-1 flex flex-wrap gap-2 items-center justify-end">
                    <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="w-5 h-5" checked={r.active} disabled={busy} onChange={e => void run(() => repo.saveKarteBackground({ ...r, active: e.target.checked }), e.target.checked ? "手書き画面に出します" : "手書き画面に出さないようにしました（今までのカルテはそのまま見られます）")} />手書き画面に出す</label>
                    <label className="btn text-xs cursor-pointer">画像を差し替え<input type="file" accept="image/*" className="sr-only" onChange={e => { void replace(r, e.target.files?.[0]); e.target.value = ""; }} /></label>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="text-[11px] text-ink-mute mt-2">使わなくなった背景は「手書き画面に出す」を外してください。今までのカルテの手書きは、背景ごと画像で残っているので、そのまま見られます。</div>
        </div>
      </div>
      {msg && <div className="sticky bottom-0 mt-3 py-2 bg-paper/95 border-t border-line"><span className={`text-sm ${/しました|します|追加|変え|並べ替え|差し替え/.test(msg) && !/できません|ください|いっぱい|権限/.test(msg) ? "text-canopy" : "text-danger"}`} role="status">{msg}</span></div>}
    </SettingsFrame>
  );
}
