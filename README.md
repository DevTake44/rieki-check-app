# rieki-check-app

値上げ検知ダッシュボードのNext.jsアプリ（第1段階：一覧表示のみ）。

## これは何か

Supabaseの `rieki-check` プロジェクトに入っている `v_price_increase_alerts` というビュー(値上げが検知された取引の一覧)を読み込んで、Web画面に表示するだけのアプリです。CSVアップロードによるデータ更新機能はまだ含まれていません(次のステップで追加予定)。

## セットアップ手順

### 1. 環境変数の設定

`.env.local.example` をコピーして `.env.local` という名前で保存し、中身を実際の値に書き換えてください。

- `SUPABASE_URL` : SupabaseダッシュボードのProject Settings → API → Project URL
- `SUPABASE_SERVICE_ROLE_KEY` : 同じ画面にある service_role キー（絶対に他人に共有したり、ブラウザ側のコードに書いたりしないでください）

### 2. ローカルで動作確認する場合

```
npm install
npm run dev
```

`http://localhost:3000` を開くと一覧が表示されます。

### 3. Vercelにデプロイする場合

1. このリポジトリをVercelにImportする
2. Vercelのプロジェクト設定 → Environment Variables に、`.env.local` と同じ2つの変数(`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`)を設定する
3. デプロイする

## 今後の予定

- 売上・仕入CSVをアップロードして `sales_lines` / `purchase_lines` テーブルを日次更新できる画面を追加
- 拠点・得意先・仕入先などでの絞り込み機能を追加(既存のHTML版と同等の機能)
