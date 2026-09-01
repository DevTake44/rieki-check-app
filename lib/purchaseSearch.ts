// 仕入価格検索のロジックをまとめた場所。
import { getSalesDashboardSupabaseClient as getSupabaseServerClient } from "./supabaseSalesDashboard";
import { getSupabaseServerClient as getRiekiSupabaseClient } from "./supabase-server";
import { normalizeForSearch } from "./textNormalize";

const DUMMY_PRODUCT_CODE = "77700";
const FREIGHT_ITEM_CODE = "99";
const MAX_MATCHED_PRODUCTS = 20;
const MAX_KEYWORDS = 6; // 元のVBAは2語までだったが、ダッシュボードなので上限を緩めている
const BATCH_SIZE = 200; // .in()フィルタのURL長対策で分割する単位

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type SupplierPriceRow = {
  supplier_code: string;
  supplier_name: string | null;
  unit_price: number | null;
  purchase_date: string;
};

export type PurchaseHistoryRow = {
  purchase_date: string;
  supplier_code: string | null;
  supplier_name: string | null;
  unit_price: number | null;
  spec: string | null;
  purchase_number: string;
  purchase_line: number;
  // 追加(2026-09-01、rieki-check自身のpurchase_lines/sales_linesとの突き合わせ):
  // purchases_detail.purchase_number/purchase_line は、rieki-check側のpurchase_lines.
  // purchase_no/purchase_lineと同じ値(仕入番号・仕入行番号)を指す。purchase_linesは
  // 同じ仕入伝票(purchase_no)の中に商品行と運賃行(item_code=99)を両方持っており、
  // かつ商品行には対応する受注番号・受注行番号(order_no/order_line)が入っている。
  // その受注番号・行番号でrieki-check自身のsales_linesを引けば、対応する得意先・売値が
  // わかる。運賃は売上側ではなく、この仕入伝票に載っている運賃行(=仕入れの運賃)を使う。
  customer_name: string | null;
  sell_price: number | null;
  delivery_note_no: string | null;
  freight_amount: number | null;
};

export type MasterInfo = {
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
  latestBySupplier: SupplierPriceRow[];
  master: MasterInfo | null;
  masterMismatch: boolean;
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
  const supabase = getSupabaseServerClient();

  if (mode === "code") {
    const code = query.trim();
    if (code === "") return [];

    const { data: masterRows } = await supabase
      .from("product_master")
      .select("product_code, product_name")
      .eq("product_code", code)
      .limit(1);
    if (masterRows && masterRows.length > 0) return masterRows;

    const { data: historyRows } = await supabase
      .from("purchases_detail")
      .select("product_code, product_name")
      .eq("product_code", code)
      .limit(1);
    if (historyRows && historyRows.length > 0) return historyRows;

    return [];
  }

  // keyword モード: スペース区切りで何語でもAND検索(表記ゆれ吸収済みの列に対して)
  const keywords = query
    .split(/\s+/)
    .map((k) => normalizeForSearch(k))
    .filter((k) => k !== "")
    .slice(0, MAX_KEYWORDS);
  if (keywords.length === 0) return [];

  // ① 通常の商品マスタからの検索
  let masterQuery = supabase
    .from("product_master")
    .select("product_code, product_name")
    .eq("is_deleted", false);
  for (const kw of keywords) {
    masterQuery = masterQuery.ilike("product_name_normalized", `%${kw}%`);
  }
  const { data: masterMatches } = await masterQuery.limit(MAX_MATCHED_PRODUCTS + 1);

  // ② ダミーコード77700は商品マスタに存在しないため、仕入実績の品名を直接検索する。
  //    77700は色々な雑多な明細で使い回されているので、品名ごとに別商品として扱う。
  const rawKeywords = query
    .split(/\s+/)
    .map((k) => k.trim())
    .filter((k) => k !== "")
    .slice(0, MAX_KEYWORDS);
  let dummyQuery = supabase
    .from("purchases_detail")
    .select("product_name")
    .eq("product_code", DUMMY_PRODUCT_CODE);
  for (const kw of rawKeywords) {
    dummyQuery = dummyQuery.ilike("product_name", `%${kw}%`);
  }
  const { data: dummyRows } = await dummyQuery.limit(2000);
  const dummyNames = Array.from(new Set((dummyRows ?? []).map((r) => r.product_name))).slice(
    0,
    MAX_MATCHED_PRODUCTS
  );
  const dummyMatches = dummyNames.map((name) => ({
    product_code: DUMMY_PRODUCT_CODE,
    product_name: name,
  }));

  return [...(masterMatches ?? []), ...dummyMatches];
}

type RiekiPurchaseLineRow = {
  purchase_no: string | null;
  purchase_line: string | null;
  order_no: string | null;
  order_line: string | null;
  item_code: string | null;
  unit_price: number | null;
};

type RiekiSalesLineRow = {
  order_no: string | null;
  order_line: string | null;
  customer_name: string | null;
  sell_price: number | null;
  delivery_note_no: string | null;
};

// purchases_detail(sales-dashboard側)の仕入履歴に、rieki-check自身のpurchase_lines/
// sales_linesを突き合わせて、対応する得意先名・売値・納品書番号・運賃(仕入側)を追加する。
// 突き合わせキー: purchases_detail.purchase_number/purchase_line
//   = purchase_lines.purchase_no/purchase_line (同じ仕入番号・仕入行番号)
//   → purchase_lines.order_no/order_line = sales_lines.order_no/order_line (同じ受注番号・行番号)
async function enrichHistoryWithSalesInfo(
  history: PurchaseHistoryRow[]
): Promise<PurchaseHistoryRow[]> {
  if (history.length === 0) return history;
  const rieki = getRiekiSupabaseClient();

  const purchaseNumbers = Array.from(new Set(history.map((h) => h.purchase_number).filter(Boolean)));
  const purchaseLineRows: RiekiPurchaseLineRow[] = [];
  for (const batch of chunk(purchaseNumbers, BATCH_SIZE)) {
    const { data } = await rieki
      .from("purchase_lines")
      .select("purchase_no, purchase_line, order_no, order_line, item_code, unit_price")
      .in("purchase_no", batch);
    if (data) purchaseLineRows.push(...(data as RiekiPurchaseLineRow[]));
  }

  // purchase_no ごとに、同じ仕入伝票内の全行(商品行・運賃行)をまとめる
  const byPurchaseNo = new Map<string, RiekiPurchaseLineRow[]>();
  for (const row of purchaseLineRows) {
    if (!row.purchase_no) continue;
    const arr = byPurchaseNo.get(row.purchase_no) ?? [];
    arr.push(row);
    byPurchaseNo.set(row.purchase_no, arr);
  }

  // 履歴行ごとに、対応する受注番号・行番号と、同じ伝票内の運賃(品番99)を特定する
  type Linked = { orderNo: string | null; orderLine: string | null; freight: number | null };
  const linkedByHistoryIndex = new Map<number, Linked>();
  const orderNoSet = new Set<string>();
  history.forEach((h, idx) => {
    const siblings = byPurchaseNo.get(h.purchase_number) ?? [];
    const productLine = siblings.find(
      (s) => (s.purchase_line ?? "").trim() === String(h.purchase_line ?? "").trim()
    );
    const freightRows = siblings.filter((s) => (s.item_code ?? "").trim() === FREIGHT_ITEM_CODE);
    const freight =
      freightRows.length > 0
        ? freightRows.reduce((sum, r) => sum + (r.unit_price ?? 0), 0)
        : null;
    const orderNo = productLine?.order_no ?? null;
    const orderLine = productLine?.order_line ?? null;
    linkedByHistoryIndex.set(idx, { orderNo, orderLine, freight });
    if (orderNo) orderNoSet.add(orderNo);
  });

  const salesLineRows: RiekiSalesLineRow[] = [];
  for (const batch of chunk(Array.from(orderNoSet), BATCH_SIZE)) {
    const { data } = await rieki
      .from("sales_lines")
      .select("order_no, order_line, customer_name, sell_price, delivery_note_no")
      .in("order_no", batch);
    if (data) salesLineRows.push(...(data as RiekiSalesLineRow[]));
  }
  const salesByKey = new Map<string, RiekiSalesLineRow>();
  for (const row of salesLineRows) {
    if (!row.order_no) continue;
    const key = `${row.order_no}__${(row.order_line ?? "").trim()}`;
    salesByKey.set(key, row);
  }

  return history.map((h, idx) => {
    const linked = linkedByHistoryIndex.get(idx);
    const sales = linked?.orderNo
      ? salesByKey.get(`${linked.orderNo}__${(linked.orderLine ?? "").trim()}`)
      : undefined;
    return {
      ...h,
      customer_name: sales?.customer_name ?? null,
      sell_price: sales?.sell_price ?? null,
      delivery_note_no: sales?.delivery_note_no ?? null,
      freight_amount: linked?.freight ?? null,
    };
  });
}

async function fetchHistory(productCode: string, productName?: string): Promise<PurchaseHistoryRow[]> {
  const supabase = getSupabaseServerClient();
  let q = supabase
    .from("purchases_detail")
    .select(
      "purchase_date, supplier_code, supplier_name, unit_price, spec, purchase_number, purchase_line"
    )
    .eq("product_code", productCode)
    .order("purchase_date", { ascending: false });

  // 77700は品名込みで絞らないと、無関係な明細まで混ざってしまう
  if (productCode === DUMMY_PRODUCT_CODE && productName) {
    q = q.eq("product_name", productName);
  }

  const { data } = await q;
  const rows = (data ?? []) as PurchaseHistoryRow[];
  return enrichHistoryWithSalesInfo(rows);
}

function latestBySupplierFrom(history: PurchaseHistoryRow[]): SupplierPriceRow[] {
  const bySupplier = new Map<string, SupplierPriceRow>();
  for (const row of history) {
    if (!row.supplier_code) continue;
    const existing = bySupplier.get(row.supplier_code);
    if (!existing || row.purchase_date > existing.purchase_date) {
      bySupplier.set(row.supplier_code, {
        supplier_code: row.supplier_code,
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

async function fetchMaster(productCode: string): Promise<MasterInfo | null> {
  const supabase = getSupabaseServerClient();
  const { data } = await supabase
    .from("product_master")
    .select(
      "primary_supplier_code, primary_supplier_price, secondary_supplier_code, secondary_supplier_price"
    )
    .eq("product_code", productCode)
    .maybeSingle();
  if (!data) return null;

  const codes = [data.primary_supplier_code, data.secondary_supplier_code].filter(
    (c): c is string => !!c
  );
  let nameByCode = new Map<string, string>();
  if (codes.length > 0) {
    const { data: suppliers } = await supabase
      .from("supplier_master")
      .select("supplier_code, supplier_name")
      .in("supplier_code", codes);
    nameByCode = new Map((suppliers ?? []).map((s) => [s.supplier_code, s.supplier_name]));
  }

  return {
    primary_supplier_code: data.primary_supplier_code,
    primary_supplier_name: data.primary_supplier_code
      ? nameByCode.get(data.primary_supplier_code) ?? null
      : null,
    primary_supplier_price: data.primary_supplier_price,
    secondary_supplier_code: data.secondary_supplier_code,
    secondary_supplier_name: data.secondary_supplier_code
      ? nameByCode.get(data.secondary_supplier_code) ?? null
      : null,
    secondary_supplier_price: data.secondary_supplier_price,
  };
}

export async function searchPurchasePrices(
  mode: "code" | "keyword",
  query: string
): Promise<SearchOutcome> {
  const matches = await findMatchingProducts(mode, query);
  const truncated = matches.length > MAX_MATCHED_PRODUCTS;
  const targets = matches.slice(0, MAX_MATCHED_PRODUCTS);

  const results: ProductSearchResult[] = [];
  for (const m of targets) {
    const history = await fetchHistory(m.product_code, m.product_name);
    const latestBySupplier = latestBySupplierFrom(history);
    const master = await fetchMaster(m.product_code);

    const cheapestSupplierCode = latestBySupplier[0]?.supplier_code ?? null;
    const masterMismatch =
      !!master?.primary_supplier_code &&
      !!cheapestSupplierCode &&
      master.primary_supplier_code !== cheapestSupplierCode;

    results.push({
      product_code: m.product_code,
      product_name: m.product_name,
      latestBySupplier,
      master,
      masterMismatch,
      history,
    });
  }

  return { results, truncated };
}
