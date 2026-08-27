"use client";

import { useMemo, useState } from "react";
import type { DashboardData, MatrixRow } from "@/lib/types";
import type { StockDetailData, StockSupplierRow, StockProductRow } from "@/lib/buildStockDetail";
import type { StockMovementData, StockMovementItem } from "@/lib/buildStockMovement";
import { yen, jpn, oku, monL } from "@/lib/format";
import TrendChart from "./TrendChart";
import UpdatePage from "./UpdatePage";
type MainTab = "report" | "overview" | "matrix" | "goal" | "stock" | "update";
type OvMode = "cur" | "prev" | "yoy";
type Dim = "loc" | "staff" | "cust";
type Metric = "sales" | "purchase" | "profit" | "prevprofit" | "profitdiff" | "yoyamt" | "yoydiff" | "yoypct" | "margin";

const dimName: Record<Dim, string> = { loc: "拠点", staff: "担当者", cust: "得意先" };

export default function DashboardClient({
  data,
  stockDetail,
  stockMovement,
  stockMovementError,
}: {
  data: DashboardData;
  stockDetail: StockDetailData;
  stockMovement: StockMovementData | null;
  stockMovementError: string | null;
}) {
  const S = data.summary;
  const [mainTab, setMainTab] = useState<MainTab>("report");

  return (
    <div className="wrap">
      <header className="top">
        <div className="title">
          <h1>
            売上ダッシュボード <span className="badge-demo">実データ</span>
          </h1>
          <p>
            今期 {S.CUR}年10月度〜(最新 {monL(data.latest_ym)}度まで)
          </p>
        </div>
        <div className="maintabs">
          <button className={mainTab === "report" ? "active" : ""} onClick={() => setMainTab("report")}>
            経営レポート
          </button>
          <button className={mainTab === "overview" ? "active" : ""} onClick={() => setMainTab("overview")}>
            全体サマリー
          </button>
          <button className={mainTab === "matrix" ? "active" : ""} onClick={() => setMainTab("matrix")}>
            月別マトリクス
          </button>
          <button className={mainTab === "goal" ? "active" : ""} onClick={() => setMainTab("goal")}>
            目標追跡
          </button>
          <button className={mainTab === "stock" ? "active" : ""} onClick={() => setMainTab("stock")}>
            在庫
          </button>
          <button className={mainTab === "update" ? "active" : ""} onClick={() => setMainTab("update")}>
     データ更新
   </button>
        </div>
      </header>

      {mainTab === "report" && <ReportPage data={data} />}
      {mainTab === "overview" && <OverviewPage data={data} />}
      {mainTab === "matrix" && <MatrixPage data={data} />}
      {mainTab === "goal" && <GoalPage data={data} />}
      {mainTab === "stock" && (
        <StockPage stockDetail={stockDetail} stockMovement={stockMovement} stockMovementError={stockMovementError} />
      )}
{mainTab === "update" && <UpdatePage />}
      <p className="foot-note">
        実データに基づくダッシュボードです(売上67,831件・仕入417,217件・前期/今期とも全月集計済み)。
        <br />
        拠点90・91は在庫としての仕入で、個別の売上には紐づきません。
      </p>
    </div>
  );
}

/* ============ 経営レポート(役員向け1画面) ============ */
function ReportPage({ data }: { data: DashboardData }) {
  const S = data.summary;
  const st = data.stock;

  const profitDiff = S.cur_profit_full - S.prev_profit_same;
  const marginDiff = round1(S.cur_margin - S.prev_margin_same);
  const stockDiff = st.cur_total - st.prev_same;
  const marginGap = round1(S.target_margin - S.cur_margin);
  const landingMid = Math.round((S.fc_simple + S.fc_seasonal) / 2);

  const salesUp = S.sales_yoy >= 0;
  const marginUp = marginDiff >= 0;
  const stockUp = stockDiff >= 0;

  const trendConfig = useMemo(() => buildTrendConfig(data, "yoy"), [data]);
  const stockConfig = useMemo(() => buildStockConfig(data), [data]);

  return (
    <div className="page active">
      <div className="card">
        <div className="card-head">
          <h2>総評(最新 {monL(data.latest_ym)}度まで)</h2>
        </div>
        <p style={{ fontSize: 15, lineHeight: 1.9, padding: "0 20px 20px" }}>
          売上は前期より{" "}
          <b style={{ color: salesUp ? "var(--pos)" : "var(--neg)" }}>
            {salesUp ? "+" : ""}{S.sales_yoy}%
          </b>
          {salesUp ? "増加" : "減少"}しています({oku(S.cur_sales)})。
          <br />
          粗利率は前期同期より{" "}
          <b style={{ color: marginUp ? "var(--pos)" : "var(--neg)" }}>
            {marginUp ? "+" : ""}{marginDiff}pt
          </b>
          {marginUp ? "改善" : "低下"}しています({S.cur_margin}% ← {S.prev_margin_same}%)。
          <br />
          在庫仕入(拠点90・91)は前期同期より{" "}
          <b style={{ color: stockUp ? "var(--neg)" : "var(--pos)" }}>
            {stockUp ? "+" : ""}{yen(stockDiff)}
          </b>
          {stockUp ? "増加" : "減少"}しています。
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>今期・前期の比較(累計)</h2>
        </div>
        <div className="matwrap">
          <table className="mat">
            <thead>
              <tr>
                <th className="namecol">項目</th>
                <th>今期(累計)</th>
                <th>前期(同期間)</th>
                <th>昨対</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="namecol">売上</td>
                <td><span className="cell-s">{yen(S.cur_sales)}</span></td>
                <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{yen(S.prev_sales_same)}</span></td>
                <td><span className={`cell-s ${salesUp ? "val-pos" : "val-neg"}`}>{salesUp ? "+" : ""}{S.sales_yoy}%</span></td>
              </tr>
              <tr>
                <td className="namecol">粗利額<span style={{ fontSize: 10, color: "var(--ink-faint)" }}>(確定{S.n_full}ヶ月)</span></td>
                <td><span className="cell-s">{yen(S.cur_profit_full)}</span></td>
                <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{yen(S.prev_profit_same)}</span></td>
                <td><span className={`cell-s ${profitDiff >= 0 ? "val-pos" : "val-neg"}`}>{profitDiff >= 0 ? "+" : ""}{yen(profitDiff)}</span></td>
              </tr>
              <tr>
                <td className="namecol">粗利率</td>
                <td><span className="cell-s">{S.cur_margin}%</span></td>
                <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{S.prev_margin_same}%</span></td>
                <td><span className={`cell-s ${marginUp ? "val-pos" : "val-neg"}`}>{marginUp ? "+" : ""}{marginDiff}pt</span></td>
              </tr>
              <tr>
                <td className="namecol">在庫仕入(90・91)</td>
                <td><span className="cell-s">{yen(st.cur_total)}</span></td>
                <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{yen(st.prev_same)}</span></td>
                <td><span className={`cell-s ${stockUp ? "val-neg" : "val-pos"}`}>{stockUp ? "+" : ""}{yen(stockDiff)}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>期末(9月度)までの見込み</h2>
        </div>
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(2,1fr)" }}>
          <KpiCard
            label="売上 着地見込み"
            value={`${oku(landingMid)}円`}
            foot={`慎重${oku(Math.min(S.fc_simple, S.fc_seasonal))}〜楽観${oku(Math.max(S.fc_simple, S.fc_seasonal))}`}
            primary
          />
          <KpiCard
            label="粗利率 目標との差"
            value={`${marginGap >= 0 ? "-" : "+"}${Math.abs(marginGap).toFixed(1)}pt`}
            foot={`目標${S.target_margin}%(前期${S.prev_margin}%+3pt)`}
            status={marginGap <= 0 ? "hit" : "miss"}
            badge={marginGap <= 0 ? "✓ 目標達成ペース" : `目標まであと${marginGap.toFixed(1)}pt`}
          />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>月別推移:売上(今期 vs 前期)</h2>
        </div>
        <div className="legend">
          <span><i className="dot" style={{ background: "#2563d9" }} />今期 売上</span>
          <span><i className="dot" style={{ background: "#9aa3b2" }} />前期 売上</span>
        </div>
        <div className="chart-box">
          <TrendChart config={trendConfig} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>月別推移:在庫仕入(今期 vs 前期)</h2>
        </div>
        <div className="legend">
          <span><i className="dot" style={{ background: "#e08a1e" }} />今期 在庫仕入</span>
          <span><i className="dot" style={{ background: "#9aa3b2" }} />前期 在庫仕入</span>
        </div>
        <div className="chart-box">
          <TrendChart config={stockConfig} />
        </div>
      </div>

      <p style={{ fontSize: 11, color: "var(--ink-faint)", padding: "0 20px 16px" }}>
        詳しい拠点別・担当者別の内訳は「月別マトリクス」タブ、個別の目標達成状況は「目標追跡」タブ、在庫仕入の商品別・仕入先別の内訳は「在庫」タブでご覧いただけます。
      </p>
    </div>
  );
}

/* ============ 全体サマリー ============ */
function OverviewPage({ data }: { data: DashboardData }) {
  const S = data.summary;
  const [ovMode, setOvMode] = useState<OvMode>("cur");

  const kpis = useMemo(() => {
    if (ovMode === "cur") {
      const hit = S.cur_margin >= S.target_margin;
      return [
        { label: "今期 売上累計", value: yen(S.cur_sales), foot: `${S.n_sales}ヶ月・昨対${S.sales_yoy >= 0 ? "+" : ""}${S.sales_yoy}%`, primary: true },
        { label: "今期 利益累計", value: yen(S.cur_profit_full), foot: `仕入確定${S.n_full}ヶ月ぶん` },
        {
          label: "粗利率",
          value: `${S.cur_margin}%`,
          foot: `目標${S.target_margin}%`,
          status: hit ? ("hit" as const) : ("miss" as const),
          badge: hit ? "✓ 目標達成" : `目標まで${(S.target_margin - S.cur_margin).toFixed(1)}pt`,
        },
        {
          label: "売上 着地見込み",
          value: `${oku((S.fc_simple + S.fc_seasonal) / 2)}円`,
          foot: `慎重${oku(Math.min(S.fc_simple, S.fc_seasonal))}〜楽観${oku(Math.max(S.fc_simple, S.fc_seasonal))}`,
        },
      ];
    }
    if (ovMode === "prev") {
      return [
        { label: "前期 売上(通期)", value: yen(S.prev_sales_total), foot: "2024年10月〜2025年9月", primary: true },
        { label: "前期 利益(通期)", value: yen(S.prev_profit_total), foot: "12ヶ月" },
        { label: "前期 粗利率", value: `${S.prev_margin}%`, foot: "通期" },
        { label: "前期 月平均売上", value: yen(S.prev_sales_total / 12), foot: "12ヶ月平均" },
      ];
    }
    const mgd = round1(S.cur_margin - S.prev_margin_same);
    const hit = mgd >= 3;
    return [
      { label: "売上 昨対", value: `${S.sales_yoy >= 0 ? "+" : ""}${S.sales_yoy}%`, foot: `今期${oku(S.cur_sales)}/前期${oku(S.prev_sales_same)}`, primary: true },
      { label: "今期 粗利率", value: `${S.cur_margin}%`, foot: `前期同期 ${S.prev_margin_same}%` },
      {
        label: "粗利率 昨対",
        value: `${mgd >= 0 ? "+" : ""}${mgd}pt`,
        foot: "前期同期比",
        status: hit ? ("hit" as const) : ("miss" as const),
        badge: hit ? "✓ +3pt達成" : `+3ptまであと${(3 - mgd).toFixed(1)}pt`,
      },
      { label: "前期同期 売上", value: yen(S.prev_sales_same), foot: `今期と同じ${S.n_sales}ヶ月ぶん` },
    ];
  }, [ovMode, S]);

  const chartConfig = useMemo(() => buildTrendConfig(data, ovMode), [data, ovMode]);

  return (
    <div className="page active">
      <div className="card-head" style={{ padding: "0 0 12px" }}>
        <div className="tabs">
          <button className={ovMode === "cur" ? "active" : ""} onClick={() => setOvMode("cur")}>今期</button>
          <button className={ovMode === "prev" ? "active" : ""} onClick={() => setOvMode("prev")}>前期</button>
          <button className={ovMode === "yoy" ? "active" : ""} onClick={() => setOvMode("yoy")}>昨対</button>
        </div>
      </div>
      <div className="kpi-grid">
        {kpis.map((k, i) => (
          <KpiCard key={i} {...k} />
        ))}
      </div>
      <div className="card">
        <div className="card-head">
          <h2>売上・仕入・利益の月別推移</h2>
        </div>
        <div className="legend">
          {ovMode === "yoy" ? (
            <>
              <span><i className="dot" style={{ background: "#2563d9" }} />今期 売上</span>
              <span><i className="dot" style={{ background: "#9aa3b2" }} />前期 売上</span>
            </>
          ) : (
            <>
              <span><i className="dot" style={{ background: "#2563d9" }} />売上</span>
              <span><i className="dot" style={{ background: "#c3d6f8" }} />仕入</span>
              <span><i className="dot" style={{ background: "#0f9d58" }} />利益</span>
            </>
          )}
        </div>
        <div className="chart-box">
          <TrendChart config={chartConfig} />
        </div>
      </div>

      <h2 className="blk">在庫仕入(拠点90・91)</h2>
      <StockSection data={data} />
    </div>
  );
}

function StockSection({ data }: { data: DashboardData }) {
  const st = data.stock;
  const up = st.yoy_pct != null && st.yoy_pct > 0;
  const chartConfig = useMemo(() => buildStockConfig(data), [data]);
  return (
    <>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        <KpiCard label="今期 在庫仕入(累計)" value={yen(st.cur_total)} foot={`${st.n_cur}ヶ月ぶん`} primary />
        <KpiCard label="前期 同期間" value={yen(st.prev_same)} foot={`前期の同じ${st.n_cur}ヶ月`} />
        <KpiCard
          label="昨対(在庫仕入)"
          value={st.yoy_pct != null ? `${st.yoy_pct >= 0 ? "+" : ""}${st.yoy_pct}%` : "―"}
          foot={up ? "前期より増加(要注意)" : "前期より圧縮"}
          status={up ? "miss" : "hit"}
          badge={up ? "△ 増えています" : "✓ 減っています"}
        />
      </div>
      <div className="card">
        <div className="card-head">
          <h2>在庫仕入の月別推移(今期 vs 前期)</h2>
        </div>
        <div className="legend">
          <span><i className="dot" style={{ background: "#e08a1e" }} />今期 在庫仕入</span>
          <span><i className="dot" style={{ background: "#9aa3b2" }} />前期 在庫仕入</span>
        </div>
        <div className="chart-box">
          <TrendChart config={chartConfig} />
        </div>
      </div>
      <p style={{ fontSize: 11, color: "var(--ink-faint)", padding: "8px 20px 0" }}>
        商品別・仕入先別の詳しい内訳は「在庫」タブでご覧いただけます。
      </p>
    </>
  );
}

/* ============ 在庫 ============ */
function StockPage({
  stockDetail,
  stockMovement,
  stockMovementError,
}: {
  stockDetail: StockDetailData;
  stockMovement: StockMovementData | null;
  stockMovementError: string | null;
}) {
  const sd = stockDetail;
  const up = sd.yoy_pct_same != null && sd.yoy_pct_same > 0;
  const chartConfig = useMemo(() => buildStockDetailConfig(sd), [sd]);

  const monthlyRows = sd.monthly.map((m) => ({ ...m, diff: m.cur - m.prev }));

  return (
    <div className="page active">
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        <KpiCard
          label="今期 在庫仕入(累計)"
          value={yen(sd.cur_total)}
          foot={`${sd.n_cur_months}ヶ月ぶん・拠点90/91`}
          primary
        />
        <KpiCard label="前期 同期間" value={yen(sd.prev_same)} foot={`前期の同じ${sd.n_cur_months}ヶ月`} />
        <KpiCard
          label="昨対(在庫仕入)"
          value={sd.yoy_pct_same != null ? `${sd.yoy_pct_same >= 0 ? "+" : ""}${sd.yoy_pct_same}%` : "―"}
          foot={up ? "前期より増加(要注意)" : "前期より圧縮"}
          status={up ? "miss" : "hit"}
          badge={up ? "△ 増えています" : "✓ 減っています"}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>月別推移(今期 vs 前期)</h2>
        </div>
        <div className="legend">
          <span><i className="dot" style={{ background: "#e08a1e" }} />今期 在庫仕入</span>
          <span><i className="dot" style={{ background: "#9aa3b2" }} />前期 在庫仕入</span>
        </div>
        <div className="chart-box">
          <TrendChart config={chartConfig} />
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>月別の内訳</h2>
        </div>
        <div className="matwrap">
          <table className="mat">
            <thead>
              <tr>
                <th className="namecol">月度</th>
                <th>前期</th>
                <th>今期</th>
                <th>増減</th>
              </tr>
            </thead>
            <tbody>
              {monthlyRows.map((m) => {
                const hasAny = m.cur !== 0 || m.prev !== 0;
                return (
                  <tr key={m.ym}>
                    <td className="namecol">{monL(m.ym)}</td>
                    <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{yen(m.prev)}</span></td>
                    <td><span className="cell-s">{yen(m.cur)}</span></td>
                    <td>
                      {hasAny ? (
                        <span className={`cell-s ${m.diff >= 0 ? "val-neg" : "val-pos"}`}>
                          {m.diff >= 0 ? "+" : ""}{yen(m.diff)}
                        </span>
                      ) : (
                        <span className="cell-s" style={{ color: "#c8ccd4" }}>―</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="mat-foot">
              <tr>
                <td className="namecol">合計</td>
                <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{yen(sd.prev_total)}</span></td>
                <td><span className="cell-s">{yen(sd.cur_total)}</span></td>
                <td>
                  <span className={`cell-s ${sd.diff_same >= 0 ? "val-neg" : "val-pos"}`}>
                    {sd.diff_same >= 0 ? "+" : ""}{yen(sd.diff_same)}(前期同期間比)
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <p style={{ fontSize: 11, color: "var(--ink-faint)", padding: "8px 20px 16px" }}>
          「前期」列は参考として全月表示していますが、表の一番下の増減(前期同期間比)は、今期データがある月度分だけで比較しています。
        </p>
      </div>

      <SupplierTable title={`仕入先別 内訳(今期・上位${Math.min(15, sd.suppliers.length)}件)`} rows={sd.suppliers.slice(0, 15)} />
      <ProductTable title={`商品別 内訳(今期・上位${Math.min(15, sd.products.length)}件)`} rows={sd.products.slice(0, 15)} />

      <h2 className="blk">不動在庫チェック(rieki-check連携)</h2>
      <StockMovementSection stockMovement={stockMovement} stockMovementError={stockMovementError} />

      <p style={{ fontSize: 11, color: "var(--ink-faint)", padding: "0 20px 16px" }}>
        このタブの「今期の在庫仕入額」は今期・前期の比較を表示しています。「不動在庫チェック」は、仕入(sales-dashboard)と出荷実績(rieki-check)を商品ごとに突き合わせて、現在も残っていると推定される在庫と、その在庫期間を計算しています。在庫商品ごとの詳しい売上推移(伸びている/落ちている等)は、今後の課題として残っています。
      </p>
    </div>
  );
}

function StockMovementSection({
  stockMovement,
  stockMovementError,
}: {
  stockMovement: StockMovementData | null;
  stockMovementError: string | null;
}) {
  if (stockMovementError) {
    return (
      <div className="card">
        <div className="card-head">
          <h2>不動在庫チェック</h2>
        </div>
        <p style={{ fontSize: 13, color: "var(--ink-faint)", padding: "0 20px 20px", lineHeight: 1.8 }}>
          rieki-checkとの連携が設定されていないため、この機能はまだ利用できません。
          <br />
          (詳細: {stockMovementError})
        </p>
      </div>
    );
  }

  if (!stockMovement) {
    return (
      <div className="card">
        <div className="card-head">
          <h2>不動在庫チェック</h2>
        </div>
        <p style={{ fontSize: 13, color: "var(--ink-faint)", padding: "0 20px 20px" }}>データがありません。</p>
      </div>
    );
  }

  const sm = stockMovement;
  const deadItems = sm.items.filter((i) => i.isDead);
  const showItems = deadItems.slice(0, 50);

  return (
    <>
      <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(3,1fr)" }}>
        <KpiCard
          label="不動在庫候補(金額)"
          value={yen(sm.deadAmount)}
          foot={`最終出荷から${sm.deadThresholdDays}日以上動きなし`}
          status={sm.deadCount > 0 ? "miss" : "hit"}
          badge={sm.deadCount > 0 ? `${sm.deadCount}商品` : "✓ 該当なし"}
          primary
        />
        <KpiCard label="在庫のある商品数" value={`${sm.totalItemsWithStock}商品`} foot={`基準日 ${sm.asOf}`} />
        <KpiCard
          label="不動在庫の割合"
          value={sm.totalItemsWithStock ? `${Math.round((sm.deadCount / sm.totalItemsWithStock) * 1000) / 10}%` : "―"}
          foot="在庫のある商品数に対する割合"
        />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>不動在庫候補 一覧(金額の多い順・上位{Math.min(50, deadItems.length)}件)</h2>
        </div>
        <div className="matwrap">
          <table className="mat">
            <thead>
              <tr>
                <th className="namecol">商品名</th>
                <th>在庫数量(推定)</th>
                <th>在庫金額(推定)</th>
                <th>最古の仕入日</th>
                <th>在庫期間</th>
                <th>最終出荷日</th>
                <th>最終出荷からの経過</th>
              </tr>
            </thead>
            <tbody>
              {showItems.length === 0 ? (
                <tr>
                  <td className="namecol" colSpan={7} style={{ color: "var(--ink-faint)" }}>
                    不動在庫候補はありませんでした。
                  </td>
                </tr>
              ) : (
                showItems.map((i) => <StockMovementRow key={i.key} item={i} />)
              )}
            </tbody>
          </table>
        </div>
        {deadItems.length > 50 && (
          <p style={{ fontSize: 11, color: "var(--ink-faint)", padding: "8px 20px 16px" }}>
            不動在庫候補は他に{deadItems.length - 50}件あります(表示は金額上位50件のみ)。
          </p>
        )}
      </div>

      {sm.unmatchedShipmentQty > 0 && (
        <p style={{ fontSize: 11, color: "var(--ink-faint)", padding: "0 20px 16px" }}>
          参考: 手元の仕入データより前に仕入れたと思われ、対応する仕入ロットが見つからなかった出荷数量が
          約{jpn(sm.unmatchedShipmentQty)}個分あります(在庫期間の計算には含まれていません)。
        </p>
      )}
    </>
  );
}

function StockMovementRow({ item }: { item: StockMovementItem }) {
  return (
    <tr>
      <td className="namecol">{item.name}</td>
      <td><span className="cell-s">{jpn(item.qtyOnHand)}</span></td>
      <td><span className="cell-s">{yen(item.amountOnHand)}</span></td>
      <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{item.oldestLotDate}</span></td>
      <td><span className="cell-s val-neg">{jpn(item.ageDays)}日</span></td>
      <td>
        <span className="cell-s" style={{ color: "#9aa3b2" }}>
          {item.lastShipmentDate ?? "出荷実績なし"}
        </span>
      </td>
      <td>
        <span className="cell-s val-neg">
          {item.daysSinceShipment != null ? `${jpn(item.daysSinceShipment)}日` : "―"}
        </span>
      </td>
    </tr>
  );
}

function SupplierTable({ title, rows }: { title: string; rows: StockSupplierRow[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
      </div>
      <div className="matwrap">
        <table className="mat">
          <thead>
            <tr>
              <th className="namecol">仕入先名</th>
              <th>前期</th>
              <th>今期</th>
              <th>増減</th>
              <th className="namecol">一番多い商品</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="namecol" colSpan={5} style={{ color: "var(--ink-faint)" }}>
                  データがありません。
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isOpen = openKey === r.key;
                const mainRow = (
                  <tr
                    key={r.key}
                    onClick={() => setOpenKey(isOpen ? null : r.key)}
                    style={{ cursor: "pointer", background: isOpen ? "#f5f7fb" : undefined }}
                    title="クリックでこの仕入先の商品一覧を表示"
                  >
                    <td className="namecol">
                      <span style={{ color: "#2563d9" }}>{isOpen ? "▾ " : "▸ "}</span>
                      {r.name}
                    </td>
                    <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{yen(r.prev)}</span></td>
                    <td><span className="cell-s">{yen(r.cur)}</span></td>
                    <td>
                      <span className={`cell-s ${r.diff >= 0 ? "val-neg" : "val-pos"}`}>
                        {r.diff >= 0 ? "+" : ""}{yen(r.diff)}
                      </span>
                    </td>
                    <td className="namecol">{r.topProductName ?? "―"}</td>
                  </tr>
                );
                if (!isOpen) return mainRow;
                const detailRow = (
                  <tr key={`${r.key}-detail`}>
                    <td colSpan={5} style={{ padding: 0, background: "#fafbfc" }}>
                      <div style={{ padding: "10px 20px 16px 40px" }}>
                        <div style={{ fontSize: 12, color: "var(--ink-faint)", marginBottom: 6 }}>
                          {r.name} の商品一覧(今期金額の多い順・{r.products.length}件)
                        </div>
                        <table className="mat" style={{ width: "100%" }}>
                          <thead>
                            <tr>
                              <th className="namecol">商品名</th>
                              <th>前期</th>
                              <th>今期</th>
                              <th>増減</th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.products.map((p) => (
                              <tr key={p.key}>
                                <td className="namecol">{p.name}</td>
                                <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{yen(p.prev)}</span></td>
                                <td><span className="cell-s">{yen(p.cur)}</span></td>
                                <td>
                                  <span className={`cell-s ${p.diff >= 0 ? "val-neg" : "val-pos"}`}>
                                    {p.diff >= 0 ? "+" : ""}{yen(p.diff)}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                );
                return [mainRow, detailRow];
              })
            )}
          </tbody>
        </table>
      </div>
      <p style={{ fontSize: 11, color: "var(--ink-faint)", padding: "8px 20px 16px" }}>
        仕入先名をクリックすると、その仕入先から仕入れている商品の一覧を表示します。
      </p>
    </div>
  );
}

function ProductTable({ title, rows }: { title: string; rows: StockProductRow[] }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
      </div>
      <div className="matwrap">
        <table className="mat">
          <thead>
            <tr>
              <th className="namecol">商品名</th>
              <th>前期</th>
              <th>今期</th>
              <th>増減</th>
              <th className="namecol">主な仕入先</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="namecol" colSpan={5} style={{ color: "var(--ink-faint)" }}>
                  データがありません。
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.key}>
                  <td className="namecol">{r.name}</td>
                  <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{yen(r.prev)}</span></td>
                  <td><span className="cell-s">{yen(r.cur)}</span></td>
                  <td>
                    <span className={`cell-s ${r.diff >= 0 ? "val-neg" : "val-pos"}`}>
                      {r.diff >= 0 ? "+" : ""}{yen(r.diff)}
                    </span>
                  </td>
                  <td className="namecol">{r.topSupplierName ?? "―"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ============ 月別マトリクス ============ */
function MatrixPage({ data }: { data: DashboardData }) {
  const [dim, setDim] = useState<Dim>("loc");
  const [metric, setMetric] = useState<Metric>("sales");
  const [sortKey, setSortKey] = useState<"code" | "name" | "cur_ts">("cur_ts");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [filter, setFilter] = useState("");

  const rowsAll = dim === "loc" ? data.mat_loc : dim === "staff" ? data.mat_staff : data.mat_cust;

  const rows = useMemo(() => {
    let r = rowsAll;
    if (filter) {
      const f = filter.toLowerCase();
      r = r.filter((row) => (row.name + row.code).toLowerCase().includes(f));
    }
    r = [...r].sort((a, b) => {
      if (sortKey === "code") return sortDir === "asc" ? Number(a.code) - Number(b.code) : Number(b.code) - Number(a.code);
      if (sortKey === "name") return sortDir === "asc" ? a.name.localeCompare(b.name, "ja") : b.name.localeCompare(a.name, "ja");
      return sortDir === "asc" ? a.cur_ts - b.cur_ts : b.cur_ts - a.cur_ts;
    });
    return r;
  }, [rowsAll, filter, sortKey, sortDir]);

  function onSort(k: "code" | "name" | "cur_ts") {
    if (k === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir(k === "code" || k === "name" ? "asc" : "desc");
    }
  }

  const months = data.cur_months;

  const colS = new Array(months.length).fill(0);
  const colPS = new Array(months.length).fill(0);
  const colP = new Array(months.length).fill(0);
  const colPP = new Array(months.length).fill(0);
  rows.forEach((r) => {
    r.cur.forEach((c, i) => {
      colS[i] += c.s;
      colP[i] += c.p;
    });
    r.prev.forEach((c, i) => {
      colPS[i] += c.s;
      colPP[i] += c.p;
    });
  });
  const gS = rows.reduce((a, r) => a + r.cur_ts, 0);
  const gPS = rows.reduce((a, r) => a + r.prev_ts, 0);
  const gP = rows.reduce((a, r) => a + r.cur_tp, 0);
    const gPP = rows.reduce((a, r) => a + r.prev_tp, 0);
  const gPS_same = rows.reduce((a, r) => a + r.prev_ts_same, 0);
  const gPP_same = rows.reduce((a, r) => a + r.prev_tp_same, 0);

  return (
    <div className="page active">
      <div className="card">
        <div className="card-head">
          <div className="tabs">
            {(["loc", "staff", "cust"] as Dim[]).map((d) => (
              <button
                key={d}
                className={dim === d ? "active" : ""}
                onClick={() => {
                  setDim(d);
                  setFilter("");
                }}
              >
                {dimName[d]}別
              </button>
            ))}
          </div>
          {dim === "cust" && (
            <input
              type="text"
              className="search"
              placeholder="名前・コードで検索"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
        </div>
        <div className="card-head" style={{ paddingTop: 0 }}>
          <div className="tabs">
            {(
              [
                ["sales", "売上金額"],
                ["purchase", "仕入額"],
                ["profit", "粗利額"],
                ["prevprofit", "前期粗利額"],
                ["profitdiff", "粗利 昨対差額"],
                ["yoyamt", "昨対金額"],
                ["yoydiff", "昨対差額"],
                ["yoypct", "前年比(%)"],
                ["margin", "粗利率"],
              ] as [Metric, string][]
            ).map(([m, label]) => (
              <button key={m} className={metric === m ? "active" : ""} onClick={() => setMetric(m)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="matwrap">
          <table className="mat">
            <thead>
              <tr>
                <th className="codecol" onClick={() => onSort("code")}>コード</th>
                <th className="namecol" onClick={() => onSort("name")}>{dimName[dim]}</th>
                {months.map((m) => (
                  <th key={m}>{monL(m)}</th>
                ))}
                <th className="totcol" onClick={() => onSort("cur_ts")}>トータル</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code}>
                  <td className="codecol">{r.code}</td>
                  <td className="namecol">{r.name}</td>
                  {r.cur.map((c, i) => (
                    <MatrixCell key={i} metric={metric} cur={c} prevS={r.prev[i]?.s ?? 0} prevP={r.prev[i]?.p ?? 0} />
                  ))}
                  <MatrixTotalCell metric={metric} row={r} />
                </tr>
              ))}
            </tbody>
            <tfoot className="mat-foot">
              <tr>
                <td className="codecol" />
                <td className="namecol">合計</td>
                {months.map((_m, i) => (
                  <MatrixCell key={i} metric={metric} cur={{ s: colS[i], p: colP[i], m: colS[i] ? round1(((colS[i] - colP[i]) / colS[i]) * 100) : null }} prevS={colPS[i]} prevP={colPP[i]} />
                ))}
                <MatrixTotalCell
                  metric={metric}
                  row={{
                    code: "",
                    name: "",
                    cur: [],
                    prev: [],
                    cur_ts: gS,
                    cur_tp: gP,
                    cur_tm: gS ? round1(((gS - gP) / gS) * 100) : null,
                    prev_ts: gPS,
                    prev_tp: gPP,
                    prev_ts_same: gPS_same,
                    prev_tp_same: gPP_same,
                    prev_tm: null,
                    target: null,
                  }}
                />
              </tr>
            </tfoot>
          </table>
        </div>
        <p style={{ fontSize: 11, color: "var(--ink-faint)", padding: "8px 20px 16px" }}>
          {dim === "cust"
            ? `得意先は売上上位100件(全${data.cust_total_count.toLocaleString()}件)。検索で絞込。`
            : "9つのボタンで表示を切替。粗利率は10%以上=緑/未満=赤。"}
        </p>
      </div>
    </div>
  );
}

function MatrixCell({
  metric,
  cur,
  prevS,
  prevP,
}: {
  metric: Metric;
  cur: { s: number; p: number; m: number | null };
  prevS: number;
  prevP: number;
}) {
  const s = cur.s;
  if (s === 0 && (metric === "profitdiff" || metric === "yoyamt" || metric === "yoydiff" || metric === "yoypct")) {
    return <td><span className="cell-s" style={{ color: "#c8ccd4" }}>―</span></td>;
  }
  if (metric === "sales") {
    if (s === 0) {
      if (cur.p && cur.p > 0) {
        return (
          <td>
            <span className="cell-s" style={{ color: "#c8ccd4" }}>0</span>
            <span className="cell-m" style={{ color: "#e08a1e" }}>仕{jpn(cur.p)}</span>
          </td>
        );
      }
      return <td><span className="cell-s" style={{ color: "#c8ccd4" }}>0</span></td>;
    }
    return <td><span className="cell-s">{jpn(s)}</span></td>;
  }
  if (metric === "purchase") {
    return <td><span className="cell-s">{jpn(cur.p)}</span></td>;
  }
  if (metric === "profit") {
    const profit = s - cur.p;
    return <td><span className={`cell-s ${profit >= 0 ? "val-pos" : "val-neg"}`}>{profit >= 0 ? "+" : ""}{jpn(profit)}</span></td>;
  }
  if (metric === "prevprofit") {
    const prevProfit = prevS - prevP;
    return <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{jpn(prevProfit)}</span></td>;
  }
  if (metric === "profitdiff") {
    const curProfit = s - cur.p;
    const prevProfit = prevS - prevP;
    const d = curProfit - prevProfit;
    return <td><span className={`cell-s ${d >= 0 ? "val-pos" : "val-neg"}`}>{d >= 0 ? "+" : ""}{jpn(d)}</span></td>;
  }
  if (metric === "yoyamt") return <td><span className="cell-s" style={{ color: "#9aa3b2" }}>{jpn(prevS)}</span></td>;
  if (metric === "yoydiff") {
    const d = s - prevS;
    return <td><span className={`cell-s ${d >= 0 ? "val-pos" : "val-neg"}`}>{d >= 0 ? "+" : ""}{jpn(d)}</span></td>;
  }
  if (metric === "yoypct") {
    if (!prevS) return <td><span className="cell-s" style={{ color: "#c8ccd4" }}>―</span></td>;
    const p = (s / prevS) * 100;
    return <td><span className={`cell-s ${p >= 100 ? "val-pos" : "val-neg"}`}>{p.toFixed(0)}%</span></td>;
  }
  if (cur.m == null) return <td><span className="cell-s" style={{ color: "#c8ccd4" }}>―</span></td>;
  const good = cur.m >= 10;
  return (
    <td className={good ? "cell-good" : "cell-bad"}>
      <span className={`cell-s ${good ? "m-good" : "m-bad"}`}>{cur.m.toFixed(1)}%</span>
    </td>
  );
}

function TwoTierCell({ top, bottom }: { top: React.ReactNode; bottom: React.ReactNode }) {
  return (
    <td className="totcol">
      <div>{top}</div>
      <div style={{ fontSize: 10, color: "#9aa3b2", marginTop: 2 }}>{bottom}</div>
    </td>
  );
}

function MatrixTotalCell({ metric, row }: { metric: Metric; row: MatrixRow }) {
  if (metric === "sales") return <td className="totcol"><span className="cell-s">{jpn(row.cur_ts)}</span></td>;
  if (metric === "purchase") return <td className="totcol"><span className="cell-s">{jpn(row.cur_tp)}</span></td>;
  if (metric === "profit") {
    const profit = row.cur_ts - row.cur_tp;
    return <td className="totcol"><span className={`cell-s ${profit >= 0 ? "val-pos" : "val-neg"}`}>{profit >= 0 ? "+" : ""}{jpn(profit)}</span></td>;
  }
  if (metric === "prevprofit") {
    const prevProfit = row.prev_ts - row.prev_tp;
    return <td className="totcol"><span className="cell-s" style={{ color: "#9aa3b2" }}>{jpn(prevProfit)}</span></td>;
  }
  if (metric === "profitdiff") {
    const curProfit = row.cur_ts - row.cur_tp;
    const sameProfit = row.prev_ts_same - row.prev_tp_same;
    const fullProfit = row.prev_ts - row.prev_tp;
    const dSame = curProfit - sameProfit;
    const dFull = curProfit - fullProfit;
    return (
      <TwoTierCell
        top={<span className={`cell-s ${dSame >= 0 ? "val-pos" : "val-neg"}`}>{dSame >= 0 ? "+" : ""}{jpn(dSame)}</span>}
        bottom={<>{dFull >= 0 ? "+" : ""}{jpn(dFull)}(通年)</>}
      />
    );
  }
  if (metric === "yoyamt") {
    return (
      <TwoTierCell
        top={<span className="cell-s" style={{ color: "#9aa3b2" }}>{jpn(row.prev_ts_same)}</span>}
        bottom={<>{jpn(row.prev_ts)}(通年)</>}
      />
    );
  }
  if (metric === "yoydiff") {
    const dSame = row.cur_ts - row.prev_ts_same;
    const dFull = row.cur_ts - row.prev_ts;
    return (
      <TwoTierCell
        top={<span className={`cell-s ${dSame >= 0 ? "val-pos" : "val-neg"}`}>{dSame >= 0 ? "+" : ""}{jpn(dSame)}</span>}
        bottom={<>{dFull >= 0 ? "+" : ""}{jpn(dFull)}(通年)</>}
      />
    );
  }
  if (metric === "yoypct") {
    const pSame = row.prev_ts_same ? (row.cur_ts / row.prev_ts_same) * 100 : null;
    const pFull = row.prev_ts ? (row.cur_ts / row.prev_ts) * 100 : null;
    return (
      <TwoTierCell
        top={pSame == null ? "―" : <span className={`cell-s ${pSame >= 100 ? "val-pos" : "val-neg"}`}>{pSame.toFixed(0)}%</span>}
        bottom={pFull == null ? <>―(通年)</> : <>{pFull.toFixed(0)}%(通年)</>}
      />
    );
  }
  if (row.cur_tm == null) return <td className="totcol">―</td>;
  const good = row.cur_tm >= 10;
  return <td className="totcol"><span className={`cell-s ${good ? "m-good" : "m-bad"}`}>{row.cur_tm.toFixed(1)}%</span></td>;
}
/* ============ 目標追跡 ============ */
function GoalPage({ data }: { data: DashboardData }) {
  const S = data.summary;
  const [dim, setDim] = useState<Dim>("loc");
  const [sortKey, setSortKey] = useState<"code" | "name" | "cur_ts" | "diff">("diff");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const rowsAll = dim === "loc" ? data.mat_loc : dim === "staff" ? data.mat_staff : data.mat_cust;

  const rows = useMemo(() => {
    const filtered = rowsAll
      .filter((r) => r.cur_tm != null && r.target != null)
      .map((r) => ({ ...r, diff: round1((r.cur_tm as number) - (r.target as number)) }));
    filtered.sort((a, b) => {
      if (sortKey === "code") return sortDir === "asc" ? Number(a.code) - Number(b.code) : Number(b.code) - Number(a.code);
      if (sortKey === "name") return sortDir === "asc" ? a.name.localeCompare(b.name, "ja") : b.name.localeCompare(a.name, "ja");
      if (sortKey === "cur_ts") return sortDir === "asc" ? a.cur_ts - b.cur_ts : b.cur_ts - a.cur_ts;
      return sortDir === "asc" ? a.diff - b.diff : b.diff - a.diff;
    });
    return filtered;
  }, [rowsAll, sortKey, sortDir]);

  function onSort(k: "code" | "name" | "cur_ts" | "diff") {
    if (k === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(k);
      setSortDir("asc");
    }
  }

  const hit = S.cur_margin >= S.target_margin;
  const gap = round1(S.target_margin - S.cur_margin);
  const nHit = rows.filter((r) => r.diff >= 0).length;

  return (
    <div className="page active">
      <div className="kpi-grid">
        <KpiCard label="全社 今期粗利率" value={`${S.cur_margin}%`} foot={`${S.n_full}ヶ月累計`} />
        <KpiCard label="全社 目標粗利率" value={`${S.target_margin}%`} foot={`前期${S.prev_margin}% +3pt`} primary />
        <KpiCard
          label="目標との差"
          value={`${gap >= 0 ? "-" : "+"}${Math.abs(gap).toFixed(1)}pt`}
          foot={hit ? "✓ 達成" : `あと${gap.toFixed(1)}pt`}
          status={hit ? "hit" : "miss"}
          badge={hit ? "✓ 達成" : "未達"}
        />
        <KpiCard
          label="昨対(粗利率)"
          value={`${S.cur_margin - S.prev_margin_same >= 0 ? "+" : ""}${round1(S.cur_margin - S.prev_margin_same)}pt`}
          foot={`前期同期 ${S.prev_margin_same}%`}
        />
      </div>
      <div className="card">
        <div className="card-head">
          <div className="tabs">
            {(["loc", "staff", "cust"] as Dim[]).map((d) => (
              <button key={d} className={dim === d ? "active" : ""} onClick={() => setDim(d)}>
                {dimName[d]}別
              </button>
            ))}
          </div>
          <span className="sub">個別目標=各自の前期粗利率 ＋3pt</span>
        </div>
        <div className="matwrap">
          <table className="goaltable">
            <thead>
              <tr>
                <th onClick={() => onSort("code")}>コード</th>
                <th onClick={() => onSort("name")}>{dimName[dim]}</th>
                <th onClick={() => onSort("cur_ts")}>今期売上</th>
                <th>前期粗利率</th>
                <th>目標(+3pt)</th>
                <th>今期粗利率</th>
                <th onClick={() => onSort("diff")}>達成状況</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const hitRow = r.diff >= 0;
                return (
                  <tr key={r.code}>
                    <td className="codecol" style={{ color: "#9aa3b2", fontSize: 11 }}>{r.code}</td>
                    <td>{r.name}</td>
                    <td>{yen(r.cur_ts)}</td>
                    <td>{r.prev_tm}%</td>
                    <td>{r.target}%</td>
                    <td style={{ fontWeight: 700, color: hitRow ? "var(--pos)" : "var(--neg)" }}>{r.cur_tm}%</td>
                    <td>
                      {hitRow ? (
                        <span className="status st-hit">✓ 達成 +{r.diff.toFixed(1)}pt</span>
                      ) : (
                        <span className="status st-miss">未達 {r.diff.toFixed(1)}pt</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 11, color: "var(--ink-faint)", padding: "8px 20px 16px" }}>
          {dimName[dim]} {rows.length}件中 {nHit}件が個別目標を達成。未達は赤で表示(達成状況の列で並び替え可)。
        </p>
      </div>
    </div>
  );
}

/* ============ 共通パーツ ============ */
function KpiCard({
  label,
  value,
  foot,
  primary,
  status,
  badge,
}: {
  label: string;
  value: string;
  foot: string;
  primary?: boolean;
  status?: "hit" | "miss";
  badge?: string;
}) {
  return (
    <div className={`kpi ${primary ? "primary" : ""} ${status ?? ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {badge && <div className={`badge ${status === "hit" ? "b-hit" : "b-miss"}`}>{badge}</div>}
      <div className="foot">{foot}</div>
    </div>
  );
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

/* ============ グラフ設定 ============ */
function buildTrendConfig(data: DashboardData, mode: OvMode) {
  if (mode === "yoy") {
    const labels = data.prev_months.map(monL);
    const curSales = data.prev_months.map((_, i) => (data.trend_cur[i] ? data.trend_cur[i].sales : null));
    const prevSales = data.trend_prev.map((x) => x.sales);
    return {
      type: "bar" as const,
      data: {
        labels,
        datasets: [
          { type: "bar" as const, label: "今期 売上", data: curSales, backgroundColor: "#2563d9", borderRadius: 5, barPercentage: 0.7, categoryPercentage: 0.75, order: 2 },
          { type: "line" as const, label: "前期 売上", data: prevSales, borderColor: "#9aa3b2", borderDash: [5, 4], borderWidth: 2, tension: 0.3, pointRadius: 0, order: 1 },
        ],
      },
      options: baseChartOptions(),
    };
  }
  const src = mode === "cur" ? data.trend_cur : data.trend_prev;
  return {
    type: "bar" as const,
    data: {
      labels: src.map((x) => monL(x.ym)),
      datasets: [
        { type: "bar" as const, label: "売上", data: src.map((x) => x.sales), backgroundColor: "#2563d9", borderRadius: 5, barPercentage: 0.62, categoryPercentage: 0.7, order: 2 },
        { type: "bar" as const, label: "仕入", data: src.map((x) => x.pur), backgroundColor: "#c3d6f8", borderRadius: 5, barPercentage: 0.62, categoryPercentage: 0.7, order: 3 },
        { type: "line" as const, label: "利益", data: src.map((x) => x.profit), borderColor: "#0f9d58", borderWidth: 2.5, tension: 0.35, pointRadius: 0, pointHoverRadius: 5, order: 1 },
      ],
    },
    options: baseChartOptions(),
  };
}

function buildStockConfig(data: DashboardData) {
  const st = data.stock;
  return {
    type: "bar" as const,
    data: {
      labels: data.cur_months.map(monL),
      datasets: [
        { type: "bar" as const, label: "今期 在庫仕入", data: st.cur, backgroundColor: "#e6a23c", borderRadius: 5, barPercentage: 0.7, categoryPercentage: 0.75, order: 2 },
        { type: "line" as const, label: "前期 在庫仕入", data: st.prev, borderColor: "#9aa3b2", borderDash: [5, 4], borderWidth: 2, tension: 0.3, pointRadius: 0, order: 1 },
      ],
    },
    options: baseChartOptions((v: number) => "¥" + (v / 1e6).toFixed(0) + "M"),
  };
}

function buildStockDetailConfig(sd: StockDetailData) {
  return {
    type: "bar" as const,
    data: {
      labels: sd.cur_months.map(monL),
      datasets: [
        { type: "bar" as const, label: "今期 在庫仕入", data: sd.monthly.map((m) => m.cur), backgroundColor: "#e6a23c", borderRadius: 5, barPercentage: 0.7, categoryPercentage: 0.75, order: 2 },
        { type: "line" as const, label: "前期 在庫仕入", data: sd.monthly.map((m) => m.prev), borderColor: "#9aa3b2", borderDash: [5, 4], borderWidth: 2, tension: 0.3, pointRadius: 0, order: 1 },
      ],
    },
    options: baseChartOptions((v: number) => "¥" + (v / 1e6).toFixed(0) + "M"),
  };
}

function baseChartOptions(yTickFormat?: (v: number) => string) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index" as const, intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (c: { dataset: { label?: string }; raw: unknown }) =>
            `${c.dataset.label}: ${c.raw == null ? "―" : yen(c.raw as number)}`,
        },
      },
    },
    scales: {
      x: { grid: { display: false }, ticks: { color: "#9aa3b2", font: { size: 11 } } },
      y: {
        grid: { color: "#eef1f5" },
        ticks: {
          color: "#9aa3b2",
          font: { size: 11 },
          callback: (value: number | string) => {
            const v = typeof value === "string" ? parseFloat(value) : value;
            return yTickFormat ? yTickFormat(v) : "¥" + (v / 1e8).toFixed(1) + "億";
          },
        },
      },
    },
  };
}
