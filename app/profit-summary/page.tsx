import ProfitSummary from "@/components/ProfitSummary";

// Vercelのキャッシュに古い結果が残らないよう、毎回サーバーで実行する
export const dynamic = "force-dynamic";
// 2026-09-02の/freight-actual-summaryでの障害(Vercel/CDN側にレスポンスが
// キャッシュされ、DB更新後も古いデータが表示され続けた)と同じ対策として、
// ISR的なキャッシュも明示的に無効化しておく(next.config.jsのheaders()で
// Cache-Controlヘッダーも別途無効化済み)。
export const revalidate = 0;

// profit_summaryは21,399行(2026-09時点、今後も増加し続ける)あり、サーバー側で
// 1回の.limit()クエリで全件取得する方式(freight-actual-summaryが使っていた方式)は
// PostgRESTのdb-max-rows設定で無言のまま切り詰められる恐れがあるため使わない
// (詳しくはcomponents/ProfitSummary.tsxのコメント参照)。このページ自体はサーバーでの
// データ取得を行わず、ProfitSummaryコンポーネントがブラウザ側で/api/profit-summaryを
// 何回かに分けて呼び出し、全件を組み立ててから表示する。
export default function ProfitSummaryPage() {
  return <ProfitSummary />;
}
