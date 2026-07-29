# rieki-check-app

値上げ検知ダッシュボードのNext.jsアプリ。

## これは何か

Supabaseの `rieki-check` プロジェクトに入っている `v_price_increase_alerts` というビュー(値上げが検知された取引の一覧)を読み込んで、Web画面に表示します。また `/upload` ページから、基幹システム出力のCSV(売上・仕入)をアップロードして `sales_lines` / `purchase_lines` テーブルを更新できます(同じ受注番号・仕入番号の行は自動的に上書き=upsertされ、重複しません)。

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

## データ更新(CSVアップロード)

トップページ右上の「データ更新」から `/upload` へ移動できます。

- 売上データ: `uriage.csv` と同じ列構成(shift_jis / CP932エンコーディング)のCSVを選択してください。
- 仕入データ: 仕入実績データと同じ列構成(55列)のCSVを選択してください。

アップロードすると、ブラウザ内で1,000行ずつに分割してAPI(`/api/upload/sales`, `/api/upload/purchase`)に送信し、Supabase側で upsert します。売上側は(受注番号, 受注行番号, 納品書番号, 納品書行数)、仕入側は(仕入番号, 仕入行番号)の組み合わせが同じ行は上書きされ、重複は発生しません。

## 今後の予定

- 拠点・得意先・仕入先などでの絞り込み機能の拡充
