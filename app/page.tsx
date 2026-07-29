import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { PriceIncreaseAlert } from "@/lib/types";
import { branchLabel } from "@/lib/branch-names";

// Vercelのキャッシュに古い結果が残らないよう、毎回サーバーで実行する
export const dynamic = "force-dynamic";

function fmtYen(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `¥${Math.round(v).toLocaleString("ja-JP")}`;
}

function fmtPct(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function marginBadge(pct: number | null | undefined) {
  if (pct === null || pct === undefined) return { cls: "neutral", label: "販売単価不明" };
  if (pct <= 0) return { cls: "critical", label: "赤字" };
  if (pct < 10) return { cls: "warning", label: "要注意" };
  return { cls: "good", label: "許容内" };
}

export default async function Home() {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("v_price_increase_alerts")
    .select("*")
    .order("actual_margin_pct", { ascending: true, nullsFirst: false });

  if (error) {
    return (
      <div className="page">
        <h1>値上げ検知ダッシュボード</h1>
        <div className="card">
          <p>データの取得に失敗しました。環境変数(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)が正しく設定されているか確認してください。</p>
          <pre style={{ whiteSpace: "pre-wrap", color: "#c0392b" }}>{error.message}</pre>
        </div>
      </div>
    );
  }

  const rows = (data ?? []) as PriceIncreaseAlert[];
  const totalImpact = rows.reduce((s, r) => s + (r.impact ?? 0), 0);
  const redCount = rows.filter((r) => r.actual_margin_pct !== null && r.actual_margin_pct <= 0).length;
  const lowMarginCount = rows.filter(
    (r) => r.actual_margin_pct !== null && r.actual_margin_pct > 0 && r.actual_margin_pct < 10
  ).length;

  return (
    <div className="page">
      <h1>値上げ検知ダッシュボード</h1>
      <p className="subtitle">
        値上げ検知 {rows.length.toLocaleString("ja-JP")}件 ／ Supabase(v_price_increase_alerts)からリアルタイムに取得
      </p>

      <div className="kpi-row">
        <div className="kpi-tile">
          <div className="label">値上げ検知件数</div>
          <div className="value">{rows.length.toLocaleString("ja-JP")}</div>
        </div>
        <div className="kpi-tile">
          <div className="label">合計影響額</div>
          <div className="value">{fmtYen(totalImpact)}</div>
        </div>
        <div className="kpi-tile">
          <div className="label">赤字転落（緊急）</div>
          <div className="value">{redCount}件</div>
        </div>
        <div className="kpi-tile">
          <div className="label">要注意（粗利10%未満）</div>
          <div className="value">{lowMarginCount}件</div>
        </div>
      </div>

      <div className="card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>区分</th>
                <th>品目</th>
                <th>得意先</th>
                <th>仕入先</th>
                <th>拠点</th>
                <th className="num">受注日</th>
                <th className="num">想定原価</th>
                <th className="num">実際仕入単価</th>
                <th className="num">差額率</th>
                <th className="num">販売単価</th>
                <th className="num">実際粗利率</th>
                <th className="num">影響額</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a, i) => {
                const sev = marginBadge(a.actual_margin_pct);
                return (
                  <tr key={i}>
                    <td>
                      <span className={`badge ${a.category === "在庫" ? "cat-stock" : "cat-direct"}`}>
                        {a.category}
                      </span>
                    </td>
                    <td>
                      {a.item_name}
                      <div className="cell-sub">{a.item_code || "商品コード未登録（個別品）"}</div>
                    </td>
                    <td>{a.customer_name}</td>
                    <td>{a.supplier_name}</td>
                    <td>{branchLabel(a.branch_code)}</td>
                    <td className="num">{a.order_date ?? "—"}</td>
                    <td className="num">{fmtYen(a.assumed_cost)}</td>
                    <td className="num">{fmtYen(a.actual_price)}</td>
                    <td className="num">{fmtPct(a.gap_pct)}</td>
                    <td className="num">{fmtYen(a.sell_price)}</td>
                    <td className="num">
                      <span className={`badge ${sev.cls}`}>
                        {a.actual_margin_pct === null ? sev.label : `${fmtPct(a.actual_margin_pct)} ${sev.label}`}
                      </span>
                    </td>
                    <td className="num">{fmtYen(a.impact)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
