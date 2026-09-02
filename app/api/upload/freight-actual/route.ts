import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

// 運賃実績集計(freight_actual_summary)の保存。
//
// 運賃照合画面(FreightCheck)で「拠点/営業担当/得意先×20日締め期間」に集計した
// 結果を、ここでまとめて保存する。同じ(period_end, carrier)の組み合わせを
// 再アップロード(データの訂正など)した場合に二重計上しないよう、対象の
// (period_end, carrier)にあたる既存行はいったん全部消してから入れ直す
// (shipping_note_mappingのような蓄積upsertではなく、全件洗い替え)。
const MAX_ROWS = 5000;

type FreightActualSummaryInsertRow = {
  period_end: string;
  carrier: string;
  branch_code: string;
  rep_code: string;
  customer_code: string;
  customer_name: string;
  shipment_count: number;
  matched_count: number;
  no_freight_charge_count: number;
  no_sales_data_count: number;
  no_mapping_count: number;
  actual_freight: number;
  charged_freight: number;
  margin: number;
  source_files: string | null;
};

export async function POST(req: NextRequest) {
  let body: { rows?: FreightActualSummaryInsertRow[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です(JSONではありません)。" }, { status: 400 });
  }
  const rows = body.rows;
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "rows が配列ではありません。" }, { status: 400 });
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "保存する集計データがありません。" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `対象行数が想定より多すぎます(${rows.length}件 > 上限${MAX_ROWS}件)。` },
      { status: 400 }
    );
  }
  for (const r of rows) {
    if (!r.period_end || !/^\d{4}-\d{2}-\d{2}$/.test(r.period_end)) {
      return NextResponse.json({ error: `period_end の形式が不正な行があります: ${JSON.stringify(r)}` }, { status: 400 });
    }
    if (!r.carrier) {
      return NextResponse.json({ error: `carrier が空の行があります: ${JSON.stringify(r)}` }, { status: 400 });
    }
  }

  const supabase = getSupabaseServerClient();

  // 対象となる (period_end, carrier) の組み合わせを洗い出し、それぞれ既存行を削除する。
  const targetPairs = Array.from(new Set(rows.map((r) => `${r.period_end}__${r.carrier}`))).map((k) => {
    const idx = k.lastIndexOf("__");
    return { period_end: k.slice(0, idx), carrier: k.slice(idx + 2) };
  });

  for (const { period_end, carrier } of targetPairs) {
    const { error: deleteError } = await supabase
      .from("freight_actual_summary")
      .delete()
      .eq("period_end", period_end)
      .eq("carrier", carrier);
    if (deleteError) {
      return NextResponse.json({ error: `既存データの削除に失敗しました: ${deleteError.message}` }, { status: 500 });
    }
  }

  const nowIso = new Date().toISOString();
  const payload = rows.map((r) => ({ ...r, created_at: nowIso, updated_at: nowIso }));

  const { error: insertError } = await supabase.from("freight_actual_summary").insert(payload);
  if (insertError) {
    return NextResponse.json({ error: `保存に失敗しました: ${insertError.message}` }, { status: 500 });
  }

  return NextResponse.json({ inserted: rows.length, periods: targetPairs.length });
}
