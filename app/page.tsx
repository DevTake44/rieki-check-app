import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { PriceIncreaseAlert } from "@/lib/types";
import Dashboard from "@/components/Dashboard";

// Vercelのキャッシュに古い結果が残らないよう、毎回サーバーで実行する
export const dynamic = "force-dynamic";

// Supabase/PostgREST は .select("*") に .range() を付けない場合、
// デフォルトで最大1000件までしか返さない(プロジェクト設定のデフォルトlimit)。
// v_price_increase_alerts は14,000件超あるため、.range()で1000件ずつ全件
// 取得するまでページングする(2026-07-31判明: これが原因で拠点21より後の
// データがダッシュボードに一切届いておらず、拠点セレクタにも出ていなかった)。
//
// 重要(2026-08-05判明): .range()によるページングは.order()で安定した並び順を
// 指定しないと正しく機能しない(ORDER BY が無いとPostgreSQLが返す行の順序は
// クエリのたびに変わり得るため、ページをまたいで行が重複・欠落する)。
// sales_line_id にユニークインデックスがあるので、これで明示的に昇順ソートする。
const PAGE_SIZE = 1000;

async function fetchAllAlerts(
  supabase: ReturnType<typeof getSupabaseServerClient>
): Promise<{ rows: PriceIncreaseAlert[]; error: { message: string } | null }> {
  const rows: PriceIncreaseAlert[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("v_price_increase_alerts")
      .select("*")
      .order("sales_line_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);

    if (error) return { rows, error };
    if (!data || data.length === 0) break;

    rows.push(...(data as PriceIncreaseAlert[]));

    if (data.length < PAGE_SIZE) break; // 最終ページ
    from += PAGE_SIZE;
  }
  return { rows, error: null };
}

export default async function Home() {
  const supabase = getSupabaseServerClient();
  const { rows, error } = await fetchAllAlerts(supabase);

  if (error) {
    return (
      <div className="page">
        <h1>値上げ検知ダッシュボード</h1>
        <div className="card">
          <p>データの取得に失敗しました。環境変数(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)が正しく設定されているか確認してください。</p>
          <pre style={{ whiteSpace: "pre-wrap", color: "#c0392b" }}>{error.message}</pre>
        </div>
      </div>
    );
  }

  return <Dashboard rows={rows} />;
}
