import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { TransferRowInsert } from "@/lib/row-mapping";
export const dynamic = "force-dynamic";

// このテーブルは「今この瞬間、まだ納品されていない拠点間の在庫移動」を表す
// スナップショットとして使う(過去分を積み上げる履歴ではない)。そのため
// アップロードのたびに全件を洗い替え(削除→挿入)する。件数は少ない想定
// (受注出力CSV全体が数千行あっても、対象行だけに絞ると数十〜数百件程度)なので
// 分割送信はせず1回のリクエストで処理する。
const MAX_ROWS = 5000;

export async function POST(req: NextRequest) {
  let body: { rows?: TransferRowInsert[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です(JSONではありません)。" }, { status: 400 });
  }
  const rows = body.rows;
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "rows が配列ではありません。" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `対象行数が想定より多すぎます(${rows.length}件 > 上限${MAX_ROWS}件)。抽出条件(手配区分=在庫かつ納入先名1に「太幸」を含む)が正しく効いているか確認してください。` },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();

  // 全件洗い替え: 既存行をすべて削除してから、新しいスナップショットを挿入する。
  const { error: deleteError } = await supabase
    .from("stock_transfer_pending")
    .delete()
    .gte("id", 0);
  if (deleteError) {
    return NextResponse.json({ error: `既存データの削除に失敗しました: ${deleteError.message}` }, { status: 500 });
  }

  if (rows.length === 0) {
    return NextResponse.json({ inserted: 0 });
  }

  const { error: insertError, count } = await supabase
    .from("stock_transfer_pending")
    .insert(rows, { count: "exact" });
  if (insertError) {
    return NextResponse.json({ error: `挿入に失敗しました: ${insertError.message}` }, { status: 500 });
  }

  return NextResponse.json({ inserted: count ?? rows.length });
}
