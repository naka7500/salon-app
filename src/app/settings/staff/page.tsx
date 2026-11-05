"use client";
// スタッフ管理（owner/manager）：予約台帳・シフト・会計・ネット予約に出す人を登録・編集する。
// 退職＝今後は出さない（過去の予約・売上・カルテには名前が残る）。履歴がある人は削除できない。
import { useCallback, useEffect, useMemo, useState } from "react";
import { getRepo, todayStr, yen, byStaffOrder, type Staff, type StaffInput, type StaffRole, type Store, type ID } from "@/lib/db";
import { addDays } from "@/lib/schedule";
import { SettingsFrame, useAdmin, Field } from "../SettingsParts";

const COLORS = ["#2f6b4f", "#1d5f8a", "#8a3b5c", "#d9a441", "#7a9cd9", "#8cc084", "#d98c5f", "#b57edc", "#e07a9a", "#2bb3a3", "#6b8e9f", "#c5d94b"];
const ROLE_LABEL: Record<StaffRole, string> = { owner: "オーナー", manager: "店長", staff: "スタッフ", viewer: "閲覧のみ" };
const ROLE_HINT: Record<StaffRole, string> = { owner: "すべての設定・スタッフ管理", manager: "設定・スタッフ管理・締め後の赤伝", staff: "予約・会計・カルテ", viewer: "見るだけ" };

type Edit = StaffInput & { email?: string | null; auth_user_id?: string | null };

export default function StaffSettingsPage() {
  const repo = getRepo();
  const { me, isAdmin, caps } = useAdmin();
  const [list, setList] = useState<Staff[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  const [cur, setCur] = useState<Store | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [msg, setMsg] = useState("");
  const [scope, setScope] = useState<"store" | "all">("store");
  const [showRetired, setShowRetired] = useState(false);
  const [busy, setBusy] = useState(false);
  const ready = !!caps?.staffSettings;

  const load = useCallback(async () => { setList(await repo.allStaff()); }, [repo]);
  useEffect(() => {
    void Promise.resolve().then(load);
    (async () => { const c = await repo.store(); setCur(c); const all = await repo.stores(); setStores(all.filter(s => s.company_id === c.company_id)); })().catch(() => {});
  }, [repo, load]);

  const storeName = (id?: ID | null) => stores.find(s => s.id === id)?.name || "";
  const inStore = (s: Staff) => !cur || (s.store_ids || []).includes(cur.id);
  const shown = useMemo(() => list.filter(s => (scope === "all" || inStore(s)) && (showRetired || s.active !== false)), [list, scope, showRetired, cur]); // eslint-disable-line react-hooks/exhaustive-deps
  const retiredCount = list.filter(s => s.active === false && (scope === "all" || inStore(s))).length;
  const isOwner = me?.role === "owner";

  function blank(): Edit {
    return { name: "", display_name: "", name_en: "", color: COLORS[list.length % COLORS.length], role: "staff", active: true, show_on_ledger: true, web_nominatable: true, nomination_fee: 0, home_store_id: cur?.id || null, store_ids: cur ? [cur.id] : [] };
  }
  function open(s: Staff) { setMsg(""); setEdit({ ...s, store_ids: s.store_ids || [], home_store_id: s.home_store_id ?? s.store_ids?.[0] ?? null }); }

  async function move(s: Staff, d: number) {
    if (!ready) return;
    // 表示中の並びで入れ替え、会社全体の順番に反映する
    const all = [...list].sort(byStaffOrder);
    const vis = all.filter(x => shown.includes(x));
    const i = vis.indexOf(s), j = i + d; if (j < 0 || j >= vis.length) return;
    const a = all.indexOf(vis[i]), b = all.indexOf(vis[j]);
    [all[a], all[b]] = [all[b], all[a]];
    setList(all.map((x, k) => ({ ...x, sort_order: k + 1 })));
    try { await repo.reorderStaff(all.map(x => x.id)); } catch (e) { setMsg((e as Error).message); await load(); }
  }

  async function save() {
    if (!edit) return;
    setBusy(true);
    try {
      const name = edit.name.trim();
      if (!name) throw new Error("名前を入れてください");
      if (name.length > 40) throw new Error("名前は40文字までにしてください");
      if (!edit.store_ids.length) throw new Error("所属店舗を選んでください");
      if ((edit.nomination_fee ?? 0) < 0) throw new Error("指名料は0円以上にしてください");
      const old = edit.id ? list.find(x => x.id === edit.id) : undefined;
      // 退職にするとき：今後の予約・シフトを確認
      let dropShifts: { staff_id: ID; date: string }[] = [];
      if (old && old.active !== false && edit.active === false) {
        const t = todayStr();
        const [bs, ss] = await Promise.all([repo.bookingsBetween(t, addDays(t, 366)), repo.shiftsBetween(addDays(t, 1), addDays(t, 366))]);
        const fb = bs.filter(b => b.staff_id === old.id && (b.status === "booked" || b.status === "arrived"));
        dropShifts = ss.filter(x => x.staff_id === old.id).map(x => ({ staff_id: old.id, date: x.date }));
        const lines = [`${old.name}さんを「退職」にします。`, "・今後は予約台帳・シフト・会計・ネット予約に出なくなります。", "・過去の予約・売上・カルテには名前が残ります。"];
        if (fb.length) lines.push(`・この店舗に今日以降の予約が ${fb.length}件 あります（予約台帳に「退職」の行で残るので、担当を付け替えてください）。`);
        if (dropShifts.length) lines.push(`・この店舗の明日以降のシフト ${dropShifts.length}件 は消します。`);
        if (!confirm(lines.join("\n") + "\n\nよろしいですか？")) { setBusy(false); return; }
      }
      const clean: StaffInput = {
        id: edit.id, name, role: edit.role, active: edit.active !== false, nomination_fee: Math.round(Number(edit.nomination_fee) || 0), store_ids: edit.store_ids,
        display_name: edit.display_name?.trim() || null, name_en: edit.name_en?.trim() || null, color: edit.color || null,
        show_on_ledger: edit.show_on_ledger !== false, web_nominatable: edit.web_nominatable !== false,
        home_store_id: edit.home_store_id && edit.store_ids.includes(edit.home_store_id) ? edit.home_store_id : edit.store_ids[0],
      };
      await repo.saveStaff(clean);
      if (dropShifts.length) await repo.deleteShifts(dropShifts);
      setEdit(null); setMsg(`「${name}」を保存しました`); await load();
    } catch (e) { setMsg((e as Error).message); }
    setBusy(false);
  }

  async function remove() {
    if (!edit?.id) return;
    if (!confirm(`「${edit.name}」を削除しますか？\n（間違えて登録したときだけ。働いていた人は「退職」にしてください）`)) return;
    try { await repo.deleteStaff(edit.id); setEdit(null); setMsg(`「${edit.name}」を削除しました`); await load(); }
    catch (e) { setMsg((e as Error).message); }
  }

  const self = !!(edit?.id && me?.id === edit.id);
  const ownerLocked = !!edit && !isOwner && list.find(x => x.id === edit.id)?.role === "owner";
  const toggleStore = (id: ID, on: boolean) => {
    if (!edit) return;
    const ids = on ? [...edit.store_ids, id] : edit.store_ids.filter(x => x !== id);
    setEdit({ ...edit, store_ids: ids, home_store_id: ids.includes(edit.home_store_id || "") ? edit.home_store_id : ids[0] ?? null });
  };

  return (
    <SettingsFrame title="設定" isAdmin={isAdmin} notReady={caps && !ready && "スタッフの新しい項目（表示名・英語名・色・表示順・予約台帳に表示・ネット予約で指名可・所属店舗）は準備中です（DB更新 0008 の後）。名前・役割・指名料・在籍/退職・店舗は今も保存できます。"}>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button className="btn-primary" onClick={() => { setEdit(blank()); setMsg(""); }}>＋スタッフを追加</button>
        {stores.length > 1 && (
          <div className="inline-flex border rounded overflow-hidden text-sm">
            <button className={`px-3 py-1 ${scope === "store" ? "bg-stone-800 text-white" : "bg-white"}`} onClick={() => setScope("store")}>{cur?.name || "この店舗"}</button>
            <button className={`px-3 py-1 border-l ${scope === "all" ? "bg-stone-800 text-white" : "bg-white"}`} onClick={() => setScope("all")}>会社の全員</button>
          </div>
        )}
        <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} />退職した人も表示{retiredCount ? `（${retiredCount}名）` : ""}</label>
        {msg && <span className={`text-sm ${/保存しました|削除しました/.test(msg) ? "text-emerald-700" : "text-rose-600"}`}>{msg}</span>}
        <span className="ml-auto text-xs text-stone-500">↑↓で並び順（予約台帳・シフト・ネット予約の表示順）</span>
      </div>

      {shown.length === 0 && <div className="card text-sm text-stone-500">この店舗のスタッフはまだいません。「＋スタッフを追加」から登録してください。</div>}
      <div className="space-y-1.5">
        {shown.map((s, i) => (
          <div key={s.id} className={`card flex items-center gap-2 py-2 ${s.active === false ? "opacity-60 bg-stone-50" : ""}`}>
            <div className="flex flex-col gap-0.5">
              <button className="btn text-xs px-2 py-0.5 disabled:opacity-30" disabled={!ready || i === 0} aria-label={`${s.name}を上へ`} onClick={() => move(s, -1)}>↑</button>
              <button className="btn text-xs px-2 py-0.5 disabled:opacity-30" disabled={!ready || i === shown.length - 1} aria-label={`${s.name}を下へ`} onClick={() => move(s, 1)}>↓</button>
            </div>
            <span className="w-3 self-stretch rounded" style={{ background: s.color || "#999" }} />
            <button className="flex-1 min-w-0 text-left" onClick={() => open(s)}>
              <div className="font-semibold truncate">{s.name}
                {s.display_name && s.display_name !== s.name && <span className="text-xs font-normal text-stone-500 ml-1">予約ページ：{s.display_name}</span>}
                {s.name_en && <span className="text-xs font-normal text-stone-400 ml-1">{s.name_en}</span>}
              </div>
              <div className="text-xs text-stone-500 flex flex-wrap gap-x-2">
                <span className="font-semibold text-stone-700">{ROLE_LABEL[s.role]}</span>
                {s.home_store_id && <span>所属：{storeName(s.home_store_id) || "—"}</span>}
                {(s.store_ids || []).filter(x => x !== s.home_store_id).length > 0 && <span>ヘルプ：{(s.store_ids || []).filter(x => x !== s.home_store_id).map(storeName).filter(Boolean).join("・")}</span>}
                {!(s.store_ids || []).length && <span className="text-amber-700">店舗なし</span>}
                {(s.nomination_fee || 0) > 0 && <span>指名料 {yen(s.nomination_fee || 0)}</span>}
                {s.email && <span className="text-stone-400">{s.email}</span>}
              </div>
            </button>
            <div className="flex flex-col items-end gap-1 text-[11px]">
              {s.active === false ? <span className="px-1.5 rounded bg-stone-300 text-stone-700">退職</span> : <>
                <span className={`px-1.5 rounded ${s.show_on_ledger !== false ? "bg-emerald-100 text-emerald-800" : "bg-stone-100 text-stone-500"}`}>{s.show_on_ledger !== false ? "台帳に表示" : "台帳に出さない"}</span>
                {s.show_on_ledger !== false && <span className={`px-1.5 rounded ${s.web_nominatable !== false ? "bg-sky-100 text-sky-800" : "bg-stone-100 text-stone-500"}`}>{s.web_nominatable !== false ? "ネット指名OK" : "ネット指名なし"}</span>}
              </>}
            </div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-stone-500 mt-2">退職した人は、今後は予約台帳・シフト・会計・ネット予約に出ません。過去の予約・売上・カルテには名前がそのまま残ります。</div>

      {edit && (
        <div className="fixed inset-0 bg-black/30 z-40 flex items-end sm:items-center justify-center" onClick={() => setEdit(null)}>
          <div className="bg-white w-full sm:max-w-2xl rounded-t-xl sm:rounded-xl p-4 max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3"><h2 className="font-bold">{edit.id ? "スタッフを編集" : "スタッフを追加"}</h2><button className="btn" onClick={() => setEdit(null)}>閉じる</button></div>
            {ownerLocked && <div className="mb-3 text-sm px-3 py-2 rounded bg-amber-50 border border-amber-300 text-amber-900">オーナーの情報はオーナーだけが変えられます。</div>}
            <fieldset disabled={ownerLocked} className="contents">
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="名前（必須・予約台帳や会計に出る名前）"><input className="inp w-full" maxLength={40} value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
                <Field label="役割" hint={ROLE_HINT[edit.role]}>
                  <select className="inp w-full" value={edit.role} disabled={self} onChange={e => setEdit({ ...edit, role: e.target.value as StaffRole })}>
                    {(["owner", "manager", "staff"] as StaffRole[]).map(r => <option key={r} value={r} disabled={r === "owner" && !isOwner}>{ROLE_LABEL[r]}</option>)}
                    {edit.role === "viewer" && <option value="viewer">{ROLE_LABEL.viewer}</option>}
                  </select>
                </Field>
                <Field label="指名料（円・税込）" hint="ネット予約で指名されたとき料金に足します。会計では「指名料」の行が自動で入ります"><input type="number" min={0} step={100} className="inp w-full" value={edit.nomination_fee ?? 0} onChange={e => setEdit({ ...edit, nomination_fee: Number(e.target.value) })} /></Field>
                <Field label="在籍">
                  <div className="flex gap-1">
                    <button type="button" disabled={self} className={`flex-1 px-3 py-1.5 rounded border text-sm ${edit.active !== false ? "bg-[#2f6b4f] text-white border-[#2f6b4f]" : "bg-white"}`} onClick={() => setEdit({ ...edit, active: true })}>在籍</button>
                    <button type="button" disabled={self} className={`flex-1 px-3 py-1.5 rounded border text-sm ${edit.active === false ? "bg-stone-700 text-white border-stone-700" : "bg-white"}`} onClick={() => setEdit({ ...edit, active: false })}>退職</button>
                  </div>
                  {self && <span className="block text-[11px] text-stone-400 mt-0.5">自分の役割・在籍は自分では変えられません</span>}
                </Field>
                <Field label="店舗（チェックした店舗の予約台帳・シフトに出ます）" className="sm:col-span-2">
                  <div className="border rounded divide-y">
                    {stores.map(st => { const on = edit.store_ids.includes(st.id); const home = on && (edit.home_store_id || edit.store_ids[0]) === st.id; return (
                      <div key={st.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
                        <label className="flex items-center gap-2 flex-1"><input type="checkbox" className="w-5 h-5" checked={on} onChange={e => toggleStore(st.id, e.target.checked)} />{st.name}{st.id === cur?.id && <span className="text-[10px] text-stone-400">（表示中）</span>}</label>
                        {on && (ready
                          ? <label className={`flex items-center gap-1 text-xs ${home ? "text-emerald-800 font-semibold" : "text-stone-500"}`}><input type="radio" name="home" checked={home} onChange={() => setEdit({ ...edit, home_store_id: st.id })} />{home ? "所属" : "ヘルプ（所属にする）"}</label>
                          : <span className="text-xs text-stone-400">（所属/ヘルプの区別は準備中）</span>)}
                      </div>); })}
                  </div>
                </Field>
              </div>
              <div className={`mt-4 pt-3 border-t ${ready ? "" : "opacity-50 pointer-events-none"}`}>
                <div className="font-semibold mb-2 text-sm">表示の設定{!ready && "（準備中）"}</div>
                <div className="grid sm:grid-cols-2 gap-3">
                  <Field label="表示名（予約ページ用・任意）" hint="空欄なら名前がそのまま出ます"><input className="inp w-full" maxLength={40} value={edit.display_name || ""} onChange={e => setEdit({ ...edit, display_name: e.target.value })} /></Field>
                  <Field label="英語名（任意・インバウンド用）"><input className="inp w-full" maxLength={60} value={edit.name_en || ""} onChange={e => setEdit({ ...edit, name_en: e.target.value })} /></Field>
                  <Field label="色（予約台帳の名前の横に出ます）" className="sm:col-span-2"><div className="flex flex-wrap gap-1">{COLORS.map(c => <button type="button" key={c} aria-label={c} onClick={() => setEdit({ ...edit, color: c })} className={`w-7 h-7 rounded-full border-2 ${edit.color === c ? "border-stone-800" : "border-white"}`} style={{ background: c }} />)}</div></Field>
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-5 h-5" checked={edit.show_on_ledger !== false} onChange={e => setEdit({ ...edit, show_on_ledger: e.target.checked })} />予約台帳に表示する（シフト・会計の担当にも出る）</label>
                  <label className={`flex items-center gap-2 text-sm ${edit.show_on_ledger === false ? "opacity-50" : ""}`}><input type="checkbox" className="w-5 h-5" disabled={edit.show_on_ledger === false} checked={edit.show_on_ledger !== false && edit.web_nominatable !== false} onChange={e => setEdit({ ...edit, web_nominatable: e.target.checked })} />ネット予約で指名できる</label>
                </div>
              </div>
              <div className="mt-4 pt-3 border-t text-sm">
                <div className="font-semibold mb-1">ログイン</div>
                <div className="text-stone-700">{edit.email ? <>メール：<span className="font-mono">{edit.email}</span>{edit.auth_user_id ? <span className="ml-2 text-[11px] px-1.5 rounded bg-emerald-100 text-emerald-800">ログイン済み</span> : <span className="ml-2 text-[11px] px-1.5 rounded bg-stone-100 text-stone-600">まだログインしていない</span>}</> : <span className="text-stone-500">ログインのメールはまだありません。</span>}</div>
                <div className="text-[11px] text-stone-500 mt-0.5">ログインの招待は次の段階です（今はメールの表示だけ）。</div>
              </div>
            </fieldset>
            {msg && <div className="text-sm text-rose-600 mt-2">{msg}</div>}
            <div className="flex flex-wrap justify-between gap-2 mt-4">
              <div>{edit.id && !ownerLocked && !self && <button className="btn text-rose-600" onClick={remove} title="間違えて登録したときだけ。履歴がある人は消せません">削除</button>}</div>
              <div className="flex gap-2"><button className="btn" onClick={() => setEdit(null)}>やめる</button><button className="btn-primary" disabled={busy || ownerLocked} onClick={save}>保存する</button></div>
            </div>
          </div>
        </div>
      )}
    </SettingsFrame>
  );
}
