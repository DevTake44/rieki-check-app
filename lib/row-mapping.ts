// 売上(uriage.csv)・仕入(2025仕入.xlsxと同じ列構成のCSV)の生データ行(文字列配列)を、
// Supabaseのテーブル(sales_lines / purchase_lines)にそのまま insert/upsert できる形へ変換する。
//
// 列番号(0始まり)は、過去にPythonで解析した際に確定させたものと同じ。
// 売上側: 2=得意先名1, 11=受注番号, 12=受注行番号, 15=納品書番号, 16=納品書行数,
//         21=受注年月日, 22=納品年月日, 23=営業所コード, 24=営業担当, 27=品番, 29=品名,
//         34=受注総数量, 37=納品総数量, 39=販売単価, 40=金額, 49=手配区分, 51=仕入先名1, 53=原価
// 仕入側: 2=仕入先名1, 15=仕入番号, 16=仕入行番号, 17=受注番号, 18=受注行番号,
//         22=仕入年月日, 27=品番, 29=品名, 36=仕入バラ数, 39=単価, 52=得意先名1(納品先名)
//
// 注意(2026-07-30に判明): 売上側のqtyは「受注総数量(34列目)」ではなく
// 「納品総数量(37列目)」を使う。1つの受注が複数回・複数月に分けて納品される場合や、
// 返品→再売上の訂正が入る場合、行ごとの「受注総数量」は0や実態と異なる値になり得るが、
// 「納品総数量」はその行(その納品書番号)で実際に動いた数量を正しく表す。
// 実データで sum(納品総数量 × 販売単価) が「金額」列(40列目)と完全一致することを確認済み。

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

// 保持対象の会計期間(会社の期は9/20区切り、2期分): 2024/9/21〜2026/9/20。
// Supabase無料枠(500MB)の容量を、気づかないうちに超えてしまうことがないよう、
// この期間より前・後の受注日/仕入日を持つ行は取り込まない(2026-07-30時点で導入)。
// 対象期間を変更する場合は、この2つの定数を変更する。
const RETENTION_FROM = "2024-09-21";
const RETENTION_TO = "2026-09-20";

// 日付が期間外(かつ日付が取得できている場合)なら true。
// 日付が取れない行(dateOrNullがnullを返す行)は、この判定では従来通り除外しない。
function isOutsideRetentionWindow(dateStr: string | null): boolean {
  if (dateStr === null) return false;
  return dateStr < RETENTION_FROM || dateStr > RETENTION_TO;
}

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

  // 「{件名}一式」行(受注番号=0, 受注行番号=0)は、複数の受注番号をまとめたプロジェクトの
  // 概算(まとめ)行。受注総数量は0だが、販売単価・金額には実額が入っている
  // (2026-07-30時点、訂正: 以前「常に0円」としたのは誤りで、実際は実額あり)。
  // 品目別の原価明細は別ファイル「物件」側に入っており、値上げ検知(原価比較)には
  // この一式行自体は使えない(原価が無い)ため取り込まない。ただし、この一式行の金額と
  // 「物件」ファイルの明細金額はほぼ同じプロジェクトの概算/内訳の関係にあるため、両方を
  // そのまま合計すると二重計上になる。合計金額(sales_lines全体)は公式の売上管理表とは
  // 完全には一致しない設計であることを踏まえておくこと(小さな差は許容する前提)。
  if (order_no === "0" && order_line === "0") return null;

  // 「伝票消費税」行(受注番号ごとに1行存在する消費税の内訳行)は、品名以外の列が
  // 全てNULL(受注番号もNULL)で、値上げ検知には使えないデータ。しかも受注番号がNULLの
  // ため一意制約で重複判定できず、同じファイルを再アップロードするたびに増殖してしまう
  // (2026-07-30時点、実データで10,505件・全件の41%を確認)。取り込まない。
  if (item_name === "伝票消費税") return null;

  const order_date = dateOrNull(cols, 21);

  // 対象2期間(2024/9/21〜2026/9/20)より前・後の受注日は取り込まない。
  if (isOutsideRetentionWindow(order_date)) return null;

  return {
    order_no,
    order_line,
    order_date,
    customer_name: textOrNull(cols, 2),
    supplier_name: textOrNull(cols, 51),
    branch_code: textOrNull(cols, 23),
    rep_code: textOrNull(cols, 24),
    arrange_type: textOrNull(cols, 49),
    item_code: textOrNull(cols, 27),
    item_name: textOrNull(cols, 29),
    qty: numOrNull(cols, 37),
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

  const purchase_date = dateOrNull(cols, 22);

  // 対象2期間(2024/9/21〜2026/9/20)より前・後の仕入日は取り込まない。
  if (isOutsideRetentionWindow(purchase_date)) return null;

  return {
    order_no: textOrNull(cols, 17),
    order_line: textOrNull(cols, 18),
    purchase_no: textOrNull(cols, 15),
    purchase_line: textOrNull(cols, 16),
    purchase_date,
    supplier_name: textOrNull(cols, 2),
    customer_name: textOrNull(cols, 52),
    item_code: textOrNull(cols, 27),
    item_name: textOrNull(cols, 29),
    qty: numOrNull(cols, 36),
    unit_price: numOrNull(cols, 39),
  };
}
