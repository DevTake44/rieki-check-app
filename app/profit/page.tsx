import ProfitDashboardLoader from "@/components/ProfitDashboardLoader";

// Vercelのキャッシュに古い結果が残らないよう、毎回サーバーで実行する
export const dynamic = "force-dynamic";

// 2026-08-18判明: 受注件数の増加(2026-08時点で約88,000件、今後も増え続ける)により、
// このページをサーバー側で全件取得してから渡す従来方式だと、JSONで約30MBになり、
// Vercel Functionsのレスポンスサイズ上限(4.5MB)を超えて500エラーになっていた
// (実際に発生した障害)。そのため、このページ自体はサーバーでのデータ取得を行わず、
// components/ProfitDashboardLoader.tsx がブラウザ側で /api/profit-orders を
// 何回かに分けて呼び出し、全件を組み立ててから表示する方式に変更した。
export default function ProfitPage() {
  return <ProfitDashboardLoader />;
}
