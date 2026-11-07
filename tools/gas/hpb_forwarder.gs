/**
 * HPB予約メール → 自社アプリ（salon-app）への転送（Google Apps Script・kokage.corp の Gmail で動かす・無料）
 *
 * やること：決まった宛先（例 kokage.corp+hpb-test-store@gmail.com）に届いたHPBの予約通知メールを数分おきに探し、
 *           件名・本文・日時・メールID をアプリの受け口（/api/inbound/hpb）へ送る。送れたメールには「HPB取込済」ラベルを付ける。
 *           ※サロンボードには何もしない（読むのは自分の Gmail だけ）。メールの送信もしない。
 *
 * 設定（プロジェクトの設定 → スクリプト プロパティ）
 *   WEBHOOK_URL  … 例 https://salon-app-alpha-seven.vercel.app/api/inbound/hpb
 *   SECRET       … 設定＞HPB連携 で作った合言葉（店舗ごと。人に見せない）
 *   PLUS_ADDRESS … 設定＞HPB連携 で作った受信アドレス（例 kokage.corp+hpb-7kq2m9xw4hfp@gmail.com。店ごとにランダム。人に見せない）
 *   FROM_DOMAINS … HPB（サロンボード）の通知メールの送り主のドメイン（カンマ区切り）。
 *                  ★要確認：本物の通知メールの「送信元」を見て入れてください。空なら salonboard.com,beauty.hotpepper.jp
 *                  （アプリの 設定＞HPB連携＞送り主の許可リスト と同じにする）
 *   DRY_RUN      … true＝試し（アプリは読むだけで保存しない・ラベルも付けない。結果はログに出る）／false＝本番
 *   （任意）QUERY … 探す条件を自分で決めるとき。必ず to: と from: を両方入れる（入っていないと動きません）
 *   （任意）LABEL … 送れたメールに付けるラベル名（既定 HPB取込済）
 *
 * 送るもの：件名・本文・日時・メールID・From（そのまま）・Gmail が付けた認証結果（Authentication-Results の一番上＝DKIM/SPF の結果）。
 *           アプリは From のドメインと認証結果を確かめ、HPB からでないメールは台帳に入れず受信ログに「拒否」で残します。
 *
 * 使い方：①上の値を入れる ②関数「listOnly」→「testLatest」を実行（直近の1通を試しで送り、読み取り結果と送り主の判定をログに出す）
 *         ③うまく読めたら DRY_RUN=false にして、関数「installTrigger」を1回実行（5分ごとに自動で動く）
 */

var DEFAULT_LABEL = 'HPB取込済';
var MAX_PER_RUN = 30;          // 1回に送る最大の通数
var KEEP_IDS = 400;            // 送ったメールIDを覚えておく数（同じメールを2回送らないため。アプリ側でも重複は無視される）
var DEFAULT_FROM_DOMAINS = 'salonboard.com,beauty.hotpepper.jp';   // ★要確認（本物の通知メールの送り主で確かめる）

function fromDomains_(s) {
  return String(s || DEFAULT_FROM_DOMAINS).split(/[\s,]+/).map(function (d) { return d.trim().toLowerCase().replace(/^.*@/, ''); })
    .filter(function (d) { return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d); });
}
/** 探す条件：宛先（店ごとのランダムなアドレス）と 送り主（HPBのドメイン）の両方で絞る */
function buildQuery_(plus, domains) {
  return 'to:' + plus + ' from:(' + domains.join(' OR ') + ') newer_than:2d';
}

function props_() {
  var p = PropertiesService.getScriptProperties();
  var plus = (p.getProperty('PLUS_ADDRESS') || '').trim().toLowerCase();
  var domains = fromDomains_(p.getProperty('FROM_DOMAINS'));
  var query = (p.getProperty('QUERY') || '').trim();
  var cfg = {
    url: (p.getProperty('WEBHOOK_URL') || '').trim(),
    secret: (p.getProperty('SECRET') || '').trim(),
    query: query || (plus ? buildQuery_(plus, domains) : ''),
    dryRun: String(p.getProperty('DRY_RUN') || 'true').toLowerCase() !== 'false',
    label: (p.getProperty('LABEL') || DEFAULT_LABEL).trim()
  };
  if (!cfg.url || !cfg.secret) throw new Error('スクリプト プロパティに WEBHOOK_URL / SECRET を入れてください');
  if (!cfg.query) throw new Error('スクリプト プロパティに PLUS_ADDRESS（設定＞HPB連携 の受信アドレス）を入れてください');
  if (!/(^|\s)to:/i.test(cfg.query) || !/(^|\s)from:/i.test(cfg.query)) throw new Error('QUERY には to:（受信アドレス）と from:（HPBの送り主）の両方を入れてください。分からなければ QUERY を消して PLUS_ADDRESS と FROM_DOMAINS だけにしてください');
  if (/\+hpb-[a-z0-9-]*@/i.test(cfg.query) && !/\+hpb-[a-z0-9]{10,}@/i.test(cfg.query)) console.log('注意：受信アドレスが推測されやすい形です。設定＞HPB連携 で新しいランダムなアドレスを作り、サロンボードの通知先も入れ替えてください');
  return cfg;
}

function doneIds_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('DONE_IDS') || '[]'); } catch (e) { return []; }
}
function saveDoneIds_(ids) {
  PropertiesService.getScriptProperties().setProperty('DONE_IDS', JSON.stringify(ids.slice(-KEEP_IDS)));
}

/** Gmail が付けた一番上の Authentication-Results（送り主が書いた偽物は下に来るので、一番上だけを使う） */
function authResults_(msg) {
  try {
    var raw = msg.getRawContent();
    var end = raw.search(/\r?\n\r?\n/);
    var head = (end >= 0 ? raw.slice(0, end) : raw.slice(0, 20000)).replace(/\r?\n[ \t]+/g, ' ');
    var lines = head.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/^Authentication-Results:\s*(.*)$/i);
      if (m) return m[1].slice(0, 4000);
    }
  } catch (e) { console.log('認証結果を読めませんでした：' + e); }
  return '';
}

function send_(cfg, msg, dryRun) {
  var payload = {
    messageId: msg.getId(),
    subject: msg.getSubject(),
    body: msg.getPlainBody() || msg.getBody(),
    date: msg.getDate().toISOString(),
    from: msg.getFrom(),
    authResults: authResults_(msg),
    dryRun: !!dryRun
  };
  var res = UrlFetchApp.fetch(cfg.url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'X-Inbound-Secret': cfg.secret },
    payload: JSON.stringify(payload)
  });
  return { code: res.getResponseCode(), text: res.getContentText() };
}

/** 5分ごとに動かす本体 */
function processHpbMails() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { console.log('前の実行がまだ動いているので今回は休みます'); return; }
  try {
    var cfg = props_();
    var done = doneIds_();
    var label = GmailApp.getUserLabelByName(cfg.label) || GmailApp.createLabel(cfg.label);
    var threads = GmailApp.search(cfg.query, 0, 50);
    var msgs = [];
    threads.forEach(function (t) { t.getMessages().forEach(function (m) { if (done.indexOf(m.getId()) < 0) msgs.push({ m: m, t: t }); }); });
    msgs.sort(function (a, b) { return a.m.getDate() - b.m.getDate(); });   // 古い順（新規 → 変更 → キャンセル の順に届くように）
    var sent = 0;
    for (var i = 0; i < msgs.length && sent < MAX_PER_RUN; i++) {
      var m = msgs[i].m;
      var r = send_(cfg, m, cfg.dryRun);
      console.log((cfg.dryRun ? '[試し] ' : '') + r.code + ' ' + m.getSubject() + ' → ' + r.text.slice(0, 500));
      if (cfg.dryRun) continue;                                // 試しのときは覚えない・ラベルも付けない
      if (r.code >= 200 && r.code < 300) {
        done.push(m.getId()); msgs[i].t.addLabel(label); sent++;
        if (r.text.indexOf('"rejected":true') >= 0) console.log('→ アプリが拒否しました（送り主を確認できない）。本物のHPBのメールなら FROM_DOMAINS とアプリの許可リストを確かめてください');
      } else if (r.code === 401) {
        throw new Error('合言葉（SECRET）が違います。設定＞HPB連携 で作った合言葉を入れ直してください');
      } else if (r.code === 501 || r.code === 503) {
        throw new Error('アプリ側の準備がまだです（' + r.text.slice(0, 200) + '）');
      } else if (r.code === 400 || r.code === 413) {
        done.push(m.getId());                                  // 送り直しても通らない内容（空のメールなど）は飛ばす
      }
      // 500 などは覚えずに、次回もう一度送る
    }
    saveDoneIds_(done);
  } finally { lock.releaseLock(); }
}

/** 試し：条件に合う一番新しい1通を「試し」で送り、アプリの読み取り結果をログに出す（保存しない） */
function testLatest() {
  var cfg = props_();
  var threads = GmailApp.search(cfg.query, 0, 5);
  if (!threads.length) { console.log('条件に合うメールがありません（条件：' + cfg.query + '）。PLUS_ADDRESS・FROM_DOMAINS を確認するか、サロンボードからテスト予約の通知を待ってください'); return; }
  var msgs = threads[0].getMessages(); var m = msgs[msgs.length - 1];
  var r = send_(cfg, m, true);
  console.log(r.code + ' ' + m.getSubject());
  console.log(r.text);
}

/** 見るだけ：条件に合うメールの件名を一覧でログに出す（どこにも送らない） */
function listOnly() {
  var cfg = props_();
  console.log('探す条件：' + cfg.query);
  GmailApp.search(cfg.query, 0, 20).forEach(function (t) { t.getMessages().forEach(function (m) { console.log(m.getDate().toISOString() + ' ' + m.getSubject() + ' 送り主:' + m.getFrom() + ' ' + m.getId()); }); });
}

/** 5分ごとの自動実行を入れる（1回だけ実行。何度実行しても1つだけになる） */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'processHpbMails') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processHpbMails').timeBased().everyMinutes(5).create();
  console.log('5分ごとに processHpbMails を動かすようにしました');
}

/** 自動実行を止める */
function removeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'processHpbMails') ScriptApp.deleteTrigger(t); });
  console.log('自動実行を止めました');
}
