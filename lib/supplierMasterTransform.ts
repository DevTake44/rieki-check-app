// 仕入先マスタCSVの変換ルールをまとめた場所。
// CSVは見出し行(ヘッダー)付きで、以下の列名を含む想定:
//   仕入先コード・仕入先名上段・仕入先名下段・削除フラグ
// (sales-dashboard側の仕入先マスタ取り込みと同じCSV形式。削除フラグは商品マスタと
// 判定値が異なり、このファイルは"9"が削除を表す)
export type SupplierMasterRow = {
  supplier_code: string;
  supplier_name: string;
  is_deleted: boolean;
};

function s(v: unknown): string {
  return (v ?? "").toString().trim();
}

// Papa.parse(text, { header: true }) の結果を受け取る想定
export function transformSupplierMasterCsv(raw: Record<string, string>[]): {
  rows: SupplierMasterRow[];
  skipped: string[];
} {
  const skipped: string[] = [];
  const rows: SupplierMasterRow[] = [];

  for (const r of raw) {
    const code = s(r["仕入先コード"]);
    if (code === "") {
      skipped.push("仕入先コードが空白のため除外");
      continue;
    }
    const upper = s(r["仕入先名上段"]);
    const lower = s(r["仕入先名下段"]);
    rows.push({
      supplier_code: code,
      supplier_name: lower ? `${upper} ${lower}` : upper,
      is_deleted: s(r["削除フラグ"]) === "9",
    });
  }

  return { rows, skipped };
}
