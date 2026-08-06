import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ShippingNoteMappingRow, FreightSalesLine } from "@/lib/types";
import FreightCheck from "@/components/FreightCheck";

// Vercelのキャッシュに古い結果が残らないよう、毎回サーバーで実行する
export const dynamic = "force-dynamic";

// Supabase/PostgREST は .range() を付けないと最大1000件までしか返さない。
// .order()を必ず付けて安定した並び順でページングする(2026-08-05判明の不具合と同じ轍を踏まない)。
const PAGE_SIZE = 1000;

async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<{ rows: T[]; error: { message: string } | null }> {
  const rows: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error };
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { rows, error: null };
}

export default async function FreightCheckPage() {
  const supabase = getSupabaseServerClient();

  // 運賃照合は直近の送り状問合せデータ(3か月分プール)との突き合わせが前提なので、
  // sales_lines側もそれに合わせて直近4か月程度(月ズレの余裕込み)に絞って取得する。
  // 59,000件超ある item_code='99' 全件を毎回取得すると重いため。
  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - 4);
  const sinceStr = sinceDate.toISOString().slice(0, 10);

  const [mapping, freight] = await Promise.all([
    fetchAll<ShippingNoteMappingRow>((from, to) =>
      supabase.from("shipping_note_mapping").select("*").order("id", { ascending: true }).range(from, to)
    ),
    fetchAll<FreightSalesLine>((from, to) =>
      supabase
        .from("sales_lines")
        .select("order_no, order_line, branch_code, customer_code, customer_name, sell_price, assumed_cost, delivery_date, id")
        .eq("item_code", "99")
        .gte("delivery_date", sinceStr)
        .order("id", { ascending: true })
        .range(from, to)
    ),
  ]);

  const error = mapping.error ?? freight.error;
  if (error) {
    return (
      <div className="page">
        <h1>運賃照合</h1>
        <div className="card">
          <p>データの取得に失敗しました。環境変数(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)が正しく設定されているか確認してください。</p>
          <pre style={{ whiteSpace: "pre-wrap", color: "#c0392b" }}>{error.message}</pre>
        </div>
      </div>
    );
  }

  return <FreightCheck mappingRows={mapping.rows} freightSalesLines={freight.rows} />;
}
