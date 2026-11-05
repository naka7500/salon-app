"use client";
// クーポン管理（owner/manager）：金額値引／率値引／特別価格、条件、掲載期間、ネット予約に出す/出さない、HPB用の文言コピー
import { useCallback, useEffect, useState } from "react";
import { getRepo, yen, type Coupon, type Menu, type Target, type CouponKind, type OptionGroup } from "@/lib/db";
import { COUPON_KIND_LABEL, TARGET_LABEL, couponConditions, couponPrice, hpbCopyText, publishedNow, HPB_LIMIT } from "@/lib/web";
import { SettingsFrame, useAdmin, WeekdayPicker, Field } from "../SettingsParts";

const blank = (): Partial<Coupon> => ({ name: "", kind: "amount", value: 1000, menu_ids: [], target: "all", web_visible: true, active: true });

export default function CouponsSettingsPage() {
  const repo = getRepo();
  const { isAdmin, caps } = useAdmin();
  const [coupons, setCoupons] = useState<Coupon[] | null>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [usage, setUsage] = useState<Record<string, number>>({});
  const [edit, setEdit] = useState<Partial<Coupon> | null>(null);
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState<{ id: string; text: string; nameLen: number; descLen: number } | null>(null);
  const [groups, setGroups] = useState<OptionGroup[] | null>(null);
  const load = useCallback(async () => { setCoupons(await repo.coupons()); setUsage(await repo.couponUsage()); setGroups(await repo.optionGroups().catch(() => null)); }, [repo]);
  useEffect(() => { void Promise.resolve().then(load); repo.allMenus().then(m => setMenus(m.filter(x => x.active))); }, [repo, load]);
  const ready = coupons !== null && !!caps?.phaseC;
  const tech = menus.filter(m => m.category === "technical");

  async function move(i: number, d: number) {
    if (!coupons) return; const a = [...coupons]; const j = i + d; if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]]; setCoupons(a); await repo.reorderCoupons(a.map(c => c.id));
  }
  async function save() {
    if (!edit) return;
    try {
      if (!edit.name?.trim()) throw new Error("クーポン名を入れてください");
      if (edit.kind === "percent" && ((edit.value ?? 0) <= 0 || (edit.value ?? 0) > 100)) throw new Error("率値引は1〜100%で入れてください");
      if ((edit.value ?? -1) < 0) throw new Error("金額を入れてください");
      if (edit.kind === "fixed" && !(edit.menu_ids || []).length) throw new Error("特別価格は対象メニューを選んでください");
      const clean = Object.fromEntries(Object.entries(edit).map(([k, v]) => [k, v === "" ? null : v])) as Partial<Coupon> & { name: string };
      await repo.saveCoupon({ ...clean, name: edit.name.trim(), code: edit.code?.trim() || null });
      setEdit(null); setMsg(`「${edit.name}」を保存しました`); await load();
    } catch (e) { setMsg((e as Error).message); }
  }
  async function copyHpb(c: Coupon) {
    const h = hpbCopyText(c, menus);
    try { await navigator.clipboard.writeText(h.text); } catch {}
    setCopied({ id: c.id, text: h.text, nameLen: h.nameLen, descLen: h.descLen });
  }
  const valueLabel = (c: Pick<Coupon, "kind"|"value"|"menu_ids">) => {
    const ms = tech.filter(m => c.menu_ids.includes(m.id));
    if (c.kind === "fixed") return `特別価格 ${yen(c.value)}${ms.length === 1 ? `（通常 ${yen(ms[0].price)}）` : ""}`;
    if (c.kind === "percent") return `${c.value}%オフ`;
    return `${yen(c.value)}引き`;
  };

  return (
    <SettingsFrame title="設定" isAdmin={isAdmin} notReady={caps && !ready && "クーポンは準備中です（DB更新 0007 の後に使えます）。"}>
      {ready && coupons && <>
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <button className="btn-primary" onClick={() => { setEdit(blank()); setMsg(""); }}>＋新しいクーポン</button>
          {msg && <span className={`text-sm ${msg.includes("保存しました") ? "text-emerald-700" : "text-rose-600"}`}>{msg}</span>}
          <span className="ml-auto text-xs text-stone-500">HPBのクーポンはサロンボードで作ります。ここは名前・説明をそろえるための「文言コピー」まで。</span>
        </div>
        {copied && (
          <div className="card mb-2 border-emerald-400 bg-emerald-50">
            <div className="flex items-center gap-2 mb-1"><span className="font-semibold text-emerald-800 text-sm">HPB用の文言をコピーしました（サロンボードに貼り付けてください）</span><button className="btn text-xs ml-auto" onClick={() => setCopied(null)}>閉じる</button></div>
            <pre className="text-xs whitespace-pre-wrap bg-white border rounded p-2">{copied.text}</pre>
            <div className="text-[11px] text-stone-600 mt-1">クーポン名 {copied.nameLen}/{HPB_LIMIT.name}文字・説明 {copied.descLen}/{HPB_LIMIT.description}文字（目安を超える分は「…」で切っています）</div>
          </div>
        )}
        <div className="space-y-1.5">
          {coupons.length === 0 && <div className="card text-sm text-stone-500">まだクーポンがありません。</div>}
          {coupons.map((c, i) => { const pub = publishedNow(c.publish_from, c.publish_to); const used = usage[c.id] || 0; const conds = couponConditions(c); return (
            <div key={c.id} className={`card flex items-center gap-2 py-2 ${c.active ? "" : "opacity-50"}`}>
              <div className="flex flex-col gap-0.5"><button className="btn text-xs px-2 py-0.5" aria-label={`${c.name}を上へ`} onClick={() => move(i, -1)}>↑</button><button className="btn text-xs px-2 py-0.5" aria-label={`${c.name}を下へ`} onClick={() => move(i, 1)}>↓</button></div>
              <button className="flex-1 min-w-0 text-left" onClick={() => { setEdit({ ...c }); setMsg(""); }}>
                <div className="font-semibold truncate">{c.name}</div>
                <div className="text-xs text-stone-600 flex flex-wrap gap-x-2">
                  <span className="font-semibold text-rose-700">{valueLabel(c)}</span>
                  <span>{c.menu_ids.length ? tech.filter(m => c.menu_ids.includes(m.id)).map(m => m.short_name || m.name).join("・") : "技術メニュー全部"}</span>
                  {conds.map(x => <span key={x} className="px-1 rounded bg-stone-100">{x}</span>)}
                  {(c.publish_from || c.publish_to) && <span>掲載 {c.publish_from || ""}〜{c.publish_to || ""}</span>}
                  <span className="text-stone-500">利用 {used}件{c.first_n ? `／先着${c.first_n}名` : ""}</span>
                </div>
              </button>
              <div className="flex flex-col items-end gap-1">
                {!c.active ? <span className="text-[11px] px-1.5 rounded bg-stone-200">停止中</span>
                  : c.web_visible ? <span className={`text-[11px] px-1.5 rounded ${pub ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"}`}>{pub ? (c.code ? "ネット予約（コード入力時）" : "ネット予約に掲載") : "掲載期間外"}</span>
                  : <span className="text-[11px] px-1.5 rounded bg-stone-100">店頭のみ</span>}
                <button className="btn text-xs whitespace-nowrap" onClick={() => copyHpb(c)}>HPB用の文言をコピー</button>
              </div>
            </div>); })}
        </div>
      </>}

      {edit && (
        <div className="fixed inset-0 bg-black/30 z-40 flex items-end sm:items-center justify-center" onClick={() => setEdit(null)}>
          <div className="bg-white w-full sm:max-w-2xl rounded-t-xl sm:rounded-xl p-4 max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><h2 className="font-bold">{edit.id ? "クーポンを編集" : "新しいクーポン"}</h2><button className="btn" onClick={() => setEdit(null)}>閉じる</button></div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="クーポン名（必須）" className="sm:col-span-2" hint="HPBと同じ名前にすると、会計で選ぶときに迷いません"><input className="inp w-full" value={edit.name || ""} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="説明" className="sm:col-span-2"><textarea className="inp w-full" rows={2} value={edit.description || ""} onChange={e => setEdit({ ...edit, description: e.target.value })} /></Field>
              <Field label="種類">
                <div className="flex gap-1">{(Object.keys(COUPON_KIND_LABEL) as CouponKind[]).map(k => <button type="button" key={k} onClick={() => setEdit({ ...edit, kind: k })} className={`px-3 py-1.5 rounded border text-sm ${edit.kind === k ? "bg-canopy text-white border-canopy" : "bg-white"}`}>{COUPON_KIND_LABEL[k]}</button>)}</div>
              </Field>
              <Field label={edit.kind === "percent" ? "値引率（%）" : edit.kind === "fixed" ? "特別価格（税込・円）" : "値引額（円）"}><input type="number" className="inp w-full" value={edit.value ?? 0} onChange={e => setEdit({ ...edit, value: Number(e.target.value) })} /></Field>
              <Field label="対象メニュー（選ばない＝技術メニュー全部）" className="sm:col-span-2">
                <div className="flex flex-wrap gap-1">{tech.map(m => { const on = (edit.menu_ids || []).includes(m.id); return <button type="button" key={m.id} onClick={() => setEdit({ ...edit, menu_ids: on ? (edit.menu_ids || []).filter(x => x !== m.id) : [...(edit.menu_ids || []), m.id] })} className={`px-2 py-1 rounded border text-xs ${on ? "text-white" : "bg-white"}`} style={on ? { background: m.color || "#2f6b4f", borderColor: m.color || "#2f6b4f" } : { borderColor: m.color || "#ccc" }}>{m.name} {yen(m.price)}{on && edit.kind ? ` → ${yen(couponPrice(edit.kind, edit.value ?? 0, m.price))}` : ""}</button>; })}</div>
              </Field>
              {groups && groups.length > 0 && <Field label="このクーポンで付けられるオプション（グループ）" hint="メニュー側でひも付けたグループと合わせて出ます" className="sm:col-span-2"><div className="flex flex-wrap gap-1">{groups.map(g => { const on = (edit.option_group_ids || []).includes(g.id); return <button type="button" key={g.id} aria-pressed={on} onClick={() => setEdit({ ...edit, option_group_ids: on ? (edit.option_group_ids || []).filter(x => x !== g.id) : [...(edit.option_group_ids || []), g.id] })} className={`px-2 py-1 rounded border text-xs ${on ? "bg-sky-700 text-white border-sky-700" : "bg-white"}`}>{g.name}{g.required ? "（必須）" : ""}</button>; })}</div></Field>}
              <Field label="対象のお客様"><select className="inp w-full" value={edit.target || "all"} onChange={e => setEdit({ ...edit, target: e.target.value as Target })}>{Object.entries(TARGET_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
              <Field label="前回来店から○日以内（再来向け）" hint="例 45＝前回から45日以内のメンテナンス"><input type="number" min={1} className="inp w-full" value={edit.within_days ?? ""} onChange={e => setEdit({ ...edit, within_days: e.target.value ? Number(e.target.value) : null })} /></Field>
              <Field label="使える曜日" className="sm:col-span-2"><WeekdayPicker value={edit.weekdays} onChange={v => setEdit({ ...edit, weekdays: v })} /></Field>
              <Field label="使える時間帯（来店の開始時刻）" className="sm:col-span-2"><div className="flex items-center gap-2"><input type="time" step={900} className="inp" value={edit.time_from || ""} onChange={e => setEdit({ ...edit, time_from: e.target.value || null })} />〜<input type="time" step={900} className="inp" value={edit.time_to || ""} onChange={e => setEdit({ ...edit, time_to: e.target.value || null })} /></div></Field>
              <Field label="先着○名（空欄＝無制限）"><input type="number" min={1} className="inp w-full" value={edit.first_n ?? ""} onChange={e => setEdit({ ...edit, first_n: e.target.value ? Number(e.target.value) : null })} /></Field>
              <Field label="1人○回まで（空欄＝無制限）"><input type="number" min={1} className="inp w-full" value={edit.per_customer_limit ?? ""} onChange={e => setEdit({ ...edit, per_customer_limit: e.target.value ? Number(e.target.value) : null })} /></Field>
              <Field label="クーポンコード（入れた人だけに見せる・任意）"><input className="inp w-full" placeholder="例 SUMMER10" value={edit.code || ""} onChange={e => setEdit({ ...edit, code: e.target.value })} /></Field>
              <div />
              <Field label="掲載期間（開始）"><input type="date" className="inp w-full" value={edit.publish_from || ""} onChange={e => setEdit({ ...edit, publish_from: e.target.value || null })} /></Field>
              <Field label="掲載期間（終了）"><input type="date" className="inp w-full" value={edit.publish_to || ""} onChange={e => setEdit({ ...edit, publish_to: e.target.value || null })} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-5 h-5" checked={edit.web_visible !== false} onChange={e => setEdit({ ...edit, web_visible: e.target.checked })} />ネット予約に出す</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-5 h-5" checked={edit.active !== false} onChange={e => setEdit({ ...edit, active: e.target.checked })} />使う（外すと会計でも選べない）</label>
              <Field label="英語名（インバウンド用）"><input className="inp w-full" value={edit.name_en || ""} onChange={e => setEdit({ ...edit, name_en: e.target.value })} /></Field>
              <Field label="英語の説明"><input className="inp w-full" value={edit.description_en || ""} onChange={e => setEdit({ ...edit, description_en: e.target.value })} /></Field>
            </div>
            {msg && <div className="text-sm text-rose-600 mt-2">{msg}</div>}
            <div className="flex justify-end gap-2 mt-4"><button className="btn" onClick={() => setEdit(null)}>やめる</button><button className="btn-primary" onClick={save}>保存する</button></div>
          </div>
        </div>
      )}
    </SettingsFrame>
  );
}
