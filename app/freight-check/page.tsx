import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ShippingNoteMappingRow, FreightSalesLine } from "@/lib/types";
import FreightCheck from "@/components/FreightCheck";

// Vercelのキャッシュに古い結果が残らないよう、毎回サーバーで実行する
export const dynamic = "force-dynamic";
// このページは合計7〜8万行近くをサーバー側で全件取得してから表示するため、
// デフォルトの実行時間上限(10秒)だと途中でタイムアウトすることがある。
export const maxDuration = 60;

// Supabase/PostgREST は .range() を付けないと最大1000件までしか返さない。
// .order()を必ず付けて安定した並び順でページングする(2026-08-05判明の不具合と同じ轍を踏まない)。
const PAGE_SIZE = 1000;

// 2026-08-27改修: 以前は1ページずつ順番にawaitする完全な逐次処理だったため、
// (直近4か月のsales_lines約69,000行 → 約70回のサーバー往復)を1回ずつ待つ形になり、
// メニューから運賃照合ページを開くたびに非常に時間がかかっていた(実際の報告あり。
// 売上利益ページの裏読み込みとは無関係で、原因はこのページ自身のサーバー側取得)。
// 売上利益ページ(ProfitDashboardLoader)で確立した「実際に返ってきた件数を基準に
// 複数リクエストを並行実行する」方式をサーバー側に移植し、体感速度を改善する。
//
// あわせて、売上利益ページで発覚したPostgRESTの罠(要求した件数より少ない件数しか
// 返らないことがあり、それに気づかず固定のPAGE_SIZE単位でoffsetを進めると、
// 実際にはまだデータが残っているのに早期に「取得完了」とみなして後半のデータを
// 丸ごと読み落とす)にも、このページ自身は元々弱かった(`data.length < PAGE_SIZE`で
// 終了判定していたため)。同じ轍を踏まないよう、こちらも実際の返却件数を基準にする
// ロジックに合わせて修正している。
const FETCH_CONCURRENCY = 6;
const MAX_GAP_FILL_ROUNDS = 20;

type PageResult<T> = { data: T[] | null; error: { message: string } | null };
type PageResultWithCount<T> = PageResult<T> & { count: number | null };

async function fetchAllFast<T>(
  selectFirstWithCount: (from: number, to: number) => PromiseLike<PageResultWithCount<T>>,
  selectPage: (from: number, to: number) => PromiseLike<PageResult<T>>
): Promise<{ rows: T[]; error: { message: string } | null }> {
  const first = await selectFirstWithCount(0, PAGE_SIZE - 1);
  if (first.error) return { rows: [], error: first.error };

  const rows: T[] = [...(first.data ?? [])];
  const total = first.count;
  const actualPageSize = first.data?.length ?? 0;

  // 件数(count)が取れなかった場合は、従来通りの安全な逐次取得にフォールバックする。
  if (total === null || actualPageSize === 0) {
    let from = actualPageSize;
    for (;;) {
      const r = await selectPage(from, from + PAGE_SIZE - 1);
      if (r.error) return { rows, error: r.error };
      if (!r.data || r.data.length === 0) break;
      rows.push(...r.data);
      if (r.data.length < PAGE_SIZE) break;
      from += r.data.length;
    }
    return { rows, error: null };
  }

  if (rows.length < total) {
    // 「要求した件数」ではなく「1回目に実際に返ってきた件数」を基準にoffsetを
    // 進める(要求件数どおり返るとは限らないため)。
    const offsets: number[] = [];
    for (let o = actualPageSize; o < total; o += actualPageSize) offsets.push(o);

    for (let i = 0; i < offsets.length; i += FETCH_CONCURRENCY) {
      const batch = offsets.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.all(batch.map((o) => selectPage(o, o + PAGE_SIZE - 1)));
      for (const r of results) {
        if (r.error) return { rows, error: r.error };
        rows.push(...(r.data ?? []));
      }
    }

    // 念のための最終確認: 合計件数に届いていなければ不足分を追加取得する
    // (売上利益ページと同じ安全策)。
    let gapFillRounds = 0;
    while (rows.length < total && gapFillRounds < MAX_GAP_FILL_ROUNDS) {
      const r = await selectPage(rows.length, rows.length + PAGE_SIZE - 1);
      if (r.error) return { rows, error: r.error };
      if (!r.data || r.data.length === 0) break;
      rows.push(...r.data);
      gapFillRounds++;
    }
  }

  return { rows, error: null };
}

export default async function FreightCheckPage() {
  const supabase = getSupabaseServerClient();

  // 運賃照合は直近の送り状問合せデータ(3か月分プール)との突き合わせが前提なので、
  // sales_lines側もそれに合わせて直近4か月程度(月ズレの余裕込み)に絞って取得する。
  // 2026-08-06変更: 以前はitem_code='99'(運賃)行だけに絞っていたが、
  // 「99運賃行が無い(=運賃の請求漏れ)」と「そもそも売上データが無い(=未売上)」を
  // 区別するため、item_codeを問わず直近分を全件取得するようにした
  // (直近4か月で約69,000行・受注番号ベースで約2万件、他ツールと同程度の規模)。
  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - 4);
  const sinceStr = sinceDate.toISOString().slice(0, 10);

  const FREIGHT_SALES_COLUMNS =
    "order_no, order_line, branch_code, rep_code, delivery_note_no, customer_code, customer_name, item_code, sell_price, assumed_cost, delivery_date, id";

  const [mapping, freight] = await Promise.all([
    fetchAllFast<ShippingNoteMappingRow>(
      (from, to) =>
        supabase
          .from("shipping_note_mapping")
          .select("*", { count: "exact" })
          .order("id", { ascending: true })
          .range(from, to),
      (from, to) =>
        supabase.from("shipping_note_mapping").select("*").order("id", { ascending: true }).range(from, to)
    ),
    fetchAllFast<FreightSalesLine>(
      (from, to) =>
        supabase
          .from("sales_lines")
          .select(FREIGHT_SALES_COLUMNS, { count: "exact" })
          .gte("delivery_date", sinceStr)
          .order("id", { ascending: true })
          .range(from, to),
      (from, to) =>
        supabase
          .from("sales_lines")
          .select(FREIGHT_SALES_COLUMNS)
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
