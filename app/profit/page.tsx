import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ProfitOrder } from "@/lib/types";
import ProfitDashboard from "@/components/ProfitDashboard";

// Vercelのキャッシュに古い結果が残らないよう、毎回サーバーで実行する
export const dynamic = "force-dynamic";

// Supabase/PostgREST は .range() を付けないと最大1000件までしか返さない
// (2026-07-31、値上げ検知ダッシュボードで実際にハマった問題と同じ)。
// v_profit_by_order は受注番号単位で約75,000件あるため、まず件数を取得してからページ取得する。
//
// 注意(2026-08-03に判明): v_profit_by_order は現在マテリアライズドビュー化済み
// (受注番号にユニークインデックスあり)なので1ページの取得自体は速いが、念のため
// 一度に全ページを並列実行(最大76並列)するのは避け、少数ずつ束ねて取得する。
// これは、以前 v_profit_by_order がマテリアライズドビュー化される前、全ページ並列取得が
// Supabase側の同時実行数・statement_timeoutを超えてタイムアウトを引き起こした
// (canceling statement due to statement timeout)実例があったための保険。
//
// 重要(2026-08-05判明): .range()によるページングは.order()で安定した並び順を
// 指定しないと正しく機能しない(ORDER BY が無いとPostgreSQLが返す行の順序は
// クエリのたびに変わり得るため、ページをまたいで行が重複・欠落する)。特にこの
// 関数のように複数ページを並列(Promise.all)で取得する場合、順序が不安定だと
// 影響がさらに出やすい。order_no にユニークインデックスがあるので、これで
// 明示的に昇順ソートする。
const PAGE_SIZE = 1000;
const CONCURRENCY = 8;

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

  const rows: ProfitOrder[] = [];
  for (let i = 0; i < pageStarts.length; i += CONCURRENCY) {
    const batch = pageStarts.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((from) =>
        supabase
          .from("v_profit_by_order")
          .select("*")
          .order("order_no", { ascending: true })
          .range(from, from + PAGE_SIZE - 1)
      )
    );
    for (const r of results) {
      if (r.error) return { rows: [], error: r.error };
      if (r.data) rows.push(...(r.data as ProfitOrder[]));
    }
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
