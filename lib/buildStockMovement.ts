// 「不動在庫チェック」の本体ロジック。
// 商品ごとに、仕入(在庫として仕入れた分)を古い順の「ロット」として並べ、
// rieki-checkの出荷実績(在庫区分の売上)を日付順に消化させていく(先入れ先出し=FIFO)。
// 出荷で消化しきれずに残ったロットが「現在の在庫」で、その中で一番古いロットの仕入日をもとに
// 在庫期間を計算する。最後に出荷されてから365日(1年)以上動きが無い商品を「不動在庫候補」とする。

import type { PurchaseLotRow, ShipmentRow } from "./fetchStockMovement";

// 雑多な商品で使い回されているダミーの品番。品名込みで別商品として扱う(lib/buildStockDetail.tsと同じ考え方)。
const DUMMY_PRODUCT_CODE = "77700";
// 商品ではない行(運賃など)。実データ確認済み: product_code="99"は「運賃」。
const EXCLUDED_PRODUCT_CODES = new Set(["99"]);

export const DEAD_STOCK_DAYS = 365; // 不動在庫と判定する経過日数(1年)

function itemKey(code: string | null, name: string | null): { key: string; name: string } {
  const c = (code ?? "").trim() || "(不明)";
  const n = (name ?? "").trim() || c;
  const key = c === DUMMY_PRODUCT_CODE ? `${c}__${n}` : c;
  return { key, name: n };
}

type Lot = { date: string; qtyRemaining: number; unitPrice: number };

export type StockMovementItem = {
  key: string;
  name: string;
  qtyOnHand: number; // 現在庫の推定数量(仕入金額÷仕入単価から算出)
  amountOnHand: number; // 現在庫の推定金額
  oldestLotDate: string; // 残っている在庫の中で一番古い仕入日
  ageDays: number; // 今日 - oldestLotDate
  lastShipmentDate: string | null; // 最後にこの商品が出荷された日(在庫区分の売上)
  daysSinceShipment: number | null; // 今日 - lastShipmentDate(出荷実績が無ければnull)
  isDead: boolean; // 不動在庫候補かどうか
};

export type StockMovementData = {
  asOf: string; // 計算基準日(YYYY-MM-DD)
  deadThresholdDays: number;
  items: StockMovementItem[]; // 在庫が残っている商品のみ。在庫金額が多い順
  totalItemsWithStock: number;
  deadCount: number;
  deadAmount: number;
  unmatchedShipmentQty: number; // 手元の仕入データより前に仕入れたと思われる、対応づけできなかった出荷数量(参考値)
};

function daysBetween(from: string, to: string): number {
  const a = new Date(from + "T00:00:00Z").getTime();
  const b = new Date(to + "T00:00:00Z").getTime();
  return Math.round((b - a) / 86400000);
}

export function buildStockMovement(
  purchaseRows: PurchaseLotRow[],
  shipmentRows: ShipmentRow[],
  today: string // YYYY-MM-DD。呼び出し側(app/page.tsx)で固定して渡す
): StockMovementData {
  // 商品ごとに仕入ロットをまとめ、古い順に並べる
  const lotsByKey = new Map<string, { name: string; lots: Lot[] }>();

  for (const r of purchaseRows) {
    if (!r.purchase_date || !r.unit_price) continue;
    const codeRaw = (r.product_code ?? "").trim();
    if (EXCLUDED_PRODUCT_CODES.has(codeRaw)) continue;
    const { key, name } = itemKey(r.product_code, r.product_name);
    const qty = r.amount / r.unit_price;
    if (!isFinite(qty) || qty === 0) continue;
    let acc = lotsByKey.get(key);
    if (!acc) {
      acc = { name, lots: [] };
      lotsByKey.set(key, acc);
    }
    acc.lots.push({ date: r.purchase_date, qtyRemaining: qty, unitPrice: r.unit_price });
  }
  for (const acc of lotsByKey.values()) {
    acc.lots.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // 商品ごとに出荷実績をまとめ、古い順に並べる
  const shipmentsByKey = new Map<string, { name: string; shipments: { date: string; qty: number }[] }>();
  for (const r of shipmentRows) {
    if (!r.delivery_date || !r.qty) continue;
    const { key, name } = itemKey(r.item_code, r.item_name);
    let acc = shipmentsByKey.get(key);
    if (!acc) {
      acc = { name, shipments: [] };
      shipmentsByKey.set(key, acc);
    }
    acc.shipments.push({ date: r.delivery_date, qty: r.qty });
  }
  for (const acc of shipmentsByKey.values()) {
    acc.shipments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  let unmatchedShipmentQty = 0;
  const lastShipmentByKey = new Map<string, string>();

  // 出荷を古い順に、対応する商品の仕入ロットから先入れ先出しで消化する
  for (const [key, sAcc] of shipmentsByKey.entries()) {
    const pAcc = lotsByKey.get(key);

    for (const shp of sAcc.shipments) {
      const prevLast = lastShipmentByKey.get(key);
      if (!prevLast || shp.date > prevLast) lastShipmentByKey.set(key, shp.date);

      let remaining = shp.qty;
      if (!pAcc) {
        // この商品の仕入データが手元に無い(仕入データの範囲より前に仕入れたなど)
        unmatchedShipmentQty += remaining;
        continue;
      }
      let li = 0;
      while (remaining > 0 && li < pAcc.lots.length) {
        const lot = pAcc.lots[li];
        if (lot.qtyRemaining <= 1e-9) {
          li++;
          continue;
        }
        if (lot.date > shp.date) break; // まだ仕入れていない(未来の)ロットからは消化しない
        const consume = Math.min(remaining, lot.qtyRemaining);
        lot.qtyRemaining -= consume;
        remaining -= consume;
        if (lot.qtyRemaining <= 1e-9) li++;
      }
      if (remaining > 1e-9) unmatchedShipmentQty += remaining;
    }
  }

  const items: StockMovementItem[] = [];
  for (const [key, acc] of lotsByKey.entries()) {
    const remainingLots = acc.lots.filter((l) => l.qtyRemaining > 1e-6);
    if (remainingLots.length === 0) continue; // 在庫が残っていない商品は対象外

    const qtyOnHand = remainingLots.reduce((a, l) => a + l.qtyRemaining, 0);
    const amountOnHand = remainingLots.reduce((a, l) => a + l.qtyRemaining * l.unitPrice, 0);
    const oldestLotDate = remainingLots[0].date; // 既に日付順ソート済みなので先頭が最古
    const ageDays = daysBetween(oldestLotDate, today);
    const lastShipmentDate = lastShipmentByKey.get(key) ?? null;
    const daysSinceShipment = lastShipmentDate ? daysBetween(lastShipmentDate, today) : null;
    const isDead = daysSinceShipment == null ? ageDays >= DEAD_STOCK_DAYS : daysSinceShipment >= DEAD_STOCK_DAYS;

    items.push({
      key,
      name: acc.name,
      qtyOnHand: Math.round(qtyOnHand * 100) / 100,
      amountOnHand: Math.round(amountOnHand),
      oldestLotDate,
      ageDays,
      lastShipmentDate,
      daysSinceShipment,
      isDead,
    });
  }

  items.sort((a, b) => b.amountOnHand - a.amountOnHand);

  const deadItems = items.filter((i) => i.isDead);

  return {
    asOf: today,
    deadThresholdDays: DEAD_STOCK_DAYS,
    items,
    totalItemsWithStock: items.length,
    deadCount: deadItems.length,
    deadAmount: Math.round(deadItems.reduce((a, i) => a + i.amountOnHand, 0)),
    unmatchedShipmentQty: Math.round(unmatchedShipmentQty * 100) / 100,
  };
}
