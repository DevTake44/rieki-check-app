import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ShippingNoteRowInsert } from "@/lib/row-mapping";
export const dynamic = "force-dynamic";

// 運賃照合機能: 送り状問合せCSVの取り込み。
// 「送り状番号(＝運送会社請求データの原票No.) ↔ 自社の受注番号」の対応表。
// sales_linesと同じupsert蓄積のみで、古い行の自動削除は行わない(2026-10-15、
// びっきぃの指示で廃止。もともとSupabase無料枠の容量維持のため直近3か月だけ
// 保持する運用だったが、西濃・福山の過去データを遡って取り込みたいため、
// 古い送り状問合せCSVを再アップロードしても削除されないようにする)。
const MAX_ROWS = 20000;

export async function POST(req: NextRequest) {
  let body: { rows?: ShippingNoteRowInsert[] };
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
      { error: `対象行数が想定より多すぎます(${rows.length}件 > 上限${MAX_ROWS}件)。` },
      { status: 400 }
    );
  }

  // 送り状番号(waybill_no)をキーに重複除去(同じファイルの誤った2重貼り付けなどに備えて)。
  const seen = new Set<string>();
  const deduped: ShippingNoteRowInsert[] = [];
  for (const r of rows) {
    if (!r.waybill_no) continue;
    if (seen.has(r.waybill_no)) continue;
    seen.add(r.waybill_no);
    deduped.push(r);
  }

  const supabase = getSupabaseServerClient();

  if (deduped.length > 0) {
    const { error: upsertError } = await supabase
      .from("shipping_note_mapping")
      .upsert(deduped, { onConflict: "waybill_no" });
    if (upsertError) {
      return NextResponse.json({ error: `取り込みに失敗しました: ${upsertError.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({ inserted: deduped.length });
}
