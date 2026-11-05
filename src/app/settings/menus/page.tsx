"use client";
// メニュー管理（owner/manager）：ネット予約に出す項目まで。並び替えは ↑↓
import { useCallback, useEffect, useState } from "react";
import { getRepo, yen, type Menu, type Lane, type Target } from "@/lib/db";
import { TARGET_LABEL, WD_JA, publishedNow } from "@/lib/web";
import { SettingsFrame, useAdmin, WeekdayPicker, Field } from "../SettingsParts";

const COLORS = ["#e8547a", "#b57edc", "#2bb3a3", "#c5d94b", "#d9534f", "#d9a441", "#e07a9a", "#7a9cd9", "#8cc084", "#d98c5f", "#6b8e9f", "#bbbbbb"];
const blank = (): Partial<Menu> => ({ name: "", short_name: "", color: COLORS[0], category: "technical", price: 0, tax_rate: 0.1, duration_min: 60, interval_min: 10, target: "all", nominatable: true, web_visible: true, active: true });

export default function MenusSettingsPage() {
  const repo = getRepo();
  const { isAdmin, caps } = useAdmin();
  const [menus, setMenus] = useState<Menu[]>([]);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [edit, setEdit] = useState<Partial<Menu> | null>(null);
  const [msg, setMsg] = useState("");
  const [showHidden, setShowHidden] = useState(true);
  const load = useCallback(async () => { setMenus(await repo.allMenus()); }, [repo]);
  useEffect(() => { void Promise.resolve().then(load); repo.lanes().then(setLanes); }, [repo, load]);
  const ready = !!caps?.phaseC;

  async function move(i: number, d: number) {
    const a = [...menus]; const j = i + d; if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]]; setMenus(a); await repo.reorderMenus(a.map(m => m.id));
  }
  async function save() {
    if (!edit) return;
    try {
      if (!edit.name?.trim()) throw new Error("名前を入れてください");
      if ((edit.duration_min ?? 0) <= 0 && edit.category === "technical") throw new Error("所要時間を入れてください");
      if (edit.time_from && edit.time_to && edit.time_from > edit.time_to) throw new Error("受付時間帯の開始が終了より後になっています");
      if (edit.publish_from && edit.publish_to && edit.publish_from > edit.publish_to) throw new Error("掲載期間の開始が終了より後になっています");
      const clean = Object.fromEntries(Object.entries(edit).map(([k, v]) => [k, v === "" ? null : v])) as Partial<Menu> & { name: string };
      await repo.saveMenu({ ...clean, name: edit.name.trim() });
      setEdit(null); setMsg(`「${edit.name}」を保存しました`); await load();
    } catch (e) { setMsg((e as Error).message); }
  }
  const laneName = (id?: string | null) => (id ? lanes.find(l => l.id === id)?.name : lanes.slice().sort((a, b) => a.sort_order - b.sort_order)[0]?.name) || "—";
  const list = menus.filter(m => showHidden || m.active);

  return (
    <SettingsFrame title="設定" isAdmin={isAdmin} notReady={caps && !ready && "ネット予約用の項目（説明・画像・対象・掲載期間・曜日・時間帯・受付枠・指名・英語）は準備中です（DB更新 0007 の後）。名前・時間・料金などの基本項目は今も保存できます。"}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button className="btn-primary" onClick={() => { setEdit(blank()); setMsg(""); }}>＋新しいメニュー</button>
        <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={showHidden} onChange={e => setShowHidden(e.target.checked)} />使わないメニューも表示</label>
        {msg && <span className={`text-sm ${msg.includes("保存しました") ? "text-emerald-700" : "text-rose-600"}`}>{msg}</span>}
        <span className="ml-auto text-xs text-stone-500">↑↓で並び順（予約台帳・会計・ネット予約の表示順）</span>
      </div>
      <div className="space-y-1.5">
        {list.map(m => { const i = menus.indexOf(m); const pub = publishedNow(m.publish_from, m.publish_to); return (
          <div key={m.id} className={`card flex items-center gap-2 py-2 ${m.active ? "" : "opacity-50"}`}>
            <div className="flex flex-col gap-0.5"><button className="btn text-xs px-2 py-0.5" aria-label={`${m.name}を上へ`} onClick={() => move(i, -1)}>↑</button><button className="btn text-xs px-2 py-0.5" aria-label={`${m.name}を下へ`} onClick={() => move(i, 1)}>↓</button></div>
            <span className="w-3 self-stretch rounded" style={{ background: m.color || "#999" }} />
            {m.image_url ? <img src={m.image_url} alt="" className="w-12 h-12 object-cover rounded" /> : null}
            <button className="flex-1 min-w-0 text-left" onClick={() => { setEdit({ ...m }); setMsg(""); }}>
              <div className="font-semibold truncate">{m.name} <span className="text-xs font-normal text-stone-500">{m.short_name}</span></div>
              <div className="text-xs text-stone-500 flex flex-wrap gap-x-2">
                <span>{m.category === "technical" ? "技術" : "オプション"}</span><span>{m.duration_min}分{m.interval_min ? `＋準備${m.interval_min}分` : ""}</span><span className="font-semibold text-stone-700">{yen(m.price)}</span>
                {m.target && m.target !== "all" && <span className="text-rose-700">{TARGET_LABEL[m.target]}</span>}
                {m.weekdays?.length ? <span>{m.weekdays.map(d => WD_JA[d]).join("")}曜</span> : null}
                {(m.time_from || m.time_to) && <span>{m.time_from || ""}〜{m.time_to || ""}</span>}
                {m.lane_id && <span>枠：{laneName(m.lane_id)}</span>}
                {m.nominatable === false && <span>指名不可</span>}
              </div>
            </button>
            <div className="flex flex-col items-end gap-1 text-[11px]">
              {!m.active ? <span className="px-1.5 rounded bg-stone-200">使わない</span>
                : m.category === "technical" && m.web_visible !== false ? <span className={`px-1.5 rounded ${pub ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{pub ? "ネット予約に掲載" : "掲載期間外"}</span>
                : <span className="px-1.5 rounded bg-stone-100 text-stone-600">店頭のみ</span>}
            </div>
          </div>); })}
      </div>

      {edit && (
        <div className="fixed inset-0 bg-black/30 z-40 flex items-end sm:items-center justify-center" onClick={() => setEdit(null)}>
          <div className="bg-white w-full sm:max-w-2xl rounded-t-xl sm:rounded-xl p-4 max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><h2 className="font-bold">{edit.id ? "メニューを編集" : "新しいメニュー"}</h2><button className="btn" onClick={() => setEdit(null)}>閉じる</button></div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="名前（必須）"><input className="inp w-full" value={edit.name || ""} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="略名（予約台帳に出る短い名前）"><input className="inp w-full" value={edit.short_name || ""} onChange={e => setEdit({ ...edit, short_name: e.target.value })} /></Field>
              <Field label="色" className="sm:col-span-2"><div className="flex flex-wrap gap-1">{COLORS.map(c => <button type="button" key={c} aria-label={c} onClick={() => setEdit({ ...edit, color: c })} className={`w-7 h-7 rounded-full border-2 ${edit.color === c ? "border-stone-800" : "border-white"}`} style={{ background: c }} />)}</div></Field>
              <Field label="カテゴリ"><select className="inp w-full" value={edit.category} onChange={e => setEdit({ ...edit, category: e.target.value as Menu["category"] })}><option value="technical">技術</option><option value="option">オプション</option></select></Field>
              <Field label="価格（税込・円）"><input type="number" className="inp w-full" value={edit.price ?? 0} onChange={e => setEdit({ ...edit, price: Number(e.target.value) })} /></Field>
              <Field label="所要時間（分）"><input type="number" step={5} className="inp w-full" value={edit.duration_min ?? 0} onChange={e => setEdit({ ...edit, duration_min: Number(e.target.value) })} /></Field>
              <Field label="準備時間（分・次の予約までの間）"><input type="number" step={5} className="inp w-full" value={edit.interval_min ?? 0} onChange={e => setEdit({ ...edit, interval_min: Number(e.target.value) })} /></Field>
              <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="w-5 h-5" checked={edit.active !== false} onChange={e => setEdit({ ...edit, active: e.target.checked })} />このメニューを使う（外すと会計・台帳・ネット予約に出なくなる）</label>
            </div>
            <div className={`mt-4 pt-3 border-t ${ready ? "" : "opacity-50 pointer-events-none"}`}>
              <div className="font-semibold mb-2 text-sm">ネット予約の設定{!ready && "（準備中）"}</div>
              <div className="grid sm:grid-cols-2 gap-3">
                <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" className="w-5 h-5" checked={edit.web_visible !== false} onChange={e => setEdit({ ...edit, web_visible: e.target.checked })} />ネット予約に出す（技術メニューのみ）</label>
                <Field label="説明文" className="sm:col-span-2"><textarea className="inp w-full" rows={2} value={edit.description || ""} onChange={e => setEdit({ ...edit, description: e.target.value })} /></Field>
                <Field label="画像のURL" hint="今は画像URLを貼る方式（画像のアップロードは今後）" className="sm:col-span-2"><input className="inp w-full" placeholder="https://..." value={edit.image_url || ""} onChange={e => setEdit({ ...edit, image_url: e.target.value })} /></Field>
                <Field label="対象"><select className="inp w-full" value={edit.target || "all"} onChange={e => setEdit({ ...edit, target: e.target.value as Target })}>{Object.entries(TARGET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
                <Field label="使う受付枠"><select className="inp w-full" value={edit.lane_id || ""} onChange={e => setEdit({ ...edit, lane_id: e.target.value || null })}><option value="">{laneName(null)}（標準）</option>{lanes.map(l => <option key={l.id} value={l.id}>{l.name}{l.capacity >= 2 ? `（同時${l.capacity}名）` : ""}</option>)}</select></Field>
                <Field label="掲載期間（開始）"><input type="date" className="inp w-full" value={edit.publish_from || ""} onChange={e => setEdit({ ...edit, publish_from: e.target.value || null })} /></Field>
                <Field label="掲載期間（終了）"><input type="date" className="inp w-full" value={edit.publish_to || ""} onChange={e => setEdit({ ...edit, publish_to: e.target.value || null })} /></Field>
                <Field label="受付する曜日" className="sm:col-span-2"><WeekdayPicker value={edit.weekdays} onChange={v => setEdit({ ...edit, weekdays: v })} /></Field>
                <Field label="受付する時間帯（開始時刻）" hint="空欄＝営業時間中ずっと" className="sm:col-span-2"><div className="flex items-center gap-2"><input type="time" step={900} className="inp" value={edit.time_from || ""} onChange={e => setEdit({ ...edit, time_from: e.target.value || null })} />〜<input type="time" step={900} className="inp" value={edit.time_to || ""} onChange={e => setEdit({ ...edit, time_to: e.target.value || null })} /></div></Field>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-5 h-5" checked={edit.nominatable !== false} onChange={e => setEdit({ ...edit, nominatable: e.target.checked })} />指名できる</label>
                <div />
                <Field label="英語名（インバウンド用）"><input className="inp w-full" value={edit.name_en || ""} onChange={e => setEdit({ ...edit, name_en: e.target.value })} /></Field>
                <Field label="英語の説明"><input className="inp w-full" value={edit.description_en || ""} onChange={e => setEdit({ ...edit, description_en: e.target.value })} /></Field>
              </div>
            </div>
            {msg && <div className="text-sm text-rose-600 mt-2">{msg}</div>}
            <div className="flex justify-end gap-2 mt-4"><button className="btn" onClick={() => setEdit(null)}>やめる</button><button className="btn-primary" onClick={save}>保存する</button></div>
          </div>
        </div>
      )}
    </SettingsFrame>
  );
}
