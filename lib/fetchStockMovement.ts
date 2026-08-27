// 「不動在庫チェック」用のデータ取得。
// 仕入(sales-dashboard自身のDB・拠点90/91)と、在庫出荷実績(rieki-checkのDB・arrange_type='在庫')を
// それぞれ全件取得する。実際の突き合わせ(FIFOマッチング)はbuildStockMovement.tsで行う。

import { getSupabaseServerClient } from "./supabaseServer";
import { getRiekiSupabaseClient } from "./supabaseRieki";

const PAGE_SIZE = 1000;
const STOCK_LOCATION_CODES = ["90", "91"];

export type PurchaseLotRow = {
  product_code: string | null;
  product_name: string | null;
  purchase_date: string | null; // YYYY-MM-DD
  amount: number;
  unit_price: number | null;
};

export type ShipmentRow = {
  item_code: string | null;
  item_name: string | null;
  delivery_date: string | null; // YYYY-MM-DD
  qty: number | null;
};

// sales-dashboard自身のDBから、在庫仕入(拠点90・91)の明細を全件取得する。
export async function fetchPurchaseLots(): Promise<PurchaseLotRow[]> {
  const supabase = getSupabaseServerClient();
  const rows: PurchaseLotRow[] = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("purchases_detail")
      .select("product_code, product_name, purchase_date, amount, unit_price")
      .in("location_code", STOCK_LOCATION_CODES)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) {
      throw new Error(`仕入データの取得に失敗しました: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as PurchaseLotRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}

// rieki-check(別プロジェクト)から、在庫出荷実績(arrange_type='在庫')を全件取得する。
export async function fetchStockShipments(): Promise<ShipmentRow[]> {
  const supabase = getRiekiSupabaseClient();
  const rows: ShipmentRow[] = [];
  let from = 0;
  while (true) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await supabase
      .from("sales_lines")
      .select("item_code, item_name, delivery_date, qty")
      .eq("arrange_type", "在庫")
      .order("id", { ascending: true })
      .range(from, to);
    if (error) {
      throw new Error(`rieki-checkの出荷データ取得に失敗しました: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    rows.push(...(data as ShipmentRow[]));
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows;
}
