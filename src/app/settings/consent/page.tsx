"use client";
// 設定＞同意書・問診票（owner/manager）：お客様に署名してもらう書類のテンプレ（PDF か画像）。追加・名前・使う店舗・使う／使わない・ファイルの差し替え・開く
import { useCallback, useEffect, useState } from "react";
import { getRepo, CONSENT_FILE_MAX, type ConsentTemplate, type Store } from "@/lib/db";
import { normalizeTemplateFile } from "@/lib/consent/pdf";
import { SettingsFrame, useAdmin, Field } from "../SettingsParts";

const ACCEPT = "application/pdf,image/*";
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;

export default function ConsentSettingsPage() {
  const repo = getRepo();
  const { isAdmin, caps } = useAdmin();
  const [stores, setStores] = useState<Store[]>([]);
  const [rows, setRows] = useState<ConsentTemplate[] | null>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [add, setAdd] = useState<{ title: string; store_id: string; blob: Blob | null; kind: "pdf" | "image"; fileName: string }>({ title: "", store_id: "", blob: null, kind: "pdf", fileName: "" });

  const load = useCallback(async () => {
    const r = await repo.consentTemplates(true).catch(() => null);
    setRows(r);
    const paths = (r || []).map(x => x.file_path).filter(Boolean);
    if (paths.length) setUrls(await repo.consentFileUrls(paths).catch(() => ({})));
  }, [repo]);
  useEffect(() => {
    void Promise.resolve().then(load);
    repo.store().then(st => repo.stores().then(ss => setStores(ss.filter(x => x.company_id === st.company_id))).catch(() => {}));
  }, [repo, load]);
  const ready = !!caps?.consent25 && rows !== null;

  async function run(f: () => Promise<unknown>, ok: string) {
    setBusy(true); setMsg("");
    try { await f(); setMsg(ok); await load(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  async function pickFile(f: File | undefined): Promise<{ blob: Blob; kind: "pdf" | "image" } | null> {
    if (!f) return null;
    if (f.size > CONSENT_FILE_MAX) { setMsg(`ファイルが大きすぎます（${mb(f.size)}）。10MB までにしてください`); return null; }
    try { const r = await normalizeTemplateFile(f); if (r.blob.size > CONSENT_FILE_MAX) { setMsg("ファイルが大きすぎます。10MB までにしてください"); return null; } return r; }
    catch (e) { setMsg((e as Error).message); return null; }
  }
  async function pick(f: File | undefined) {
    const r = await pickFile(f); if (!r || !f) return;
    setAdd({ ...add, blob: r.blob, kind: r.kind, fileName: f.name, title: add.title || f.name.replace(/\.[^.]+$/, "").slice(0, 60) });
  }
  async function addOne() {
    if (!add.blob) { setMsg("PDF か画像を選んでください"); return; }
    if (!add.title.trim()) { setMsg("名前を入れてください"); return; }
    await run(() => repo.saveConsentTemplate({ title: add.title.trim(), store_id: add.store_id || null, active: true }, add.blob), `「${add.title.trim()}」を追加しました`);
    setAdd({ title: "", store_id: "", blob: null, kind: "pdf", fileName: "" });
  }
  async function replace(r: ConsentTemplate, f: File | undefined) { const x = await pickFile(f); if (!x) return; await run(() => repo.saveConsentTemplate({ ...r }, x.blob), `「${r.title}」のファイルを差し替えました`); }
  const storeName = (sid: string | null) => (sid ? stores.find(s => s.id === sid)?.name || "（別の店舗）" : "全店舗");
  const list = rows || [];

  return (
    <SettingsFrame title="設定" isAdmin={isAdmin} notReady={caps && !ready && "同意書・問診票は準備中です（DB更新 0025 の後に使えます）。"}>
      <div className="space-y-3">
        <div className="card">
          <div className="font-bold mb-1">同意書・問診票のテンプレ</div>
          <div className="text-xs text-ink-soft mb-3">お客様に見せて署名してもらう書類（施術同意書・問診票・注意事項など）を PDF か画像で登録します。1ファイル10MBまで。画像は長い辺2000pxに縮めて保存します。お客様のページの「同意書を取る」から、店のタブレットで署名してもらえます。</div>
          <div className="grid sm:grid-cols-2 gap-2 border border-line rounded-[var(--radius-sheet)] p-3 mb-3 bg-paper" data-testid="consent-add">
            <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
              <label className={`btn cursor-pointer ${!ready ? "opacity-40 pointer-events-none" : ""}`}>PDF・画像を選ぶ<input type="file" accept={ACCEPT} className="sr-only" data-testid="consent-upload" disabled={!ready} onChange={e => { void pick(e.target.files?.[0]); e.target.value = ""; }} /></label>
              {add.blob ? <span className="text-sm">{add.fileName}<span className="chip ml-1 bg-white border border-line text-ink-soft">{add.kind === "pdf" ? "PDF" : "画像"}・{mb(add.blob.size)}</span></span> : <span className="text-xs text-ink-mute">まだ選んでいません</span>}
            </div>
            <Field label="名前（お客様の画面とPDFに出ます）"><input className="inp w-full" maxLength={60} value={add.title} disabled={!ready} onChange={e => setAdd({ ...add, title: e.target.value })} placeholder="例：施術同意書" /></Field>
            <Field label="使う店舗"><select className="inp w-full" value={add.store_id} disabled={!ready} onChange={e => setAdd({ ...add, store_id: e.target.value })}><option value="">全店舗</option>{stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <div className="sm:col-span-2"><button className="btn-primary" disabled={!ready || busy || !add.blob} onClick={() => void addOne()}>追加する</button></div>
          </div>
          {list.length === 0 ? <div className="state">まだテンプレはありません</div> : (
            <div className="divide-y divide-line">
              {list.map(r => (
                <div key={r.id} className={`py-2 grid sm:grid-cols-[1fr_auto] gap-2 items-center ${r.active ? "" : "opacity-60"}`} data-testid="consent-row">
                  <div className="grid sm:grid-cols-2 gap-2">
                    <input className="inp w-full" maxLength={60} defaultValue={r.title} aria-label="名前" onBlur={e => { const v = e.target.value.trim(); if (v && v !== r.title) void run(() => repo.saveConsentTemplate({ ...r, title: v }), "名前を変えました"); }} />
                    <select className="inp w-full" value={r.store_id || ""} aria-label="使う店舗" onChange={e => void run(() => repo.saveConsentTemplate({ ...r, store_id: e.target.value || null }), "使う店舗を変えました")}>
                      <option value="">全店舗</option>{stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}{r.store_id && !stores.some(s => s.id === r.store_id) && <option value={r.store_id}>{storeName(r.store_id)}</option>}
                    </select>
                  </div>
                  <div className="flex flex-wrap gap-2 items-center justify-end">
                    <span className="chip bg-white border border-line text-ink-soft">{r.kind === "pdf" ? "PDF" : "画像"}</span>
                    {urls[r.file_path] && <a className="btn text-xs" href={urls[r.file_path]} target="_blank" rel="noreferrer">開く</a>}
                    <label className="btn text-xs cursor-pointer">ファイルを差し替え<input type="file" accept={ACCEPT} className="sr-only" onChange={e => { void replace(r, e.target.files?.[0]); e.target.value = ""; }} /></label>
                    <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" className="w-5 h-5" checked={r.active} disabled={busy} onChange={e => void run(() => repo.saveConsentTemplate({ ...r, active: e.target.checked }), e.target.checked ? "使えるようにしました" : "使わないようにしました（署名済みの書類はそのまま残ります）")} />使う</label>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="text-[11px] text-ink-mute mt-2">使わなくなったテンプレは「使う」を外してください（消しません）。署名済みの書類には、署名した時点の名前とPDFがそのまま残ります。署名は スタッフ以上の役割 で取れます。閲覧のみの方は見るだけです。</div>
        </div>
      </div>
      {msg && <div className="sticky bottom-0 mt-3 py-2 bg-paper/95 border-t border-line"><span className={`text-sm ${/しました|します|追加|変え|差し替え/.test(msg) && !/できません|ください|いっぱい|権限|大きすぎ/.test(msg) ? "text-canopy" : "text-danger"}`} role="status">{msg}</span></div>}
    </SettingsFrame>
  );
}
