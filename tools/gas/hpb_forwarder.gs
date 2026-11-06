/**
 * HPB予約メール → 自社アプリ（salon-app）への転送（Google Apps Script・kokage.corp の Gmail で動かす・無料）
 *
 * やること：決まった宛先（例 kokage.corp+hpb-test-store@gmail.com）に届いたHPBの予約通知メールを数分おきに探し、
 *           件名・本文・日時・メールID をアプリの受け口（/api/inbound/hpb）へ送る。送れたメールには「HPB取込済」ラベルを付ける。
 *           ※サロンボードには何もしない（読むのは自分の Gmail だけ）。メールの送信もしない。
 *
 * 設定（プロジェクトの設定 → スクリプト プロパティ）
 *   WEBHOOK_URL … 例 https://salon-app-alpha-seven.vercel.app/api/inbound/hpb
 *   SECRET      … 設定＞HPB連携 で作った合言葉（店舗ごと。人に見せない）
 *   QUERY       … 探す条件。例 to:kokage.corp+hpb-test-store@gmail.com newer_than:2d
 *   DRY_RUN     … true＝試し（アプリは読むだけで保存しない・ラベルも付けない。結果はログに出る）／false＝本番
 *   （任意）LABEL … 送れたメールに付けるラベル名（既定 HPB取込済）
 *
 * 使い方：①上の4つを入れる ②関数「testLatest」を実行（直近の1通を試しで送り、読み取り結果をログに出す）
 *         ③うまく読めたら DRY_RUN=false にして、関数「installTrigger」を1回実行（5分ごとに自動で動く）
 */

var DEFAULT_LABEL = 'HPB取込済';
var MAX_PER_RUN = 30;          // 1回に送る最大の通数
var KEEP_IDS = 400;            // 送ったメールIDを覚えておく数（同じメールを2回送らないため。アプリ側でも重複は無視される）

function props_() {
  var p = PropertiesService.getScriptProperties();
  var cfg = {
    url: (p.getProperty('WEBHOOK_URL') || '').trim(),
    secret: (p.getProperty('SECRET') || '').trim(),
    query: (p.getProperty('QUERY') || '').trim(),
    dryRun: String(p.getProperty('DRY_RUN') || 'true').toLowerCase() !== 'false',
    label: (p.getProperty('LABEL') || DEFAULT_LABEL).trim()
  };
  if (!cfg.url || !cfg.secret || !cfg.query) throw new Error('スクリプト プロパティに WEBHOOK_URL / SECRET / QUERY を入れてください');
  return cfg;
}

function doneIds_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('DONE_IDS') || '[]'); } catch (e) { return []; }
}
function saveDoneIds_(ids) {
  PropertiesService.getScriptProperties().setProperty('DONE_IDS', JSON.stringify(ids.slice(-KEEP_IDS)));
}

function send_(cfg, msg, dryRun) {
  var payload = {
    messageId: msg.getId(),
    subject: msg.getSubject(),
    body: msg.getPlainBody() || msg.getBody(),
    date: msg.getDate().toISOString(),
    from: msg.getFrom(),
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
  if (!threads.length) { console.log('条件に合うメールがありません。QUERY を確認するか、サロンボードからテスト予約の通知を待ってください'); return; }
  var msgs = threads[0].getMessages(); var m = msgs[msgs.length - 1];
  var r = send_(cfg, m, true);
  console.log(r.code + ' ' + m.getSubject());
  console.log(r.text);
}

/** 見るだけ：条件に合うメールの件名を一覧でログに出す（どこにも送らない） */
function listOnly() {
  var cfg = props_();
  GmailApp.search(cfg.query, 0, 20).forEach(function (t) { t.getMessages().forEach(function (m) { console.log(m.getDate().toISOString() + ' ' + m.getSubject() + ' ' + m.getId()); }); });
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
