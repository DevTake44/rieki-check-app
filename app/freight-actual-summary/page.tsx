import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { FreightActualSummaryRow } from "@/lib/types";
import FreightActualSummary from "@/components/FreightActualSummary";

// Vercelのキャッシュに古い結果が残らないよう、毎回サーバーで実行する
export const dynamic = "force-dynamic";

// freight_actual_summaryは「20日締め期間×運送会社×拠点×営業×得意先」の集計行なので、
// 生の明細(sales_lines等)と違って件数は少ない(運賃照合画面から手動保存されたものだけ)。
// ページングせず1回で取得する。
const MAX_ROWS = 20000;

export default async function FreightActualSummaryPage() {
  const supabase = getSupabaseServerClient();

  const { data, error } = await supabase
    .from("freight_actual_summary")
    .select("*")
    .order("period_end", { ascending: false })
    .limit(MAX_ROWS);

  if (error) {
    return (
      <div className="page">
        <h1>運賃実績集計</h1>
        <div className="card">
          <p>データの取得に失敗しました。環境変数(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)が正しく設定されているか確認してください。</p>
          <pre style={{ whiteSpace: "pre-wrap", color: "#c0392b" }}>{error.message}</pre>
        </div>
      </div>
    );
  }

  return <FreightActualSummary rows={(data ?? []) as FreightActualSummaryRow[]} />;
}
