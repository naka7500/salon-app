"use client";
// 設定＞ユーザー（オーナーだけ）：名前・役割・メール・パスワード（オーナーが決める）でログインできるユーザーを作る。
// テスト用のユーザーや、仮パスワードの手間をはぶきたいときに使う。仮パスワードの発行は 設定＞スタッフ のまま。
// パスワードはこの画面の state にだけ置き、送ったらすぐ消す（保存・ログ出力・記録はしない。サーバの返事にも入らない）。
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getRepo, type Staff, type StaffLoginInfo, type StaffLoginStatusResult, type StaffRole } from "@/lib/db";
import { MIN_PASSWORD, USER_ROLES, isValidEmail, loginPermissionError, normalizeEmail, passwordStrength, plusAddress, type StaffLoginKind, type UserRole } from "@/lib/staffLogin";
import { LoginHistoryList } from "../staff/StaffLogin";
import { SettingsFrame, useAdmin, Field } from "../SettingsParts";

const ROLE_LABEL: Record<StaffRole, string> = { owner: "オーナー", manager: "店長", staff: "スタッフ", viewer: "閲覧のみ" };
const ROLE_HINT: Record<UserRole, string> = { staff: "予約・会計・カルテが使えます", manager: "スタッフの仕事＋設定・スタッフ管理・締め後の赤伝" };
const fmt = (iso: string) => new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

type Shown = { label: string; cls: string };
function statusOf(s: Staff, info?: StaffLoginInfo, server?: boolean): Shown {
  if (s.active === false) return { label: "退職", cls: "bg-stone-300 text-stone-700" };
  const st = info?.status ?? (server ? "none" : s.auth_user_id ? "active" : "none");
  if (st === "stopped") return { label: "停止中", cls: "bg-rose-100 text-rose-800" };
  if (st === "none") return { label: "未発行", cls: "bg-stone-100 text-stone-600" };
  return { label: "ログイン可", cls: "bg-emerald-100 text-emerald-800" };
}

/** パスワードの入力（表示／隠す・強さの目安） */
function PasswordInput({ value, onChange, email, id }: { value: string; onChange: (v: string) => void; email?: string; id: string }) {
  const [show, setShow] = useState(false);
  const st = passwordStrength(value, email);
  const bar = ["bg-stone-200", "bg-amber-400", "bg-sky-500", "bg-emerald-600"][st.level];
  return (
    <div>
      <div className="flex gap-2">
        <input id={id} type={show ? "text" : "password"} className="inp w-full min-h-11 font-mono" autoComplete="new-password" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          maxLength={72} value={value} onChange={e => onChange(e.target.value)} data-testid={`${id}-input`} />
        <button type="button" className="btn shrink-0 min-w-16" onClick={() => setShow(v => !v)} aria-pressed={show} aria-controls={id}>{show ? "隠す" : "表示"}</button>
      </div>
      <div className="flex items-center gap-2 mt-1" aria-live="polite">
        <div className="flex gap-0.5 w-24" aria-hidden>{[1, 2, 3].map(i => <span key={i} className={`h-1.5 flex-1 rounded ${value && st.level >= i ? bar : "bg-stone-200"}`} />)}</div>
        {st.label && <span className={`text-xs font-semibold ${st.level === 0 ? "text-rose-600" : st.level === 3 ? "text-emerald-700" : "text-ink-soft"}`}>{st.label}</span>}
        <span className={`text-[11px] ${st.level === 0 && value ? "text-rose-600" : "text-ink-mute"}`}>{st.hint}</span>
      </div>
    </div>
  );
}

type AddForm = { mode: "new" | "existing"; staff_id: string; name: string; role: UserRole; email: string; password: string; must_change: boolean; show_on_ledger: boolean };
const blankForm = (staffId?: string): AddForm => ({ mode: staffId ? "existing" : "new", staff_id: staffId || "", name: "", role: "staff", email: "", password: "", must_change: true, show_on_ledger: false });

export default function UsersSettingsPage() {
  const repo = getRepo();
  const { me } = useAdmin();
  const isOwner = me === undefined ? undefined : me?.role === "owner";
  const [list, setList] = useState<Staff[]>([]);
  const [login, setLogin] = useState<StaffLoginStatusResult | null>(null);
  const [storeEmail, setStoreEmail] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<AddForm | null>(null);
  const [formErr, setFormErr] = useState<{ text: string; exists?: boolean } | null>(null);
  const [pwFor, setPwFor] = useState<{ staff: Staff; password: string; must_change: boolean } | null>(null);
  const [pwErr, setPwErr] = useState("");

  const load = useCallback(async () => {
    setList(await repo.allStaff());
    try { setLogin(await repo.staffLoginStatus()); }
    catch (e) { setLogin({ server: false, invite_enabled: false, items: [], message: (e as Error).message }); }
  }, [repo]);
  useEffect(() => {
    if (!isOwner) return;
    void Promise.resolve().then(load).catch(e => setMsg({ ok: false, text: (e as Error).message }));
    repo.store().then(s => setStoreEmail(s.notify_email ?? null)).catch(() => {});
  }, [repo, load, isOwner]);

  const info = (id: string) => login?.items.find(x => x.staff_id === id);
  const server = !!login?.server;
  const shown = useMemo(() => list.filter(s => showRetired || s.active !== false), [list, showRetired]);
  const retired = list.filter(s => s.active === false).length;
  /** ログインの無い在籍の人（オーナー以外）＝「今のスタッフにつなぐ」の候補 */
  const noLogin = list.filter(s => s.active !== false && s.role !== "owner" && (info(s.id)?.status ?? (s.auth_user_id ? "active" : "none")) === "none");
  const actor = { staff_id: me?.id ?? null, auth_user_id: me?.auth_user_id ?? null, role: me?.role };
  const why = (k: StaffLoginKind, s: Staff) => loginPermissionError(k, actor, s);

  function openAdd(staffId?: string) { setForm(blankForm(staffId)); setFormErr(null); setMsg(null); }
  function closeAdd() { setForm(null); setFormErr(null); }   // パスワードも一緒に消える
  const attachTo = form?.mode === "existing" ? list.find(s => s.id === form.staff_id) : undefined;
  const suggestion = form ? plusAddress(storeEmail, attachTo?.name_en ?? null, list.length + 1) : null;
  const formEmail = normalizeEmail(form?.email || "");
  const formPwOk = !!form && passwordStrength(form.password, formEmail).level > 0;
  const formOk = !!form && isValidEmail(formEmail) && formPwOk && (form.mode === "existing" ? !!attachTo : !!form.name.trim());

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !formOk) return;
    setBusy(true); setFormErr(null);
    try {
      const r = await repo.staffLoginAction(form.mode === "existing"
        ? { kind: "create_user", staff_id: form.staff_id, name: attachTo?.name || "", role: "staff", email: formEmail, password: form.password, must_change: form.must_change }
        : { kind: "create_user", name: form.name.trim(), role: form.role, email: formEmail, password: form.password, must_change: form.must_change, show_on_ledger: false });
      if (!r.ok) { setFormErr({ text: r.message, exists: r.code === "email_exists" }); setForm(f => f && { ...f, password: "" }); return; }
      setForm(null);
      setMsg({ ok: true, text: `${r.message}${r.email ? `（ログインのメール：${r.email}）` : ""}` });
      await load();
    } catch (e) { setFormErr({ text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  async function submitPw(e: React.FormEvent) {
    e.preventDefault();
    if (!pwFor) return;
    setBusy(true); setPwErr("");
    try {
      const r = await repo.staffLoginAction({ kind: "set_password", staff_id: pwFor.staff.id, password: pwFor.password, must_change: pwFor.must_change });
      setPwFor(null);
      setMsg({ ok: r.ok, text: `${pwFor.staff.name}さん：${r.message}` });
      await load();
    } catch (e) { setPwErr((e as Error).message); setPwFor(p => p && { ...p, password: "" }); }
    finally { setBusy(false); }
  }

  async function stopResume(s: Staff, kind: "stop" | "resume") {
    if (kind === "stop" && !confirm(`${s.name}さんのログインを止めますか？\nすぐにログインできなくなります（データは消えません）。`)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await repo.staffLoginAction(kind === "stop" ? { kind, staff_id: s.id, reason: "manual" } : { kind, staff_id: s.id });
      setMsg({ ok: r.ok && !r.not_stopped, text: `${s.name}さん：${r.message}` });
      await load();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  const pwEmail = pwFor ? pwFor.staff.email || info(pwFor.staff.id)?.email || "" : "";
  const pwOk = !!pwFor && passwordStrength(pwFor.password, pwEmail).level > 0;

  return (
    <SettingsFrame title="設定" isAdmin={isOwner} denied="この画面（ユーザーの追加・パスワードの変更）はオーナーだけが使えます。ログインのことで困ったときは、オーナーに連絡してください。">
      <div className="text-sm text-ink-soft mb-3 leading-relaxed">
        ここで作ったユーザーは、<b>メールアドレスとパスワード</b>でこのアプリにログインできます。パスワードはオーナーが決めて、本人に伝えてください。
        仮パスワードを発行するやり方は <Link href="/settings/staff" className="underline text-canopy">設定＞スタッフ</Link> のまま使えます。
      </div>
      {login && !server && (
        <div className="mb-3 text-sm px-3 py-2 rounded bg-amber-50 border border-amber-300 text-amber-900">
          サーバの設定（Vercel の環境変数 <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span>）がまだのため、ユーザーの追加・パスワードの変更はできません。一覧だけ表示しています。
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button className="btn-primary min-h-11" disabled={!server || busy} onClick={() => openAdd()} data-testid="user-add">＋ユーザーを追加</button>
        {login?.demo && <span className="chip bg-amber-400 text-stone-900 font-bold">デモ</span>}
        <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={showRetired} onChange={e => setShowRetired(e.target.checked)} />退職した人も表示{retired ? `（${retired}名）` : ""}</label>
      </div>
      {msg && <div className={`mb-2 text-sm ${msg.ok ? "text-emerald-700" : "text-rose-600"}`} role="status" data-testid="user-msg">{msg.text}</div>}

      <div className="space-y-1.5" data-testid="user-list">
        {shown.length === 0 && <div className="card text-sm text-stone-500">まだだれもいません。「＋ユーザーを追加」から作れます。</div>}
        {shown.map(s => {
          const i = info(s.id); const st = statusOf(s, i, server);
          const email = i?.email || s.email;
          const hasLogin = st.label === "ログイン可" || st.label === "停止中";
          const self = !!me && (me.id === s.id || (!!me.auth_user_id && me.auth_user_id === s.auth_user_id));
          return (
            <div key={s.id} className={`card py-2 flex flex-wrap items-center gap-2 ${s.active === false ? "opacity-60 bg-stone-50" : ""}`} data-testid="user-row">
              <div className="flex-1 min-w-[12rem]">
                <div className="font-semibold flex flex-wrap items-center gap-x-2">{s.name}
                  <span className="text-xs font-normal text-stone-600">{ROLE_LABEL[s.role]}</span>
                  {self && <span className="text-[11px] font-normal text-ink-mute">（あなた）</span>}
                </div>
                <div className="text-xs text-stone-500 flex flex-wrap gap-x-2">
                  {email ? <span className="font-mono break-all">{email}</span> : <span>メールなし</span>}
                  {st.label === "ログイン可" && (i?.must_change ? <span className="text-[#7a4f12]">最初のログインで自分のパスワードに変更</span>
                    : i?.last_sign_in_at ? <span>最後のログイン：{fmt(i.last_sign_in_at)}</span> : server ? <span>まだログインしていません</span> : null)}
                </div>
              </div>
              <span className={`text-[11px] px-1.5 rounded ${st.cls}`} data-testid="user-status">{st.label}</span>
              {server && s.active !== false && !self && (
                <div className="flex flex-wrap gap-1.5 w-full sm:w-auto justify-end">
                  {st.label === "未発行" && !why("create_user", s) && <button className="btn" disabled={busy} onClick={() => openAdd(s.id)}>ログインを作る</button>}
                  {st.label === "ログイン可" && !why("set_password", s) && <button className="btn" disabled={busy} onClick={() => { setPwErr(""); setMsg(null); setPwFor({ staff: s, password: "", must_change: true }); }} data-testid="user-setpw">パスワードを変更</button>}
                  {st.label === "ログイン可" && !why("stop", s) && <button className="btn text-danger" disabled={busy} onClick={() => stopResume(s, "stop")}>ログインを止める</button>}
                  {st.label === "停止中" && !why("resume", s) && <button className="btn" disabled={busy} onClick={() => stopResume(s, "resume")}>再開</button>}
                  {hasLogin && s.role === "owner" && <span className="text-[11px] text-ink-mute self-center">オーナーのログインはここでは変えられません</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-[11px] text-stone-500 mt-2 leading-relaxed">
        退職は <Link href="/settings/staff" className="underline text-canopy">設定＞スタッフ</Link> でその人を「退職」にして保存してください（ログインも自動で止まります）。自分のログインは、ここでは止めたり変えたりできません。
      </div>
      <LoginHistoryList list={login?.history} />

      {form && (
        <div className="fixed inset-0 bg-black/30 z-40 flex items-end sm:items-center justify-center" onClick={closeAdd}>
          <form className="bg-white w-full sm:max-w-lg rounded-t-xl sm:rounded-xl p-4 max-h-[94vh] overflow-auto space-y-3" onClick={e => e.stopPropagation()} onSubmit={submitAdd} autoComplete="off" data-testid="user-form">
            <div className="flex items-center justify-between"><h2 className="font-bold">ユーザーを追加</h2><button type="button" className="btn" onClick={closeAdd}>閉じる</button></div>
            {noLogin.length > 0 && (
              <div className="flex border rounded overflow-hidden text-sm" role="radiogroup" aria-label="だれのユーザー？">
                <button type="button" role="radio" aria-checked={form.mode === "new"} className={`flex-1 px-3 py-2 ${form.mode === "new" ? "bg-stone-800 text-white" : "bg-white"}`} onClick={() => setForm({ ...form, mode: "new", staff_id: "" })}>新しい人</button>
                <button type="button" role="radio" aria-checked={form.mode === "existing"} className={`flex-1 px-3 py-2 border-l ${form.mode === "existing" ? "bg-stone-800 text-white" : "bg-white"}`} onClick={() => setForm({ ...form, mode: "existing", staff_id: form.staff_id || noLogin[0].id })}>今のスタッフ（ログインなし）</button>
              </div>
            )}
            {form.mode === "existing" ? (
              <Field label="スタッフ" hint="名前・役割は今のまま。変えるときは 設定＞スタッフ で">
                <select className="inp w-full min-h-11" value={form.staff_id} onChange={e => setForm({ ...form, staff_id: e.target.value })}>
                  {noLogin.map(s => <option key={s.id} value={s.id}>{s.name}（{ROLE_LABEL[s.role]}）</option>)}
                </select>
              </Field>
            ) : (
              <div className="grid sm:grid-cols-2 gap-3">
                <Field label="名前（ログインした人として記録に出る名前）"><input className="inp w-full min-h-11" maxLength={40} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} data-testid="user-name" /></Field>
                <Field label="役割" hint={ROLE_HINT[form.role]}>
                  <select className="inp w-full min-h-11" value={form.role} onChange={e => setForm({ ...form, role: e.target.value as UserRole })} data-testid="user-role">
                    {USER_ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                </Field>
              </div>
            )}
            <Field label="メールアドレス（ログインのID）">
              <input type="email" inputMode="email" autoComplete="off" autoCapitalize="off" className="inp w-full min-h-11" placeholder="例：takesue@example.com" value={form.email} onChange={e => { setForm({ ...form, email: e.target.value }); setFormErr(null); }} data-testid="user-email" />
              {suggestion && !form.email && <span className="block text-[11px] text-ink-soft mt-0.5">本人のメールが無いときは「お店のGmail＋名前」も使えます <button type="button" className="underline text-canopy" onClick={() => setForm({ ...form, email: suggestion })}>{suggestion} を入れる</button></span>}
            </Field>
            <div>
              <label className="lbl" htmlFor="user-pw">パスワード（{MIN_PASSWORD}文字以上・オーナーが決める）</label>
              <PasswordInput id="user-pw" value={form.password} email={formEmail} onChange={v => setForm({ ...form, password: v })} />
              <div className="text-[11px] text-ink-mute mt-1">よく使われる言葉・「12345…」のような並び・メールアドレスと同じ言葉は使えません。</div>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="w-5 h-5 mt-0.5" checked={form.must_change} onChange={e => setForm({ ...form, must_change: e.target.checked })} data-testid="user-mustchange" />
              <span>最初のログインで自分のパスワードに変えてもらう
                <span className="block text-[11px] text-ink-mute">{form.must_change ? "おすすめ。本人だけが知っているパスワードになります" : "オフ：決めたパスワードのまま使えます（テスト用のユーザーや、オーナーがパスワードを管理するとき向け）"}</span></span>
            </label>
            {form.mode === "new" && <div className="text-[11px] text-ink-mute">ここで作るユーザーはログイン・操作のためのものです。予約台帳やネット予約には出ません（施術する人は 設定＞スタッフ で登録します）。</div>}
            {formErr && (
              <div className={`text-sm px-3 py-2 rounded ${formErr.exists ? "bg-amber-50 border border-amber-300 text-amber-900" : "text-rose-600"}`} role="alert" data-testid="user-form-err">
                {formErr.text}
                {formErr.exists && <div className="mt-1.5"><button type="button" className="btn" onClick={() => { setForm({ ...form, email: "" }); setFormErr(null); }}>別のメールにする</button></div>}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn" onClick={closeAdd}>やめる</button>
              <button type="submit" className="btn-primary min-h-11" disabled={busy || !formOk} data-testid="user-submit">{busy ? "作っています…" : "ユーザーを作る"}</button>
            </div>
          </form>
        </div>
      )}

      {pwFor && (
        <div className="fixed inset-0 bg-black/30 z-40 flex items-end sm:items-center justify-center" onClick={() => setPwFor(null)}>
          <form className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl p-4 space-y-3" onClick={e => e.stopPropagation()} onSubmit={submitPw} autoComplete="off" data-testid="pw-form">
            <div className="flex items-center justify-between"><h2 className="font-bold">{pwFor.staff.name}さんのパスワードを変更</h2><button type="button" className="btn" onClick={() => setPwFor(null)}>閉じる</button></div>
            {pwEmail && <div className="text-xs text-ink-soft">ログインのメール：<span className="font-mono break-all">{pwEmail}</span></div>}
            <div>
              <label className="lbl" htmlFor="user-newpw">新しいパスワード（{MIN_PASSWORD}文字以上）</label>
              <PasswordInput id="user-newpw" value={pwFor.password} email={pwEmail} onChange={v => setPwFor({ ...pwFor, password: v })} />
            </div>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="w-5 h-5 mt-0.5" checked={pwFor.must_change} onChange={e => setPwFor({ ...pwFor, must_change: e.target.checked })} />
              <span>次のログインで自分のパスワードに変えてもらう<span className="block text-[11px] text-ink-mute">{pwFor.must_change ? "おすすめ" : "オフ：このパスワードのまま使えます（テスト用・オーナーが管理するとき）"}</span></span>
            </label>
            <div className="text-[11px] text-ink-mute">変えると、その人が今ログインしている端末はログアウトされます。</div>
            {pwErr && <div className="text-sm text-rose-600" role="alert">{pwErr}</div>}
            <div className="flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setPwFor(null)}>やめる</button>
              <button type="submit" className="btn-primary min-h-11" disabled={busy || !pwOk} data-testid="pw-submit">{busy ? "変えています…" : "パスワードを変える"}</button>
            </div>
          </form>
        </div>
      )}
    </SettingsFrame>
  );
}
