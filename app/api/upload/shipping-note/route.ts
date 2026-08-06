import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ShippingNoteRowInsert } from "@/lib/row-mapping";
export const dynamic = "force-dynamic";

// 運賃照合機能: 送り状問合せCSVの取り込み。
// このテーブルは「送り状番号(＝運送会社請求データの原票No.) ↔ 自社の受注番号」の
// 対応表で、長期保存する必要は無く、直近3か月分プールされていればよい(ユーザー確認済み)。
// そのため sales_lines のような upsert 蓄積 + 期間を過ぎたらアップロードのたびに
// 古い行を削除する、という運用にする(stock_transfer_pending のような全件洗い替えではなく、
// 複数回のアップロードにまたがって蓄積したいため upsert にしている)。
const MAX_ROWS = 20000;
const RETENTION_DAYS = 92; // 3か月強、月末月初のズレを吸収する分の余裕を持たせる

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

  // 3か月(92日)より古いデータは、この機会に削除する(長期保存は不要なため)。
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const { error: deleteError, count: deletedCount } = await supabase
    .from("shipping_note_mapping")
    .delete({ count: "exact" })
    .lt("issue_date", cutoffStr);
  if (deleteError) {
    // 削除の失敗は致命的ではない(次回アップロード時にまた試みられる)ので、
    // 取り込み自体は成功として返しつつエラー内容だけ添える。
    return NextResponse.json({ inserted: deduped.length, pruned: 0, pruneError: deleteError.message });
  }

  return NextResponse.json({ inserted: deduped.length, pruned: deletedCount ?? 0 });
}
