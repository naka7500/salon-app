# 前日確認（LINEの自動送信）を動かす設定：CRON_SECRET

結論：**いまの本番は、自動送信の入口が「未設定」で止まっています**（2026-11-15 に確認：`/api/line/cron` が 501 `not_configured`）。
プログラムの不具合ではなく、Vercel の環境変数 `CRON_SECRET` が入っていないためです。下の手順（10分）で動きます。

## 手順（社長）

1. 合言葉を作る：パスワード生成で **英数字40文字ほど**（記号なしが安全）。作った値はパスワード管理に控える。**このページやチャットには貼らない**
2. Vercel → プロジェクト `salon-app` → **Settings → Environment Variables**
   - Key：`CRON_SECRET`
   - Value：1 の合言葉
   - Environment：**Production** にチェック
   - Save
3. 同じ画面で `SUPABASE_SERVICE_ROLE_KEY` が入っているかも見る（HPB取り込みが動いていれば入っています）
4. **Deployments → いちばん上 → 「…」→ Redeploy**（環境変数は、デプロイし直すまで効きません）
5. 確かめる（どちらか）
   - ブラウザで `https://salon-app-alpha-seven.vercel.app/api/line/cron` を開く → **`unauthorized`（401）と出れば設定できています**（合言葉なしで開いたので断られた＝正常）。`not_configured` のままなら 2〜4 をやり直す
   - 翌日：Vercel → Logs で 18時台の `/api/line/cron` が **200** になっている

## 知っておくこと

- 自動送信が動くのは **1日1回・18時台**（Vercel の無料プランの決まり。18:00〜18:59 のどこか）
- 設定＞LINE連携 の「前日確認を送る時刻」は **18:00 のまま**にする。18:00 より後にすると1通も送られません（画面に赤字で出ます）
- 「再来案内」も同じ18時台に出ます（設定の 11:00 ではありません）
- `CRON_SECRET` を入れても、店舗の「LINE連携を使う」と、それぞれの自動メッセージをオンにするまでは、何も送られません
- 時刻を自由にしたい・1日に何回も動かしたいときは、Vercel を Pro にして `vercel.json` の時刻を変えます（別途ご相談）
