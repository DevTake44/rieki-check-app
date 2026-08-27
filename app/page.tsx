export const maxDuration = 60;

import { fetchAllMonthlyRows } from "@/lib/fetchMonthly";
import { fetchStockDetailRows } from "@/lib/fetchStockDetail";
import { fetchPurchaseLots, fetchStockShipments } from "@/lib/fetchStockMovement";
import { buildDashboard } from "@/lib/buildDashboard";
import { buildStockDetail } from "@/lib/buildStockDetail";
import { buildStockMovement } from "@/lib/buildStockMovement";
import type { StockMovementData } from "@/lib/buildStockMovement";
import DashboardClient from "@/components/DashboardClient";

// 常に最新データを取得する（キャッシュしない）
export const dynamic = "force-dynamic";

export default async function Page() {
  try {
    const [rows, stockRows] = await Promise.all([fetchAllMonthlyRows(), fetchStockDetailRows()]);
    const data = buildDashboard(rows);
    const stockDetail = buildStockDetail(stockRows, data.summary.CUR, data.summary.PREV);

    // 不動在庫チェック(rieki-check連携)は、まだ環境変数が未設定の場合もあるため、
    // ここで失敗してもダッシュボード全体は表示できるように、別途catchする。
    let stockMovement: StockMovementData | null = null;
    let stockMovementError: string | null = null;
    try {
      const [purchaseLots, shipments] = await Promise.all([fetchPurchaseLots(), fetchStockShipments()]);
      const today = new Date().toISOString().slice(0, 10);
      stockMovement = buildStockMovement(purchaseLots, shipments, today);
    } catch (e) {
      stockMovementError = e instanceof Error ? e.message : "不明なエラーが発生しました。";
    }

    return (
      <DashboardClient
        data={data}
        stockDetail={stockDetail}
        stockMovement={stockMovement}
        stockMovementError={stockMovementError}
      />
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "不明なエラーが発生しました。";
    return (
      <div style={{ maxWidth: 640, margin: "80px auto", padding: 24, fontFamily: "sans-serif" }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>
          データの読み込みでエラーが発生しました
        </h1>
        <p style={{ fontSize: 14, color: "#555", lineHeight: 1.6 }}>{message}</p>
        <p style={{ fontSize: 13, color: "#888", marginTop: 16 }}>
          Vercelの環境変数（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）が正しく設定されているか、
          Supabase側でデータが正しく入っているかを確認してください。
        </p>
      </div>
    );
  }
}
