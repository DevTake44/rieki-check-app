import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ProfitOrder } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// v_profit_by_order は受注8万8千件超(2026-08時点、今後も増加し続ける)ある。
// 全件を1回のレスポンスでJSONにすると実測で約30MBになり、Vercel Functionsの
// レスポンスサイズ上限(4.5MB、request body/response bodyとも共通の上限)を
// 大きく超えて500エラーになる(実際に発生した障害の原因)。
// そのため、このAPIは1回あたり最大MAX_LIMIT件までしか返さず、
// ブラウザ側(components/ProfitDashboardLoader.tsx)がoffsetをずらしながら
// 何回かに分けて呼び出し、手元で全件を組み立てる。
// (1行あたり実測で平均350バイト程度のJSONになるため、3000件でも1MB程度に収まる)
const MAX_LIMIT = 3000;
const DEFAULT_LIMIT = 3000;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const offsetParam = Number(searchParams.get("offset") ?? "0");
  const limitParam = Number(searchParams.get("limit") ?? String(DEFAULT_LIMIT));

  const offset = Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : 0;
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), MAX_LIMIT) : DEFAULT_LIMIT;

  const supabase = getSupabaseServerClient();

  // 件数(count)は先頭(offset=0)のリクエストでだけ取得する。全チャンクで毎回
  // count(exact)を取り直すと、DBへの同時接続数が倍になり(2026-08-18判明: これが
  // 原因で読み込みが13,000件あたりで止まって見える不具合が発生した)、
  // ブラウザ側は最初のレスポンスで受け取ったtotalを覚えておけば十分なため。
  const needCount = offset === 0;

  const [countResult, { data, error }] = await Promise.all([
    needCount
      ? supabase.from("v_profit_by_order").select("*", { count: "exact", head: true })
      : Promise.resolve({ count: null, error: null }),
    supabase
      .from("v_profit_by_order")
      .select("*")
      .order("order_no", { ascending: true })
      .range(offset, offset + limit - 1),
  ]);

  if (countResult.error) {
    return NextResponse.json({ error: countResult.error.message }, { status: 500 });
  }
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as ProfitOrder[];
  const total = countResult.count ?? null;

  return NextResponse.json({
    rows,
    total,
    offset,
    limit,
    hasMore: total !== null ? offset + rows.length < total : rows.length === limit,
  });
}
