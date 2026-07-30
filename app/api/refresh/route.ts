import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";
// マテリアライズドビューの再集計(REFRESH)は、購入実績データが増えると
// 数秒〜十数秒かかることがあるため、Vercelの関数タイムアウトを延長しておく。
export const maxDuration = 60;

/**
 * v_price_increase_matched / v_price_increase_alerts はマテリアライズドビューなので、
 * sales_lines / purchase_lines を更新した後は、このAPIを呼んで再集計(REFRESH)する必要がある。
 * (CSVアップロード完了後に自動的に呼ばれる。手動で叩いても良い。)
 */
export async function POST() {
  const supabase = getSupabaseServerClient();
  const { error } = await supabase.rpc("refresh_price_increase_views");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ refreshed: true });
}
