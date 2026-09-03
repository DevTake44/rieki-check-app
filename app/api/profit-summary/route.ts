import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ProfitSummaryRow } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// profit_summary は「20日締め期間×拠点×営業担当×得意先」の事前集計テーブルで、
// 2026-09時点で21,399行(今後も期間・受注が増えるたびに増加し続ける)。
//
// 【重要・過去の障害を繰り返さないための注意】
// freight_actual_summaryのように「件数が少ないから」と1回のリクエスト(.limit()指定)
// で全件取得する実装にしてはいけない。SupabaseのPostgREST側にはdb-max-rows(1リクエスト
// あたりの最大返却件数)の設定があり、.limit()に何を指定してもこの上限で無言のまま
// 切り詰められる。現状この上限は20000に引き上げられているが、profit_summaryは
// 既に21,399行(この上限を超えている)あり、件数は今後も増え続けるため、件数固定の
// 前提はすぐに壊れる。そのため /api/profit-orders・/api/profit-lines と同じ
// offset/limitページングを行い、呼び出し側(components/ProfitSummary.tsx)が
// 何回かに分けて呼び出して全件を組み立てる方式にする。
const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 5000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const offsetParam = Number(searchParams.get("offset") ?? "0");
  const limitParam = Number(searchParams.get("limit") ?? String(DEFAULT_LIMIT));

  const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : 0;
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MAX_LIMIT) : DEFAULT_LIMIT;

  const supabase = getSupabaseServerClient();

  // 件数(count)は先頭(offset=0)のリクエストでだけ取得する(profit-orders/profit-linesと
  // 同じ理由: 毎回count(exact)を取り直すとDBへの同時接続数が倍になり、途中で読み込みが
  // 止まって見える不具合の原因になったことがあるため)。
  const needCount = offset === 0;

  const [countResult, { data, error }] = await Promise.all([
    needCount
      ? supabase.from("profit_summary").select("*", { count: "exact", head: true })
      : Promise.resolve({ count: null, error: null }),
    supabase
      .from("profit_summary")
      .select("*")
      .order("period_end", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1),
  ]);

  if (countResult.error) {
    return NextResponse.json({ error: countResult.error.message }, { status: 500 });
  }
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as ProfitSummaryRow[];
  const total = countResult.count ?? null;

  return NextResponse.json({
    rows,
    total,
    offset,
    limit,
    hasMore: total !== null ? offset + rows.length < total : rows.length === limit,
  });
}
