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
      { error: `対象行数が想定より多すぎます(${rows.length}件 > 上限${MAX_ROWS}件)。抽出条件(手配区分=在庫のうち、拠点90/91宛または納入先名1に「太幸」を含む行)が正しく効いているか確認してください。` },
      { status: 400 }
    );
  }

  // 念のための防御的な重複除去。受注番号+受注行番号が同じ行が万一2重に
  // 含まれていた場合(基幹システム側の出力ミス・同じファイルの誤った2重貼り付けなど)、
  // そのまま挿入すると金額が2重計上されてしまう。実際にサンプルファイルで確認した限りでは
  // 重複は無かったが、将来のファイルでも重複が無い保証は無いため、ここで
  // (order_no, order_line) をキーに1つに絞ってから挿入する。
  // order_no が無い行(通常は発生しない想定)は、誤って別の行を巻き込んで消さないよう
  // 重複判定の対象外とし、そのまま残す。
  const seen = new Set<string>();
  const deduped: TransferRowInsert[] = [];
  let duplicatesRemoved = 0;
  for (const r of rows) {
    if (!r.order_no) {
      deduped.push(r);
      continue;
    }
    const key = `${r.order_no}::${r.order_line ?? ""}`;
    if (seen.has(key)) {
      duplicatesRemoved++;
      continue;
    }
    seen.add(key);
    deduped.push(r);
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

  if (deduped.length === 0) {
    return NextResponse.json({ inserted: 0, duplicatesRemoved });
  }

  const { error: insertError, count } = await supabase
    .from("stock_transfer_pending")
    .insert(deduped, { count: "exact" });
  if (insertError) {
    return NextResponse.json({ error: `挿入に失敗しました: ${insertError.message}` }, { status: 500 });
  }

  return NextResponse.json({ inserted: count ?? deduped.length, duplicatesRemoved });
}
