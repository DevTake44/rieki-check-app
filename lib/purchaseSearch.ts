// 仕入価格検索のロジックをまとめた場所。
import { getSalesDashboardSupabaseClient as getSupabaseServerClient } from "./supabaseSalesDashboard";
import { normalizeForSearch } from "./textNormalize";

const DUMMY_PRODUCT_CODE = "77700";
const MAX_MATCHED_PRODUCTS = 20;
const MAX_KEYWORDS = 6; // 元のVBAは2語までだったが、ダッシュボードなので上限を緩めている

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
  return (data ?? []) as PurchaseHistoryRow[];
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
