import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ProfitLine } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 経営マトリクス(月別集計)専用。v_profit_by_order(受注番号単位、複数月にまたがる
// 受注でも納品日を1つに代表させてしまう)ではなく、実際の行(sales_line)単位の
// delivery_dateで正しく月別集計するためのAPI(詳しくはlib/types.tsのProfitLineの
// コメント参照)。
//
// 対象期間は呼び出し側(components/ProfitDashboardLoader.tsx)が「今期・前期の
// うち一番古い期の開始日」を計算して since パラメータで渡す(前期データが
// アップロードされていなければ今期分だけで済むため、必要以上に取得しない)。
//
// レスポンスサイズ対策(/api/profit-ordersと同じ理由): 全件を1回で返すと
// Vercel Functionsのレスポンスサイズ上限(4.5MB)を超える恐れがあるため、
// 1回あたり最大MAX_LIMIT件までとし、呼び出し側がoffsetをずらしながら
// 何回かに分けて呼び出す。
const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 5000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const since = searchParams.get("since");
  if (!since) {
    return NextResponse.json({ error: "since パラメータが必要です(YYYY-MM-DD形式)。" }, { status: 400 });
  }

  const offsetParam = Number(searchParams.get("offset") ?? "0");
  const limitParam = Number(searchParams.get("limit") ?? String(DEFAULT_LIMIT));

  const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : 0;
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MAX_LIMIT) : DEFAULT_LIMIT;

  const supabase = getSupabaseServerClient();

  // 件数(count)は先頭(offset=0)のリクエストでだけ取得する(profit-ordersと同じ理由:
  // 毎回count(exact)を取り直すとDBへの同時接続数が倍になり、途中で読み込みが
  // 止まって見える不具合の原因になったことがあるため)。
  const needCount = offset === 0;

  const columns = "sales_line_id, branch_code, rep_code, customer_code, customer_name, delivery_date, revenue, cost";

  const [countResult, { data, error }] = await Promise.all([
    needCount
      ? supabase.from("v_profit_lines").select("*", { count: "exact", head: true }).gte("delivery_date", since)
      : Promise.resolve({ count: null, error: null }),
    supabase
      .from("v_profit_lines")
      .select(columns)
      .gte("delivery_date", since)
      .order("sales_line_id", { ascending: true })
      .range(offset, offset + limit - 1),
  ]);

  if (countResult.error) {
    return NextResponse.json({ error: countResult.error.message }, { status: 500 });
  }
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as ProfitLine[];
  const total = countResult.count ?? null;

  return NextResponse.json({
    rows,
    total,
    offset,
    limit,
    hasMore: total !== null ? offset + rows.length < total : rows.length === limit,
  });
}
