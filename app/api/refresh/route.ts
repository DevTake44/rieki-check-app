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
 * v_price_increase_matched / v_price_increase_alerts / v_profit_lines はいずれも
 * マテリアライズドビューなので、sales_lines / purchase_lines を更新した後は、
 * このAPIを呼んで再集計(REFRESH)する必要がある。
 * (CSVアップロード完了後に自動的に呼ばれる。手動で叩いても良い。)
 *
 * 2026-08-03追記: 売上利益ダッシュボード(v_profit_lines、v_profit_by_orderの元になる
 * マテリアライズドビュー)を追加した際、通常のビューのままだと画面を開くたびに
 * (かつページング取得で並列に何十回も)重い集計SQLが再実行されてタイムアウトする問題が
 * 発生したため、こちらもマテリアライズドビュー化した。同じ理由でこのAPIでの
 * 再集計対象に追加している。
 *
 * 2026-09-07追記: 経営マトリクス(/profit)がv_profit_lines(明細行、件数が増え続ける)を
 * 毎回全件ページング取得して画面側で集計していたため、データが増えるほど開くのが
 * 遅くなる問題があった。事前集計テーブルprofit_summary(期間×拠点×営業担当×得意先の
 * 粒度、明細より桁違いに件数が少ない)を経営マトリクスの読み込み元に切り替えたが、
 * これまでprofit_summaryは自動更新の仕組みがなく手動でしか更新されていなかった。
 * それだとアップロードのたびに経営マトリクスの数字が古いままになってしまうため、
 * refresh_profit_views()と同じタイミングでprofit_summaryも再構築(TRUNCATE+INSERT)する
 * refresh_profit_summary()関数を追加し、ここから呼ぶようにした。
 */
export async function POST() {
  const supabase = getSupabaseServerClient();

  const { error: priceIncreaseError } = await supabase.rpc("refresh_price_increase_views");
  if (priceIncreaseError) {
    return NextResponse.json({ error: priceIncreaseError.message }, { status: 500 });
  }

  const { error: profitError } = await supabase.rpc("refresh_profit_views");
  if (profitError) {
    return NextResponse.json({ error: profitError.message }, { status: 500 });
  }

  const { error: profitSummaryError } = await supabase.rpc("refresh_profit_summary");
  if (profitSummaryError) {
    return NextResponse.json({ error: profitSummaryError.message }, { status: 500 });
  }

  return NextResponse.json({ refreshed: true });
}
