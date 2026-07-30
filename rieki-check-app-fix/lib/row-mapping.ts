// 売上(uriage.csv)・仕入(2025仕入.xlsxと同じ列構成のCSV)の生データ行(文字列配列)を、
// Supabaseのテーブル(sales_lines / purchase_lines)にそのまま insert/upsert できる形へ変換する。
//
// 列番号(0始まり)は、過去にPythonで解析した際に確定させたものと同じ。
// 売上側: 2=得意先名1, 11=受注番号, 12=受注行番号, 15=納品書番号, 16=納品書行数,
//         21=受注年月日, 23=営業所コード, 24=営業担当, 27=品番, 29=品名,
//         34=受注総数量, 39=販売単価, 49=手配区分, 51=仕入先名1, 53=原価
// 仕入側: 2=仕入先名1, 15=仕入番号, 16=仕入行番号, 17=受注番号, 18=受注行番号,
//         22=仕入年月日, 27=品番, 29=品名, 36=仕入バラ数, 39=単価, 52=得意先名1(納品先名)

export type SalesRowInsert = {
  order_no: string | null;
  order_line: string | null;
  order_date: string | null;
  customer_name: string | null;
  supplier_name: string | null;
  branch_code: string | null;
  rep_code: string | null;
  arrange_type: string | null;
  item_code: string | null;
  item_name: string | null;
  qty: number | null;
  sell_price: number | null;
  assumed_cost: number | null;
  delivery_note_no: string | null;
  delivery_note_line: string | null;
};

export type PurchaseRowInsert = {
  order_no: string | null;
  order_line: string | null;
  purchase_no: string | null;
  purchase_line: string | null;
  purchase_date: string | null;
  supplier_name: string | null;
  customer_name: string | null;
  item_code: string | null;
  item_name: string | null;
  qty: number | null;
  unit_price: number | null;
};

const MIN_SALES_COLS = 54;
const MIN_PURCHASE_COLS = 55;

function cell(cols: string[], i: number): string {
  const v = cols[i];
  return v === undefined || v === null ? "" : v.trim();
}

function textOrNull(cols: string[], i: number): string | null {
  const v = cell(cols, i);
  return v === "" ? null : v;
}

function numOrNull(cols: string[], i: number): number | null {
  const v = cell(cols, i);
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// "20260423" -> "2026-04-23" / 空欄・"0" -> null
function dateOrNull(cols: string[], i: number): string | null {
  const v = cell(cols, i);
  if (v === "" || v === "0") return null;
  if (/^\d{8}$/.test(v)) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }
  // 既に "2026-04-23" のような形式で入っている場合はそのまま
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

/**
 * 1行が完全に空行(全列が空文字)かどうかを判定する。
 * CSVの末尾に混ざる空行を除外するために使う。
 */
export function isBlankRow(cols: string[]): boolean {
  return cols.every((c) => (c ?? "").trim() === "");
}

export function mapSalesRow(cols: string[]): SalesRowInsert | null {
  if (isBlankRow(cols)) return null;
  if (cols.length < MIN_SALES_COLS) return null;

  const order_no = textOrNull(cols, 11);
  const order_line = textOrNull(cols, 12);
  const item_name = textOrNull(cols, 29);

  // 「{件名}一式」行(受注番号=0, 受注行番号=0)は、複数の受注番号をまとめた集計行。
  // 実際の金額・原価は別ファイル「物件」側の明細に入っており、このファイル側の金額は
  // 常に0円(2026-07-30時点、実データ56件で確認済み)。そのまま取り込むと、
  // 「物件」ファイルの明細と合算する際に二重計上になるため、ここで取り込まない。
  // (手配区分='商品外'では判定しない。運賃・値引など、正当な商品外行は
  //  order_no が0以外の実際の受注に紐づいているため。)
  if (order_no === "0" && order_line === "0") return null;

  // 「伝票消費税」行(受注番号ごとに1行存在する消費税の内訳行)は、品名以外の列が
  // 全てNULL(受注番号もNULL)で、値上げ検知には使えないデータ。しかも受注番号がNULLの
  // ため一意制約で重複判定できず、同じファイルを再アップロードするたびに増殖してしまう
  // (2026-07-30時点、実データで10,505件・全件の41%を確認)。取り込まない。
  if (item_name === "伝票消費税") return null;

  return {
    order_no,
    order_line,
    order_date: dateOrNull(cols, 21),
    customer_name: textOrNull(cols, 2),
    supplier_name: textOrNull(cols, 51),
    branch_code: textOrNull(cols, 23),
    rep_code: textOrNull(cols, 24),
    arrange_type: textOrNull(cols, 49),
    item_code: textOrNull(cols, 27),
    item_name: textOrNull(cols, 29),
    qty: numOrNull(cols, 34),
    sell_price: numOrNull(cols, 39),
    assumed_cost: numOrNull(cols, 53),
    delivery_note_no: textOrNull(cols, 15),
    delivery_note_line: textOrNull(cols, 16),
  };
}

export function mapPurchaseRow(cols: string[]): PurchaseRowInsert | null {
  if (isBlankRow(cols)) return null;
  if (cols.length < MIN_PURCHASE_COLS) return null;

  const item_name = textOrNull(cols, 29);

  // 「伝票消費税」行は仕入側にも存在する(2026-07-30時点、実データで33,715件・
  // purchase_lines全体の約8%を確認)。仕入番号(purchase_no)もNULLのため、一意制約で
  // 重複判定できず、同じファイルを再アップロードするたびに増殖してしまう。
  // 値上げ検知にも使えないデータのため取り込まない(売上側のmapSalesRowと同じ理由)。
  if (item_name === "伝票消費税") return null;

  return {
    order_no: textOrNull(cols, 17),
    order_line: textOrNull(cols, 18),
    purchase_no: textOrNull(cols, 15),
    purchase_line: textOrNull(cols, 16),
    purchase_date: dateOrNull(cols, 22),
    supplier_name: textOrNull(cols, 2),
    customer_name: textOrNull(cols, 52),
    item_code: textOrNull(cols, 27),
    item_name: textOrNull(cols, 29),
    qty: numOrNull(cols, 36),
    unit_price: numOrNull(cols, 39),
  };
}
