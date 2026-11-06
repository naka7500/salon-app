# salon-app（ラシエル箱崎から始める 自社予約・POS）

フェーズ1：予約台帳／会計（POS・赤伝）／レジ締め／顧客・カルテ（手書き）／在庫／売上レポート  
以降：HPB往復 → LINE連携 → お客様向けネット予約 → 分析 → Bokun連携

## 1. まず動かす（デモモード・設定不要）
```
npm install
npm run dev
```
http://localhost:3000 を開く。データは端末内（ブラウザ）に保存されるデモです。
画面右上に「デモ（端末内保存）」と出ます。

## 2. 本番（Supabase + Vercel）
1. https://supabase.com で無料プロジェクトを作る（リージョン: Tokyo）
2. SQL Editor で `supabase/migrations/0001_schema.sql` を実行 → 次に `supabase/seed_hakozaki.sql` を実行
3. Settings → API の URL と anon key を控える
4. `.env.example` をコピーして `.env.local` を作り、値を入れる（このファイルはGitにもDropboxにも入れない）
5. `npm run dev` で右上が「本番」に変わればOK
6. 公開は https://vercel.com で「Import Project」→ 環境変数に同じ3つを入れる → Deploy

### ログイン（v0.4）
- 本番モード（環境変数あり）では、メール＋パスワードのログインが必須。デモモードは不要。
- `supabase/migrations/0003_auth.sql` を SQL Editor で実行（staff にメール列・初回ログイン時の自動紐づけ・未ログインからの読み取り禁止）。
- アカウント発行：Supabase → Authentication → Users →「Add user」→ メールとパスワード（Auto Confirm にチェック）。メールが staff.email と一致すると、初回ログインでその店のデータが見えるようになる。
- 一般のサインアップは閉じる：Authentication → Sign In / Providers → 「Allow new users to sign up」をオフ。

### 職場PCからの起動
- Node.js 20以上を入れる → このフォルダで `npm install` → `npm run dev`
- 店のiPadからは Vercel の URL を開き「ホーム画面に追加」（PWA）

## 3. 画面
| 画面 | できること |
|---|---|
| 予約台帳 | 日別タイムライン（15分刻み・スタッフ列）。空き枠クリックで予約作成。チャネル色分け（自社/HPB/電話/Viator/Klook/一休/LINE/ブロック） |
| 会計 | 当日の未会計予約から選ぶ or 単発。メニュー・店販追加、値引、併用支払、お釣り計算、赤伝（取消） |
| レジ締め | 技術/店販/総売上、支払手段別、現金実査（釣銭準備金・あるべき現金・過不足）、日次締めでロック、会計用CSV |
| 顧客・カルテ | 検索・新規登録、来店/会計履歴、まつ毛カルテ（デザイン・本数・毛質…）、接客メモ、次回提案、手書き（指・ペン） |
| 在庫 | 在庫一覧（発注点を下回ると要発注）、入荷/調整/返品/棚卸、履歴。店販を売ると自動で減る |
| 売上 | 月別：総売上・客数・客単価・新規・月末ペース、スタッフ別（指名・次回予約率）、日別 |

## 4. 構成
- Next.js 16 / TypeScript / Tailwind v4
- `src/lib/db/types.ts` … データ型と Repo インターフェース
- `src/lib/db/memory.ts` … デモ用（localStorage）
- `src/lib/db/supabase.ts` … 本番用（Supabase）
- `supabase/migrations/0001_schema.sql` … テーブル・RLS・トリガー（売上番号採番、在庫自動減算、予約履歴）
- `supabase/seed_hakozaki.sql` … ラシエル箱崎の初期データ（スタッフ・ベッド・メニュー・商品）

## 5. 守ること
- カード番号・パスワードは一切保存しない（支払は手段と金額だけ）
- `.env.local` は共有しない
- 締め後の伝票は赤伝でしか直せない（監査ログに残る）

## 6. 2026-11-04 更新（v0.3）カミングスーン型の日表示
- 予約台帳を横型（時間が横・15分刻み）に変更。行＝受付枠（1名様／2名様ペア）＋スタッフ
- 行の上をドラッグ→ IDLE（受付中）／×（受付停止）／BREAK／保証／予約 を置く。ブロックはクリックで変更・削除
- 週ストリップ・前日/今日/次日・メニュー略名・凡例（メニュー色）
- デモモードはヘッダー右の店舗切替で「KOKAGE西五反田」「ラシエル箱崎」を行き来できる（データは店舗ごとに端末内保存）
- 本番DBは `supabase/migrations/0002_lanes_blocks.sql` を 0001 の後に実行
- 職場PCで試す： このフォルダで `npm install` → `npm run dev` → http://localhost:3000

## 7. 2026-11-05 更新（v0.8 フェーズC）メニュー・クーポン・公式ネット予約
- 本番DBは `supabase/migrations/0007_phase_c.sql` を Run（**0006 が未適用なら先に 0006**）。未適用でもアプリは落ちず、該当機能だけ「準備中」。
- 設定（オーナー・店長だけ）：`/settings`（店舗・ネット予約・問診）／`/settings/menus`／`/settings/coupons`（HPB用の文言コピー）
- お客様用ネット予約（ログイン不要）：`/r/<店舗のURL名>`（例 `/r/test-store`）。キャンセルは完了画面のリンク `/r/<URL名>/cancel/<トークン>`
- 安全のしくみ：未ログイン（anon）は表を直接読めない。使えるのは `public_store_info / public_menus / public_availability / public_create_booking / public_booking_by_token / public_cancel_booking` だけ（SECURITY DEFINER・入力検証・空きの再確認・店舗単位のロック・料金はサーバ計算・同じ電話番号の連続予約を拒否）。
- 締め後の赤伝は `reverse_sale()` 経由で owner・manager だけ。締め済み伝票の直接書き換え・削除はトリガーで拒否。赤伝は `audit_logs` に記録 → 売上台帳「修正履歴」タブ。
- 通知メール：今は `notifications` 表に積むだけ（予約台帳に「新しいネット予約 ○件」バッジ）。送るときは Vercel の環境変数に
  `SUPABASE_SERVICE_ROLE_KEY`・`RESEND_API_KEY`・`NOTIFY_FROM`・`NOTIFY_SECRET` を入れ、Vercel Cron などで
  `POST /api/notify`（ヘッダー `Authorization: Bearer <NOTIFY_SECRET>`）を5分ごとに呼ぶ。送信処理は `src/lib/notify/send.ts`（別サービスにするなら `resendSender` を差し替え）。
- デモモードでは右上の「ログイン中」で役割（オーナー／店長／スタッフ）を切り替えて権限の違いを試せる。公開予約ページも同じブラウザ内で台帳まで入る。

## 8. 2026-11-05 更新（v0.9）設定＞スタッフ
- 本番DBは `supabase/migrations/0008_staff_settings.sql` を Run（**0006 → 0007 の後**）。未適用でもアプリは落ちず、新しい項目だけ「準備中」（名前・役割・指名料・在籍・店舗は今も保存できる）。
- `/settings/staff`（オーナー・店長だけ）：名前・表示名（予約ページ用）・英語名・色・表示順（↑↓）・予約台帳に表示・ネット予約で指名可・指名料・役割・所属店舗＋ヘルプ店舗・在籍/退職。ログインのメールは表示だけ（招待は次の段階）。
- 退職＝今後は予約台帳・シフト・会計・ネット予約に出ない。過去の予約・売上・カルテ・集計には名前が残る。退職者に今後の予約が残っている日は、台帳に「退職」の行で出る（付け替え用）。履歴がある人は削除できない（外部キーで止まる）。
- DB側の権限：staff・staff_stores・menus・coupons の書き込みは owner・manager だけ（`my_role_in_company()`）。owner を作る・変えるのは owner だけ、自分の役割・在籍は自分で変えられない、ログインの紐づけ（auth_user_id）は画面から変えられない（トリガー `guard_staff_write`）。
- ネット予約：退職・台帳非表示の人には自動で割り当てない。指名は「指名可」の人だけ。表示名・英語名で出し、指名したときは指名料を料金に足す（会計にも「指名料」の行が自動で入る）。

## 8. 2026-11-06 更新（フェーズE-1）HPBの予約メールを自動で取り込む（取り込みだけ）
- 本番DBは `supabase/migrations/0011_hpb_inbound.sql` を Run（**0010 の後**。0010 が無いと最初で止まる）。未適用でもアプリは落ちず、設定＞HPB連携 だけ「準備中」。
- Vercel の環境変数に `SUPABASE_SERVICE_ROLE_KEY`（サーバだけで使う）。無いと `/api/inbound/hpb` は 501 で何もしない。
- 流れ：サロンボードの予約通知メール → `kokage.corp+hpb-<店>@gmail.com` → Google Apps Script（`tools/gas/hpb_forwarder.gs`・5分ごと）→ `POST /api/inbound/hpb`（ヘッダー `X-Inbound-Secret`）→ 台帳（経路HPB・予約番号）＋受信ログ。手順は `docs/HPB連携_設定手順.md`。
- 読み取り：`src/lib/inbound/hpb.ts`（見出しの言葉・予約番号の形・件名の言葉は表で変えられる。設定画面の「読み取りの調整」でも足せる）。反映：`src/lib/inbound/process.ts`（本番とデモで同じ）。
- 空きが無くても断らない（HPBはもうお客様を受けている）→ 予約は入れて赤い印「⚠重複」（bookings.alert='double_booking'）。読めないメールは台帳に入れず「要確認」→ 受信ログで「手で直す」「再処理」。
- サロンボードへの書き込み（枠閉じ）は作っていない（E-2・利用規約の確認待ち）。
- 単体テスト：`npm test`（vitest）。
