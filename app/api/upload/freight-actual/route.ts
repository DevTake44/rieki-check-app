import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

// 運賃実績集計(freight_actual_summary)の保存。
//
// 運賃照合画面(FreightCheck)で「拠点/営業担当/得意先×20日締め期間」に集計した
// 結果を、ここでまとめて保存する。同じ(period_end, carrier, source_label)の組み合わせを
// 再アップロード(データの訂正など)した場合に二重計上しないよう、対象の
// (period_end, carrier, source_label)にあたる既存行はいったん全部消してから入れ直す
// (shipping_note_mappingのような蓄積upsertではなく、全件洗い替え)。
//
// 2026-09-02追記: 当初はcarrierだけを洗い替えの単位にしていたが、西濃運輸(兵庫)・
// 西濃運輸(土浦)のように同じCSV形式(＝同じcarrier値)でも別々の契約・請求書として
// 別タイミングでアップロードされる運用があり、carrierだけだと後からアップロードした
// 方が先の別拠点分を消してしまう不具合があった。そのため請求元(拠点・契約)を表す
// source_labelを追加し、洗い替えの単位を(period_end, carrier, source_label)にした。
const MAX_ROWS = 5000;

type FreightActualSummaryInsertRow = {
  period_end: string;
  carrier: string;
  source_label: string;
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
    if (!r.source_label) {
      return NextResponse.json(
        { error: `請求元(source_label)が空の行があります。どの拠点・契約のデータか入力してください: ${JSON.stringify(r)}` },
        { status: 400 }
      );
    }
  }

  const supabase = getSupabaseServerClient();

  // 対象となる (period_end, carrier, source_label) の組み合わせを洗い出し、それぞれ既存行を削除する。
  // 区切り文字には制御文字(\x01)を使う。period_end/carrier/source_labelの値に
  // 現れない前提(ユーザーが入力するテキストとして通常出てこない想定)。
  const SEP = "\x01";
  const targetTriples = Array.from(new Set(rows.map((r) => `${r.period_end}${SEP}${r.carrier}${SEP}${r.source_label}`))).map(
    (k) => {
      const [period_end, carrier, source_label] = k.split(SEP);
      return { period_end, carrier, source_label };
    }
  );

  for (const { period_end, carrier, source_label } of targetTriples) {
    const { error: deleteError } = await supabase
      .from("freight_actual_summary")
      .delete()
      .eq("period_end", period_end)
      .eq("carrier", carrier)
      .eq("source_label", source_label);
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

  return NextResponse.json({ inserted: rows.length, periods: targetTriples.length });
}
