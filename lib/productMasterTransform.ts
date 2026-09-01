// 商品マスタCSVの変換ルールをまとめた場所。
// CSVは見出し行(ヘッダー)付きで、以下の列名を含む想定:
//   品番・品名・カナ品名・実仕入先・仕入基準単価（バラ）・副仕入先・副仕入単価・
//   削除フラグ・更新年月日
// (sales-dashboard側の商品マスタ取り込みと同じCSV形式)
import { normalizeForSearch } from "./textNormalize";

export type ProductMasterRow = {
  product_code: string;
  product_name: string;
  product_kana: string | null;
  product_name_normalized: string;
  primary_supplier_code: string | null;
  primary_supplier_price: number | null;
  secondary_supplier_code: string | null;
  secondary_supplier_price: number | null;
  is_deleted: boolean;
};

function s(v: unknown): string {
  return (v ?? "").toString().trim();
}
function numOrNull(v: unknown): number | null {
  const str = s(v);
  if (str === "" || str === "0") return null;
  const n = Number(str);
  return Number.isNaN(n) ? null : n;
}
function codeOrNull(v: unknown): string | null {
  const str = s(v);
  return str === "" || str === "0" ? null : str;
}

// Papa.parse(text, { header: true }) の結果を受け取る想定
export function transformProductMasterCsv(raw: Record<string, string>[]): {
  rows: ProductMasterRow[];
  skipped: string[];
} {
  const skipped: string[] = [];
  // 品番が重複している場合、更新年月日が新しい方を残す
  const byCode = new Map<string, { row: Record<string, string>; updatedAt: string }>();

  for (const r of raw) {
    const code = s(r["品番"]);
    if (code === "") {
      skipped.push("品番が空白のため除外");
      continue;
    }
    const updatedAt = s(r["更新年月日"]);
    const existing = byCode.get(code);
    if (!existing || updatedAt > existing.updatedAt) {
      if (existing) skipped.push(`品番重複のため古い方を除外(品番:${code})`);
      byCode.set(code, { row: r, updatedAt });
    } else {
      skipped.push(`品番重複のため古い方を除外(品番:${code})`);
    }
  }

  const rows: ProductMasterRow[] = [];
  for (const { row: r } of byCode.values()) {
    const productName = s(r["品名"]);
    const productKana = s(r["カナ品名"]) || null;
    rows.push({
      product_code: s(r["品番"]),
      product_name: productName,
      product_kana: productKana,
      product_name_normalized: normalizeForSearch(`${productName} ${productKana ?? ""}`),
      primary_supplier_code: codeOrNull(r["実仕入先"]),
      primary_supplier_price: numOrNull(r["仕入基準単価（バラ）"]),
      secondary_supplier_code: codeOrNull(r["副仕入先"]),
      secondary_supplier_price: numOrNull(r["副仕入単価"]),
      is_deleted: s(r["削除フラグ"]) === "1",
    });
  }

  return { rows, skipped };
}
