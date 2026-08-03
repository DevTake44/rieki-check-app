import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ProfitOrder } from "@/lib/types";
import ProfitDashboard from "@/components/ProfitDashboard";

// Vercelのキャッシュに古い結果が残らないよう、毎回サーバーで実行する
export const dynamic = "force-dynamic";

// Supabase/PostgREST は .range() を付けないと最大1000件までしか返さない
// (2026-07-31、値上げ検知ダッシュボードで実際にハマった問題と同じ)。
// v_profit_by_order は受注番号単位で約75,000件あるため、まず件数を取得してから
// 並列でページ取得することで、逐次ループより読み込みを速くする。
const PAGE_SIZE = 1000;

async function fetchAllProfitOrders(
  supabase: ReturnType<typeof getSupabaseServerClient>
): Promise<{ rows: ProfitOrder[]; error: { message: string } | null }> {
  const { count, error: countError } = await supabase
    .from("v_profit_by_order")
    .select("*", { count: "exact", head: true });
  if (countError) return { rows: [], error: countError };

  const total = count ?? 0;
  if (total === 0) return { rows: [], error: null };

  const pageStarts: number[] = [];
  for (let from = 0; from < total; from += PAGE_SIZE) pageStarts.push(from);

  const results = await Promise.all(
    pageStarts.map((from) =>
      supabase
        .from("v_profit_by_order")
        .select("*")
        .range(from, from + PAGE_SIZE - 1)
    )
  );

  const rows: ProfitOrder[] = [];
  for (const r of results) {
    if (r.error) return { rows: [], error: r.error };
    if (r.data) rows.push(...(r.data as ProfitOrder[]));
  }
  return { rows, error: null };
}

export default async function ProfitPage() {
  const supabase = getSupabaseServerClient();
  const { rows, error } = await fetchAllProfitOrders(supabase);

  if (error) {
    return (
      <div className="page">
        <h1>売上利益</h1>
        <div className="card">
          <p>データの取得に失敗しました。環境変数(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)が正しく設定されているか確認してください。</p>
          <pre style={{ whiteSpace: "pre-wrap", color: "#c0392b" }}>{error.message}</pre>
        </div>
      </div>
    );
  }

  return <ProfitDashboard orders={rows} />;
}
