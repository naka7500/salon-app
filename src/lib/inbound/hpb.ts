// HPB（ホットペッパービューティー／サロンボード）の予約通知メールを読む（取り込み専用・フェーズE-1）。
// 実物のメールの形はまだ手元に無いので、見出しの言葉・予約番号の形・件名の言葉はすべて表（設定）で変えられるようにしてある。
// 最初の本物のメールが届いたら、受信ログの「本文」を見て、足りない言葉をこの表か 設定＞HPB連携＞読み取りの調整 に足す。
//
// 方針
//  - 件名で種類を決める（細かい言葉→おおまかな言葉の順。例：「予約キャンセル通知」を「予約通知」より先に見る）
//  - 本文は「見出し：値」「■見出し（次の行に値）」「【見出し】値」のどれでも読めるように、行ごとに見出しを探す
//  - 全角・半角の違いは NFKC でそろえてから読む（全角数字・全角カッコ・半角カナ）
//  - 読めなかった項目は missing に入れる。大事な項目（予約番号・日時・名前）が無いときは ok=false（＝要確認。勝手に入れない）

export type HpbKind = "new" | "change" | "cancel" | "unknown";
export const HPB_KIND_LABEL: Record<HpbKind, string> = { new: "新規", change: "変更", cancel: "キャンセル", unknown: "不明" };

export interface HpbMailInput { subject: string; body: string; /** メールの日時（ISO）。年が書いていない日付の年を決めるのに使う */ date?: string | null }

export interface HpbParsed {
  kind: HpbKind;
  /** 種類をどこで判断したか */
  kindSource: "subject" | "body" | "none";
  reservationNo: string | null;
  /** 来店日 'YYYY-MM-DD'・開始 'HH:MM'・終了 'HH:MM'（書いてあれば） */
  date: string | null; start: string | null; end: string | null;
  /** 施術時間（分）。「所要時間」「施術時間」または開始〜終了から */
  durationMin: number | null;
  /** 日本時間（+09:00）の ISO */
  startIso: string | null;
  /** 変更通知の「変更前」の日時（書いてあれば） */
  prev: { date: string | null; start: string | null } | null;
  name: string | null; kana: string | null; phone: string | null;
  coupon: string | null; menu: string | null;
  /** 指名スタッフの名前（指名なしは null） */
  staff: string | null; nominated: boolean;
  /** 人数（ペア・2名 などの言葉があれば 2） */
  people: number; peopleHint: string | null;
  total: number | null; request: string | null;
  /** HPB のメールらしいか（ホットペッパー・サロンボードの文字があるか） */
  looksLikeHpb: boolean;
  /** 0〜1。大事な項目がそろっているほど高い */
  confidence: number;
  /** 読めなかった項目（日本語） */
  missing: string[];
  /** 気をつけること（推測で読んだ など） */
  warnings: string[];
  /** 自動で台帳に入れてよいか（false＝要確認） */
  ok: boolean;
}

export type FieldKey = "reservationNo" | "visit" | "duration" | "name" | "kana" | "phone" | "coupon" | "menu" | "staff" | "total" | "request" | "people";

export interface HpbParserConfig {
  /** 件名・本文で種類を決める言葉。上から順に見て、最初に当たったもの（細かい言葉を先に） */
  subjectRules: { kind: HpbKind; words: string[] }[];
  /** 予約番号の形（正規表現）。上から順に試す */
  reservationNoPatterns: string[];
  /** 見出しの言葉 */
  labels: Record<FieldKey, string[]>;
  /** ペア（2名）とみなす言葉（クーポン名・メニュー名の中） */
  pairWords: string[];
  /** 「指名なし」とみなす言葉 */
  noStaffWords: string[];
  /** HPB のメールらしい印 */
  hpbMarkers: string[];
}

export const DEFAULT_HPB_CONFIG: HpbParserConfig = {
  subjectRules: [
    // ※細かい言葉を先に。「予約キャンセル通知」「予約変更通知」は「予約通知」より先に判定する
    { kind: "cancel", words: ["キャンセル", "取消", "取り消し"] },
    { kind: "change", words: ["予約変更", "変更通知", "変更受付", "変更のお知らせ", "内容変更", "日時変更", "変更がありました"] },
    { kind: "new", words: ["予約通知", "新規予約", "予約受付", "予約が入りました", "予約確定", "ご予約のお知らせ", "予約連絡", "予約完了", "予約がありました"] },
  ],
  reservationNoPatterns: ["BE\\d{6,14}", "YH\\d{6,14}", "[A-Z]{2}\\d{8,14}"],
  labels: {
    reservationNo: ["予約番号", "予約No.", "予約No", "予約NO", "予約ID", "受付番号", "予約受付番号"],
    visit: ["来店日時", "ご来店日時", "来店予定日時", "予約日時", "ご予約日時", "来店日", "ご来店日", "予約日", "日時"],
    duration: ["施術時間", "所要時間", "所要時間目安", "所要時間(目安)", "施術時間(目安)"],
    name: ["氏名", "お名前", "お客様名", "お客様氏名", "予約者", "予約者名", "予約者氏名", "名前"],
    kana: ["氏名(カナ)", "氏名(フリガナ)", "お名前(カナ)", "お名前(フリガナ)", "お客様名(カナ)", "予約者名(カナ)", "フリガナ", "ふりがな", "カナ"],
    phone: ["電話番号", "お電話番号", "携帯電話番号", "携帯番号", "連絡先電話番号", "連絡先", "電話", "TEL", "Tel"],
    coupon: ["ご利用クーポン", "利用クーポン", "予約クーポン", "クーポン名", "クーポン"],
    menu: ["ご予約メニュー", "予約メニュー", "施術メニュー", "メニュー名", "メニュー"],
    staff: ["指名スタッフ", "担当スタッフ", "スタッフ指名", "スタッフ", "担当者", "指名", "担当"],
    total: ["お支払い予定金額", "お支払予定金額", "合計金額", "予定金額", "お会計予定金額", "お支払金額", "合計", "料金", "金額"],
    request: ["ご要望・ご相談", "サロンへの質問・要望", "質問・要望", "お客様からのご要望", "ご要望", "要望欄", "要望", "ご相談", "備考"],
    people: ["来店人数", "ご利用人数", "予約人数", "人数"],
  },
  pairWords: ["ペア", "2名", "二名", "お二人", "お2人", "おふたり", "2人", "ふたり", "カップル", "親子"],
  noStaffWords: ["指名なし", "指名無し", "指名しない", "指定なし", "指定無し", "なし", "無し", "フリー", "おまかせ", "お任せ", "-"],
  hpbMarkers: ["ホットペッパー", "HOT PEPPER", "HOTPEPPER", "HotPepper", "SALON BOARD", "サロンボード", "SALONBOARD", "hotpepper.jp"],
};

/** 設定画面で足せる調整（hpb_settings.parser_config）。足した言葉・形は既定より先に見る */
export interface HpbParserOverrides { reservationNoPatterns?: string[]; cancelWords?: string[]; changeWords?: string[]; newWords?: string[]; pairWords?: string[] }

export function mergeHpbConfig(o?: HpbParserOverrides | null, base: HpbParserConfig = DEFAULT_HPB_CONFIG): HpbParserConfig {
  if (!o) return base;
  const clean = (xs?: string[]) => (xs || []).map(s => s.trim()).filter(Boolean);
  const words = (k: HpbKind) => clean(k === "cancel" ? o.cancelWords : k === "change" ? o.changeWords : k === "new" ? o.newWords : []);
  const okRe = (s: string) => { try { new RegExp(s); return true; } catch { return false; } };
  return {
    ...base,
    subjectRules: base.subjectRules.map(r => ({ kind: r.kind, words: [...words(r.kind), ...r.words] })),
    reservationNoPatterns: [...clean(o.reservationNoPatterns).filter(okRe), ...base.reservationNoPatterns],
    pairWords: [...clean(o.pairWords), ...base.pairWords],
  };
}

// ---------------------------------------------------------------------------
// 文字をそろえる
// ---------------------------------------------------------------------------
/** HTML のメールなら文字だけにする（Apps Script は普通は文字だけの本文を送るが、念のため） */
export function htmlToText(s: string) {
  if (!/<(br|p|div|td|tr|table|span)\b/i.test(s)) return s;
  return s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
/** 全角→半角（数字・英字・カッコ・コロン）、半角カナ→全角、改行をそろえる、転送の「> 」を外す */
export function normText(s: string) {
  return htmlToText(s || "").normalize("NFKC").replace(/\r\n?/g, "\n").split("\n").map(l => l.replace(/^\s*(>\s?)+/, "").replace(/\s+$/, "")).join("\n");
}
const hira2kata = (s: string) => s.replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
/** 比べるための形（空白を消す・小文字・ひらがな→カタカナ） */
export const matchKey = (s: string | null | undefined) => hira2kata((s || "").normalize("NFKC").toLowerCase().replace(/[\s　・･]/g, ""));
const isKana = (s: string) => /^[゠-ヿ぀-ゟ\s　ー・]+$/.test(s.trim()) && /[゠-ヿ぀-ゟ]/.test(s);
export const normPhoneJp = (p: string | null | undefined) => { const d = (p || "").replace(/[^0-9]/g, ""); return /^81[0-9]{9,10}$/.test(d) ? "0" + d.slice(2) : d; };
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// 見出しと値を集める
// ---------------------------------------------------------------------------
interface Hit { key: FieldKey; value: string; line: number }
function collectFields(text: string, cfg: HpbParserConfig): { hits: Hit[]; lines: string[] } {
  const lines = text.split("\n");
  const all: { key: FieldKey; label: string }[] = [];
  (Object.keys(cfg.labels) as FieldKey[]).forEach(k => cfg.labels[k].forEach(l => all.push({ key: k, label: l.normalize("NFKC") })));
  all.sort((a, b) => b.label.length - a.label.length);
  const alt = all.map(x => escRe(x.label)).join("|");
  // 行頭の記号（■◆●・【[ など）→ 見出し → 閉じ記号 → 区切り（：:＝ や空白）→ 値
  const re = new RegExp(`^\\s*(?:[■□◆◇●○◎・▼▽▶►★☆*#\\-]+\\s*)?(?:[【\\[<〈《(]\\s*)?(${alt})\\s*(?:[】\\]>〉》)]\\s*[:=]?|\\s*[:=]|\\s|$)\\s*(.*)$`, "i");
  const sep = /^\s*[-=_─━―*~・.]{2,}\s*$/;
  const labelAt: ({ key: FieldKey; rest: string } | null)[] = lines.map(l => {
    const m = re.exec(l); if (!m) return null;
    const lab = all.find(x => x.label.toLowerCase() === m[1].toLowerCase()); if (!lab) return null;
    return { key: lab.key, rest: m[2].trim() };
  });
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const L = labelAt[i]; if (!L) continue;
    const multi = L.key === "request" || L.key === "coupon" || L.key === "menu";
    if (L.rest && !multi) { hits.push({ key: L.key, value: L.rest, line: i }); continue; }
    // 次の行から（次の見出し・区切り線・空行まで）
    const vals: string[] = L.rest ? [L.rest] : [];
    for (let j = i + 1; j < lines.length && j <= i + 20; j++) {
      if (labelAt[j] || sep.test(lines[j])) break;
      if (!lines[j].trim()) { if (vals.length) break; continue; }
      vals.push(lines[j].trim());
      if (!multi) break;
    }
    if (vals.length) hits.push({ key: L.key, value: vals.join(L.key === "request" ? "\n" : " "), line: i });
  }
  return { hits, lines };
}

// ---------------------------------------------------------------------------
// 日時・時間
// ---------------------------------------------------------------------------
interface DT { y: number | null; mo: number; d: number; h: number; mi: number; eh: number | null; emi: number | null }
const DT_RE = /(?:(\d{4})\s*[年/\-.]\s*)?(\d{1,2})\s*[月/\-.]\s*(\d{1,2})\s*日?\s*(?:[(（]\s*[^)）\n]{1,4}\s*[)）])?\s*(?:[,、]\s*)?(午前|午後|AM|PM)?\s*(\d{1,2})\s*[:時]\s*(\d{1,2})?\s*分?(?:\s*(?:[~〜～\-–―ー]|から)\s*(午前|午後)?\s*(\d{1,2})\s*[:時]\s*(\d{1,2})?\s*分?)?/i;
function findDT(s: string): DT | null {
  const m = DT_RE.exec(s); if (!m) return null;
  let h = Number(m[5]); const mi = Number(m[6] || 0);
  if (/午後|PM/i.test(m[4] || "") && h < 12) h += 12;
  let eh: number | null = m[8] ? Number(m[8]) : null; const emi = m[8] ? Number(m[9] || 0) : null;
  if (eh !== null && /午後/.test(m[7] || "") && eh < 12) eh += 12;
  if (eh !== null && eh < h && h >= 12 && eh + 12 > h) eh += 12;
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 29 || mi > 59) return null;
  return { y: m[1] ? Number(m[1]) : null, mo, d, h, mi, eh, emi };
}
function durationOf(s: string): number | null {
  let m = /(\d{1,2})\s*時間\s*(?:(\d{1,2})\s*分)?/.exec(s); if (m) return Number(m[1]) * 60 + Number(m[2] || 0);
  m = /(\d{1,3})\s*分/.exec(s); if (m) return Number(m[1]);
  m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s); if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}
const p2 = (n: number) => String(n).padStart(2, "0");
/** 年が無い日付：メールの日付の年。メールの日付より2か月以上前になるなら翌年 */
function withYear(dt: DT, mailDate: Date) {
  let y = dt.y ?? mailDate.getUTCFullYear();
  if (dt.y === null) {
    const cand = Date.UTC(y, dt.mo - 1, dt.d);
    if (cand < mailDate.getTime() - 60 * 86400000) y += 1;
  }
  return `${y}-${p2(dt.mo)}-${p2(dt.d)}`;
}
/** 日本時間の日付・時刻 → ISO（サーバの時刻設定に左右されない） */
export function jstIso(date: string, hm: string) { return new Date(`${date}T${hm}:00+09:00`).toISOString(); }

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
export function detectKind(subject: string, body: string, cfg: HpbParserConfig = DEFAULT_HPB_CONFIG): { kind: HpbKind; source: HpbParsed["kindSource"] } {
  const s = normText(subject);
  for (const r of cfg.subjectRules) if (r.words.some(w => w && s.includes(w.normalize("NFKC")))) return { kind: r.kind, source: "subject" };
  // 件名で分からないときは本文の最初の15行（「転送」などで件名が変わったとき）
  const head = normText(body).split("\n").slice(0, 15).join("\n");
  for (const r of cfg.subjectRules) if (r.words.some(w => w && head.includes(w.normalize("NFKC")))) return { kind: r.kind, source: "body" };
  return { kind: "unknown", source: "none" };
}

export function parseHpbMail(input: HpbMailInput, cfg: HpbParserConfig = DEFAULT_HPB_CONFIG): HpbParsed {
  const subject = normText(input.subject || "");
  const text = normText(input.body || "");
  const mailDate = input.date && !isNaN(Date.parse(input.date)) ? new Date(input.date) : new Date();
  const warnings: string[] = [];
  const { kind, source } = detectKind(input.subject || "", input.body || "", cfg);
  if (source === "body") warnings.push("件名で種類が分からなかったので、本文の言葉で判断しました");
  const { hits, lines } = collectFields(text, cfg);
  const first = (k: FieldKey) => hits.find(h => h.key === k)?.value ?? null;

  // ---- 変更前・変更後の区切り（変更通知） ----
  const afterIdx = lines.findIndex(l => /変更後/.test(l));
  const beforeIdx = lines.findIndex(l => /変更前/.test(l));
  const inAfter = (line: number) => afterIdx >= 0 && line >= afterIdx && (beforeIdx <= afterIdx || line < beforeIdx);
  const inBefore = (line: number) => beforeIdx >= 0 && line >= beforeIdx && (afterIdx <= beforeIdx || line < afterIdx);

  // ---- 予約番号 ----
  const pats = cfg.reservationNoPatterns.map(p => { try { return new RegExp(`(?:^|[^A-Za-z0-9])(${p})(?![A-Za-z0-9])`); } catch { return null; } }).filter((x): x is RegExp => !!x);
  let reservationNo: string | null = null;
  for (const h of hits.filter(h => h.key === "reservationNo")) {
    for (const re of pats) { const m = re.exec(h.value); if (m) { reservationNo = m[1]; break; } }
    if (!reservationNo) { const m = /[A-Za-z0-9][A-Za-z0-9\-]{5,24}/.exec(h.value); if (m) { reservationNo = m[0]; warnings.push(`予約番号「${m[0]}」は決まった形ではありませんでした（形の設定を確認）`); } }
    if (reservationNo) break;
  }
  if (!reservationNo) for (const re of pats) { const m = re.exec(`${subject}\n${text}`); if (m) { reservationNo = m[1]; warnings.push("予約番号は見出しが無かったので、本文から形で探しました"); break; } }

  // ---- 来店日時（変更通知は「変更後」） ----
  const visitHits = hits.filter(h => h.key === "visit");
  const pickVisit = (want: "after" | "before" | "any") => {
    const cands = visitHits.filter(h => want === "any" ? true : want === "after" ? inAfter(h.line) : beforeIdx >= 0 ? inBefore(h.line) : /→|⇒|=>|->|変更前/.test(h.value));
    for (const h of cands) {
      let v = h.value;
      if (want !== "before") { const a = v.search(/変更後/); if (a >= 0) v = v.slice(a); else { const ar = v.search(/→|⇒|=>|->/); if (ar >= 0) v = v.slice(ar + 1); } }
      else { const a = v.search(/変更前/); if (a >= 0) v = v.slice(a); const ar = v.search(/→|⇒|=>|->/); if (ar >= 0) v = v.slice(0, ar); }
      const dt = findDT(v); if (dt) return dt;
    }
    return null;
  };
  let dt: DT | null = null; let prevDt: DT | null = null;
  if (kind === "change" && afterIdx >= 0) {
    dt = pickVisit("after");
    if (!dt) { const seg = lines.slice(afterIdx, beforeIdx > afterIdx ? beforeIdx : undefined).join("\n"); dt = findDT(seg.replace(/変更後[:\s]*/, "")); }
    prevDt = pickVisit("before");
    if (!prevDt && beforeIdx >= 0) prevDt = findDT(lines.slice(beforeIdx, afterIdx > beforeIdx ? afterIdx : undefined).join("\n"));
  }
  if (!dt) {
    // 同じ行に「旧 → 新」と書いてある形も見る
    dt = pickVisit(kind === "change" ? "after" : "any") || pickVisit("any");
    if (kind === "change" && !prevDt) { const h = visitHits.find(x => /→|⇒|=>|->/.test(x.value) || /変更前/.test(x.value)); if (h) prevDt = pickVisit("before"); }
  }
  if (!dt) {
    const dt2 = findDT(text);
    if (dt2) { dt = dt2; warnings.push("来店日時の見出しが見つからず、本文の最初の日時を使いました"); }
  }
  let date: string | null = null, start: string | null = null, end: string | null = null;
  if (dt) { date = withYear(dt, mailDate); start = `${p2(dt.h)}:${p2(dt.mi)}`; if (dt.eh !== null) end = `${p2(dt.eh)}:${p2(dt.emi ?? 0)}`; }
  const prev = prevDt ? { date: withYear(prevDt, mailDate), start: `${p2(prevDt.h)}:${p2(prevDt.mi)}` } : null;

  // ---- 施術時間 ----
  let durationMin: number | null = null;
  const durHit = hits.find(h => h.key === "duration" && (kind !== "change" || afterIdx < 0 || inAfter(h.line))) || hits.find(h => h.key === "duration");
  if (durHit) durationMin = durationOf(durHit.value);
  if (durationMin === null) { const m = /(?:所要時間|施術時間)[^0-9\n]{0,8}((?:\d{1,2}\s*時間\s*)?(?:\d{1,3}\s*分)?)/.exec(text); if (m && m[1].trim()) durationMin = durationOf(m[1]); }
  if (durationMin === null && start && end) { const a = Number(start.slice(0, 2)) * 60 + Number(start.slice(3)), b = Number(end.slice(0, 2)) * 60 + Number(end.slice(3)); if (b > a) durationMin = b - a; }
  if (durationMin !== null && (durationMin < 5 || durationMin > 600)) { warnings.push(`施術時間 ${durationMin}分 は不自然なので使いません`); durationMin = null; }

  // ---- お名前 ----
  let name: string | null = null, kana: string | null = null;
  const rawName = first("name");
  if (rawName) {
    let v = rawName.replace(/\s*様\s*$/, "").replace(/\s*様\s*[(]/, "(").trim();
    const pm = /^(.*?)\s*[(]\s*([^)]+?)\s*[)]\s*(?:様)?$/.exec(v);
    if (pm && isKana(pm[2])) { v = pm[1].trim(); kana = pm[2].trim(); }
    else if (pm && isKana(pm[1]) && !isKana(pm[2])) { kana = pm[1].trim(); v = pm[2].trim(); }
    name = v || null;
  }
  const rawKana = first("kana");
  if (rawKana) kana = rawKana.replace(/\s*様\s*$/, "").trim() || kana;
  if (kana) kana = hira2kata(kana.replace(/　/g, " ").replace(/\s+/g, " "));
  if (name && isKana(name) && !kana) kana = hira2kata(name);
  if (name) name = name.replace(/　/g, " ").replace(/\s+/g, " ");

  // ---- 電話 ----
  let phone: string | null = null;
  const rawPhone = first("phone");
  if (rawPhone) { const m = /\+?\d[\d\-\s()]{7,18}\d/.exec(rawPhone); if (m) { const n = normPhoneJp(m[0]); if (n.length >= 10 && n.length <= 11) phone = n; } }

  // ---- クーポン・メニュー・スタッフ ----
  const cleanItem = (s: string | null) => (s ? s.replace(/\s+/g, " ").trim() || null : null);
  const coupon = cleanItem(first("coupon")); const menu = cleanItem(first("menu"));
  let staff: string | null = null; let nominated = false;
  const rawStaff = first("staff");
  if (rawStaff) {
    const v = rawStaff.replace(/[(（]\s*指名料[^)）]*[)）]/g, "").replace(/指名料.*$/, "").trim();
    const k = matchKey(v);
    const noStaff = !k || cfg.noStaffWords.some(w => k === matchKey(w) || (matchKey(w).length >= 3 && k.startsWith(matchKey(w))));
    if (!noStaff) { staff = v.replace(/\s*[(（]\s*(指名|指名あり)\s*[)）]\s*/g, "").replace(/\s*(さん|様)$/, "").trim() || null; nominated = !!staff; }
  }

  // ---- 人数 ----
  let people = 1; let peopleHint: string | null = null;
  const rawPeople = first("people");
  if (rawPeople) { const m = /(\d+)\s*(名|人)?/.exec(rawPeople); if (m && Number(m[1]) >= 1 && Number(m[1]) <= 4) { people = Number(m[1]); peopleHint = `人数：${rawPeople}`; } }
  if (people === 1) {
    const hay = `${coupon || ""} ${menu || ""}`.normalize("NFKC");
    const w = cfg.pairWords.find(x => x && hay.includes(x.normalize("NFKC")));
    if (w) { people = 2; peopleHint = `「${w}」`; }
  }

  // ---- 金額・要望 ----
  let total: number | null = null;
  for (const h of hits.filter(h => h.key === "total")) { const m = /[¥￥]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*円?/.exec(h.value); if (m) { total = Number(m[1].replace(/,/g, "")); break; } }
  const reqRaw = first("request");
  const request = reqRaw && !/^(なし|無し|特になし|特に無し|-|ー)$/.test(reqRaw.trim()) ? reqRaw.trim().slice(0, 1000) : null;

  const looksLikeHpb = cfg.hpbMarkers.some(m => `${subject}\n${text}`.toLowerCase().includes(m.normalize("NFKC").toLowerCase()));
  if (!looksLikeHpb) warnings.push("ホットペッパー・サロンボードの文字が見つかりません（HPB以外のメールかもしれません）");

  // ---- 足りない項目と自信の度合い ----
  const missing: string[] = [];
  if (kind === "unknown") missing.push("種類（新規・変更・キャンセル）");
  if (!reservationNo) missing.push("予約番号");
  if (!date || !start) missing.push("来店日時");
  if (!name && !kana) missing.push("お名前");
  if (!coupon && !menu) missing.push("クーポン・メニュー");
  let confidence = 0;
  if (kind === "cancel") confidence = (reservationNo ? 0.6 : 0) + (start ? 0.2 : 0) + (name || kana ? 0.1 : 0) + (looksLikeHpb ? 0.1 : 0);
  else if (kind !== "unknown") confidence = (reservationNo ? 0.3 : 0) + (start ? 0.35 : 0) + (name || kana ? 0.15 : 0) + (coupon || menu ? 0.1 : 0) + (looksLikeHpb ? 0.1 : 0);
  confidence = Math.round(confidence * 100) / 100;
  const ok = kind === "cancel" ? !!reservationNo : kind !== "unknown" && !!reservationNo && !!date && !!start && !!(name || kana);

  return { kind, kindSource: source, reservationNo, date, start, end, durationMin, startIso: date && start ? jstIso(date, start) : null, prev,
    name, kana, phone, coupon, menu, staff, nominated, people, peopleHint, total, request, looksLikeHpb, confidence, missing, warnings, ok };
}

/** 手で直した値（受信ログの「手で直す」）。parsed の上にかぶせる */
export interface HpbManualFix {
  kind?: HpbKind; reservationNo?: string; date?: string; start?: string; durationMin?: number | null;
  name?: string; kana?: string; phone?: string;
  /** 直接えらんだメニュー・担当・人数（対応表より優先） */
  menu_id?: string | null; staff_id?: string | null; people?: number | null;
}
export function applyManualFix(p: HpbParsed, f?: HpbManualFix | null): HpbParsed {
  if (!f) return p;
  const q: HpbParsed = { ...p, warnings: [...p.warnings] };
  if (f.kind) q.kind = f.kind;
  if (f.reservationNo?.trim()) q.reservationNo = f.reservationNo.trim();
  if (f.date) q.date = f.date;
  if (f.start) q.start = f.start.slice(0, 5);
  if (f.durationMin !== undefined && f.durationMin !== null) q.durationMin = f.durationMin;
  if (f.name !== undefined) q.name = f.name.trim() || null;
  if (f.kana !== undefined) q.kana = f.kana.trim() ? hira2kata(f.kana.trim()) : null;
  if (f.phone !== undefined) { const n = normPhoneJp(f.phone); q.phone = n.length >= 10 ? n : null; }
  if (f.people) q.people = f.people;
  q.startIso = q.date && q.start ? jstIso(q.date, q.start) : null;
  q.missing = q.missing.filter(m => !(m === "予約番号" && q.reservationNo) && !(m === "来店日時" && q.startIso) && !(m === "お名前" && (q.name || q.kana)) && !(m.startsWith("種類") && q.kind !== "unknown"));
  q.ok = q.kind === "cancel" ? !!q.reservationNo : q.kind !== "unknown" && !!q.reservationNo && !!q.startIso && !!(q.name || q.kana);
  q.warnings.push("手で直した値を使っています");
  return q;
}
