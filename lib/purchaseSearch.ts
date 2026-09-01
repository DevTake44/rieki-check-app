// 仕入価格検索のロジックをまとめた場所。
//
// 設計(2026-09-01、sales-dashboardには繋がず完結させる方針に変更):
// 当初はsales-dashboard側のSupabaseプロジェクト(product_master・purchases_detail・
// supplier_master)を参照する設計だったが、ユーザーの指示により、rieki-check自身が
// 既に持っている purchase_lines(値上げ検知機能用に取り込み済みの仕入データ)と
// sales_lines だけで完結させる形に変更した。
//
// その後(同日追加): 商品マスタ・仕入先マスタをrieki-check自身にも持つように変更。
// 理由: 商品マスタが無いと、「登録済みだが今期まだ仕入実績が無い商品コード」を
// 検索したときに検索結果0件(=事実上「不明」)になってしまい、コード自体が
// 存在するのか誤りなのか判断できない、という問題があったため。
// 商品コード検索は、まず product_master を見て、登録があればそれを正とする
// (仕入実績が無くても「登録はある」という結果を返す)。無ければ従来通り
// purchase_lines の実績から探す(ダミーコード77700など、マスタに乗らない
// コードのため)。キーワード検索も同様に、product_master(正規化した品名)を
// 優先しつつ、purchase_linesの実績もあわせて検索する。
//
// この変更でも残る制約(rieki-check側にそもそも対応するデータが無いため):
//   ・仕入先コード(supplier_code)による名寄せは商品マスタ経由でのみ可能。
//     実際の仕入実績(purchase_lines)は仕入先名(テキスト)のみを持つため、
//     マスタ登録仕入先と実績仕入先の突き合わせは「名前の一致」で行う。
//   ・仕様(spec)列。purchase_linesにこの列が無いため表示できない。
//   ・仕入実績の期間。sales-dashboard側は約3年分(2023/9〜)だったが、rieki-check自身の
//     purchase_linesは行データの保持期間設定(lib/row-mapping.tsのRETENTION_FROM/TO)
//     に連動し、直近の会計期間分(2026-09-01時点で2025/9〜)のみ。
import { getSupabaseServerClient as getRiekiSupabaseClient } from "./supabase-server";
import { normalizeForSearch } from "./textNormalize";

const DUMMY_PRODUCT_CODE = "77700";
const FREIGHT_ITEM_CODE = "99";
const MAX_MATCHED_PRODUCTS = 20;
const MAX_KEYWORDS = 6;
const KEYWORD_SEARCH_LIMIT = 5000; // ILIKEでヒットしうる生の明細行数の上限(重複排除前)
const BATCH_SIZE = 200; // .in()フィルタのURL長対策で分割する単位

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type SupplierPriceRow = {
  supplier_name: string;
  unit_price: number | null;
  purchase_date: string;
};

export type PurchaseHistoryRow = {
  purchase_date: string;
  supplier_name: string | null;
  unit_price: number | null;
  purchase_number: string;
  purchase_line: string;
  // 突き合わせ結果(受注番号+行番号でsales_linesを引いた結果)
  customer_name: string | null;
  sell_price: number | null;
  delivery_note_no: string | null;
  freight_amount: number | null; // 同じ仕入伝票(purchase_no)内の運賃(品番99)行の単価
};

export type MasterInfo = {
  product_name: string;
  product_kana: string | null;
  is_deleted: boolean;
  primary_supplier_code: string | null;
  primary_supplier_name: string | null;
  primary_supplier_price: number | null;
  secondary_supplier_code: string | null;
  secondary_supplier_name: string | null;
  secondary_supplier_price: number | null;
};

export type ProductSearchResult = {
  product_code: string;
  product_name: string;
  master: MasterInfo | null;
  masterMismatch: string | null;
  latestBySupplier: SupplierPriceRow[];
  history: PurchaseHistoryRow[];
};

export type SearchOutcome = {
  results: ProductSearchResult[];
  truncated: boolean;
};

async function findMatchingProducts(
  mode: "code" | "keyword",
  query: string
): Promise<{ product_code: string; product_name: string }[]> {
  const supabase = getRiekiSupabaseClient();

  if (mode === "code") {
    const code = query.trim();
    if (code === "") return [];

    // 商品マスタに登録があれば、それを正とする(仕入実績がまだ無くても
    // 「登録されている」という結果を返すため。ここで0件にしてしまうと
    // 「マスタにある商品コードなのに検索結果が不明」という混乱を招く)。
    const { data: masterRows } = await supabase
      .from("product_master")
      .select("product_code, product_name")
      .eq("product_code", code)
      .limit(1);
    if (masterRows && masterRows.length > 0) {
      return [
        { product_code: masterRows[0].product_code as string, product_name: masterRows[0].product_name as string },
      ];
    }

    // マスタに無ければ、仕入実績(purchase_lines)から探す
    // (ダミーコード77700や、マスタ未登録だが実績はある商品コードに対応)。
    const { data } = await supabase
      .from("purchase_lines")
      .select("item_code, item_name")
      .eq("item_code", code)
      .not("item_name", "is", null)
      .limit(1);
    if (!data || data.length === 0) return [];
    return [{ product_code: data[0].item_code as string, product_name: data[0].item_name as string }];
  }

  // keywordモード: スペース区切りで何語でもAND検索。
  const keywords = query
    .split(/\s+/)
    .map((k) => k.trim())
    .filter((k) => k !== "")
    .slice(0, MAX_KEYWORDS);
  if (keywords.length === 0) return [];

  const seen = new Set<string>();
  const results: { product_code: string; product_name: string }[] = [];

  // 1. 商品マスタを、正規化した品名(表記ゆれを吸収)で検索。優先して先に載せる。
  const normalizedKeywords = keywords.map((k) => normalizeForSearch(k)).filter((k) => k !== "");
  if (normalizedKeywords.length > 0) {
    let mq = supabase
      .from("product_master")
      .select("product_code, product_name")
      .eq("is_deleted", false);
    for (const kw of normalizedKeywords) {
      mq = mq.ilike("product_name_normalized", `%${kw}%`);
    }
    const { data: masterMatches } = await mq.limit(MAX_MATCHED_PRODUCTS + 1);
    for (const row of masterMatches ?? []) {
      const code = row.product_code as string;
      if (seen.has(code)) continue;
      seen.add(code);
      results.push({ product_code: code, product_name: row.product_name as string });
      if (results.length >= MAX_MATCHED_PRODUCTS + 1) break;
    }
  }

  // 2. purchase_lines.item_nameも検索(マスタ未登録の商品・77700対応)。
  //    こちらは正規化されていない生データなので、そのままILIKEする。
  if (results.length < MAX_MATCHED_PRODUCTS + 1) {
    let q = supabase
      .from("purchase_lines")
      .select("item_code, item_name")
      .neq("item_code", FREIGHT_ITEM_CODE)
      .not("item_code", "is", null)
      .not("item_name", "is", null);
    for (const kw of keywords) {
      q = q.ilike("item_name", `%${kw}%`);
    }
    const { data } = await q.limit(KEYWORD_SEARCH_LIMIT);

    // 品番77700は色々な雑多な明細で使い回されているダミーコードなので、
    // 品名ごとに別商品として扱う。それ以外は品番で一意。
    for (const row of data ?? []) {
      const code = row.item_code as string;
      const name = row.item_name as string;
      const key = code === DUMMY_PRODUCT_CODE ? `${DUMMY_PRODUCT_CODE}::${name}` : code;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ product_code: code, product_name: name });
      if (results.length >= MAX_MATCHED_PRODUCTS + 1) break;
    }
  }

  return results;
}

type RiekiSalesLineRow = {
  order_no: string | null;
  order_line: string | null;
  customer_name: string | null;
  sell_price: number | null;
  delivery_note_no: string | null;
};

// 仕入履歴に、同じDB内のsales_linesを受注番号+行番号で突き合わせて、
// 対応する得意先名・売値・納品書番号を追加する。運賃は売上側ではなく、
// 同じ仕入伝票(purchase_no)内の運賃行(品番99)を使う。
async function enrichHistoryWithSalesInfo(
  rows: {
    purchase_date: string;
    supplier_name: string | null;
    unit_price: number | null;
    purchase_no: string | null;
    purchase_line: string | null;
    order_no: string | null;
    order_line: string | null;
  }[],
  freightByPurchaseNo: Map<string, number>
): Promise<PurchaseHistoryRow[]> {
  const supabase = getRiekiSupabaseClient();

  const orderNos = Array.from(new Set(rows.map((r) => r.order_no).filter((v): v is string => !!v)));
  const salesRows: RiekiSalesLineRow[] = [];
  for (const batch of chunk(orderNos, BATCH_SIZE)) {
    const { data } = await supabase
      .from("sales_lines")
      .select("order_no, order_line, customer_name, sell_price, delivery_note_no")
      .in("order_no", batch);
    if (data) salesRows.push(...(data as RiekiSalesLineRow[]));
  }
  const salesByKey = new Map<string, RiekiSalesLineRow>();
  for (const row of salesRows) {
    if (!row.order_no) continue;
    salesByKey.set(`${row.order_no}__${(row.order_line ?? "").trim()}`, row);
  }

  return rows.map((r) => {
    const sales = r.order_no
      ? salesByKey.get(`${r.order_no}__${(r.order_line ?? "").trim()}`)
      : undefined;
    return {
      purchase_date: r.purchase_date,
      supplier_name: r.supplier_name,
      unit_price: r.unit_price,
      purchase_number: r.purchase_no ?? "",
      purchase_line: r.purchase_line ?? "",
      customer_name: sales?.customer_name ?? null,
      sell_price: sales?.sell_price ?? null,
      delivery_note_no: sales?.delivery_note_no ?? null,
      freight_amount: r.purchase_no ? freightByPurchaseNo.get(r.purchase_no) ?? null : null,
    };
  });
}

async function fetchHistory(productCode: string, productName?: string): Promise<PurchaseHistoryRow[]> {
  const supabase = getRiekiSupabaseClient();
  let q = supabase
    .from("purchase_lines")
    .select("purchase_date, supplier_name, unit_price, purchase_no, purchase_line, order_no, order_line")
    .eq("item_code", productCode)
    .order("purchase_date", { ascending: false });

  // 77700は品名込みで絞らないと、無関係な明細まで混ざってしまう
  if (productCode === DUMMY_PRODUCT_CODE && productName) {
    q = q.eq("item_name", productName);
  }

  const { data } = await q;
  const rows = (data ?? []) as {
    purchase_date: string;
    supplier_name: string | null;
    unit_price: number | null;
    purchase_no: string | null;
    purchase_line: string | null;
    order_no: string | null;
    order_line: string | null;
  }[];
  if (rows.length === 0) return [];

  // 同じ仕入伝票(purchase_no)内の運賃行(品番99)をまとめて取得する
  const purchaseNumbers = Array.from(new Set(rows.map((r) => r.purchase_no).filter((v): v is string => !!v)));
  const freightByPurchaseNo = new Map<string, number>();
  for (const batch of chunk(purchaseNumbers, BATCH_SIZE)) {
    const { data: freightRows } = await supabase
      .from("purchase_lines")
      .select("purchase_no, unit_price")
      .in("purchase_no", batch)
      .eq("item_code", FREIGHT_ITEM_CODE);
    for (const fr of freightRows ?? []) {
      if (!fr.purchase_no) continue;
      const prev = freightByPurchaseNo.get(fr.purchase_no) ?? 0;
      freightByPurchaseNo.set(fr.purchase_no, prev + (fr.unit_price ?? 0));
    }
  }

  return enrichHistoryWithSalesInfo(rows, freightByPurchaseNo);
}

type ProductMasterRow = {
  product_code: string;
  product_name: string;
  product_kana: string | null;
  is_deleted: boolean;
  primary_supplier_code: string | null;
  primary_supplier_price: number | null;
  secondary_supplier_code: string | null;
  secondary_supplier_price: number | null;
};

// 対象の品番一覧について、商品マスタ(+仕入先マスタで名前解決したもの)を
// まとめて取得する。検索結果1件ごとに問い合わせず、一括で取得してMapにする。
async function fetchMasterMap(productCodes: string[]): Promise<Map<string, MasterInfo>> {
  const map = new Map<string, MasterInfo>();
  const codes = Array.from(new Set(productCodes));
  if (codes.length === 0) return map;

  const supabase = getRiekiSupabaseClient();
  const masterRows: ProductMasterRow[] = [];
  for (const batch of chunk(codes, BATCH_SIZE)) {
    const { data } = await supabase
      .from("product_master")
      .select(
        "product_code, product_name, product_kana, is_deleted, primary_supplier_code, primary_supplier_price, secondary_supplier_code, secondary_supplier_price"
      )
      .in("product_code", batch);
    if (data) masterRows.push(...(data as ProductMasterRow[]));
  }
  if (masterRows.length === 0) return map;

  const supplierCodes = Array.from(
    new Set(
      masterRows
        .flatMap((r) => [r.primary_supplier_code, r.secondary_supplier_code])
        .filter((v): v is string => !!v)
    )
  );
  const supplierNameByCode = new Map<string, string>();
  for (const batch of chunk(supplierCodes, BATCH_SIZE)) {
    const { data } = await supabase.from("supplier_master").select("supplier_code, supplier_name").in("supplier_code", batch);
    for (const s of data ?? []) {
      supplierNameByCode.set(s.supplier_code as string, s.supplier_name as string);
    }
  }

  for (const r of masterRows) {
    map.set(r.product_code, {
      product_name: r.product_name,
      product_kana: r.product_kana,
      is_deleted: r.is_deleted,
      primary_supplier_code: r.primary_supplier_code,
      primary_supplier_name: r.primary_supplier_code ? supplierNameByCode.get(r.primary_supplier_code) ?? null : null,
      primary_supplier_price: r.primary_supplier_price,
      secondary_supplier_code: r.secondary_supplier_code,
      secondary_supplier_name: r.secondary_supplier_code
        ? supplierNameByCode.get(r.secondary_supplier_code) ?? null
        : null,
      secondary_supplier_price: r.secondary_supplier_price,
    });
  }
  return map;
}

// マスタ登録の仕入先(primary_supplier_name)と、実際の最安仕入先(latestBySupplierの
// 先頭=単価が一番安いもの)が名前で一致するか比べる。仕入実績が無い場合や、
// マスタに仕入先登録が無い場合は判定しない(比べる相手がいないため)。
function computeMasterMismatch(master: MasterInfo | null, latestBySupplier: SupplierPriceRow[]): string | null {
  if (!master || !master.primary_supplier_name) return null;
  if (latestBySupplier.length === 0) return null;
  const cheapest = latestBySupplier[0];
  if (!cheapest.supplier_name) return null;
  if (cheapest.supplier_name.trim() === master.primary_supplier_name.trim()) return null;
  return `商品マスタ登録の仕入先は「${master.primary_supplier_name}」ですが、実績上いちばん安い仕入先は「${cheapest.supplier_name}」です。`;
}

function latestBySupplierFrom(history: PurchaseHistoryRow[]): SupplierPriceRow[] {
  const bySupplier = new Map<string, SupplierPriceRow>();
  for (const row of history) {
    if (!row.supplier_name) continue;
    const existing = bySupplier.get(row.supplier_name);
    if (!existing || row.purchase_date > existing.purchase_date) {
      bySupplier.set(row.supplier_name, {
        supplier_name: row.supplier_name,
        unit_price: row.unit_price,
        purchase_date: row.purchase_date,
      });
    }
  }
  return Array.from(bySupplier.values()).sort((a, b) => {
    if (a.unit_price === null && b.unit_price === null) return 0;
    if (a.unit_price === null) return 1;
    if (b.unit_price === null) return -1;
    return a.unit_price - b.unit_price;
  });
}

export async function searchPurchasePrices(
  mode: "code" | "keyword",
  query: string
): Promise<SearchOutcome> {
  const matches = await findMatchingProducts(mode, query);
  const truncated = matches.length > MAX_MATCHED_PRODUCTS;
  const targets = matches.slice(0, MAX_MATCHED_PRODUCTS);

  const masterMap = await fetchMasterMap(targets.map((t) => t.product_code));

  const results: ProductSearchResult[] = [];
  for (const m of targets) {
    const history = await fetchHistory(m.product_code, m.product_name);
    const latestBySupplier = latestBySupplierFrom(history);
    const master = masterMap.get(m.product_code) ?? null;
    const masterMismatch = computeMasterMismatch(master, latestBySupplier);

    results.push({
      product_code: m.product_code,
      product_name: m.product_name,
      master,
      masterMismatch,
      latestBySupplier,
      history,
    });
  }

  return { results, truncated };
}
