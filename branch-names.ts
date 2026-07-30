import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { PriceIncreaseAlert } from "@/lib/types";
import Dashboard from "@/components/Dashboard";

// Vercelのキャッシュに古い結果が残らないよう、毎回サーバーで実行する
export const dynamic = "force-dynamic";

export default async function Home() {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.from("v_price_increase_alerts").select("*");

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

  const rows = (data ?? []) as PriceIncreaseAlert[];
  return <Dashboard rows={rows} />;
}
