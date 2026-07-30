import { NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
export const dynamic = "force-dynamic";
// マテリアライズドビューの再集計(REFRESH)は、購入実績データが増えると
// 数秒〜十数秒、状況によってはそれ以上かかることがあるため、
// Vercelの関数タイムアウトをDB側のタイムアウト(10分, refresh_price_increase_views関数側で設定)に
// 近い余裕を持たせて延長しておく。
// 注意: プランによってVercelが許容する上限は異なる(Hobbyは短め、Pro/Teamはより長く設定可能)。
// デプロイ時にエラーになる場合は、契約プランの上限まで下げてください。
export const maxDuration = 300;
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
