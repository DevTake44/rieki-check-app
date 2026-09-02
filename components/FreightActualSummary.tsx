"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { FreightActualSummaryRow } from "@/lib/types";
import { branchLabel } from "@/lib/branch-names";
import { repLabel } from "@/lib/rep-names";

/**
 * 運賃実績集計ダッシュボード
 *
 * 目的: 運賃照合画面(/freight-check)で「20日締め期間×運送会社×拠点/営業担当/得意先」に
 * 集計してDBに保存した運賃の実費・請求額・利益(freight_actual_summaryテーブル)を、
 * 拠点別/営業担当別/得意先別に切り替えて見られるようにする。
 *
 * 2026-09-02追加。売上利益ダッシュボード(受注番号単位)とは別画面にしている理由は、
 * 運賃実費が20日締めの期間集計でしか持てず(受注番号単位に按分する情報が無い)、
 * 既存の売上利益の計算(受注番号・売上行単位)にそのまま混ぜ込めないため。
 */

type Dimension = "branch" | "rep" | "customer" | "carrier";

function fmtYen(n: number): string {
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

function customerLabel(code: string, name: string): string {
  if (!name && !code) return "不明";
  if (!name) return code;
  return name;
}

export default function FreightActualSummary({ rows }: { rows: FreightActualSummaryRow[] }) {
  const periods = useMemo(() => {
    const s = new Set(rows.map((r) => r.period_end));
    return Array.from(s).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // 新しい順
  }, [rows]);

  const [selectedPeriod, setSelectedPeriod] = useState<string>("all");
  const [dimension, setDimension] = useState<Dimension>("branch");

  const filteredRows = useMemo(() => {
    if (selectedPeriod === "all") return rows;
    return rows.filter((r) => r.period_end === selectedPeriod);
  }, [rows, selectedPeriod]);

  const grouped = useMemo(() => {
    type Group = {
      key: string;
      label: string;
      shipment_count: number;
      actual_freight: number;
      charged_freight: number;
      margin: number;
      matched_count: number;
      no_freight_charge_count: number;
      no_sales_data_count: number;
      no_mapping_count: number;
    };
    const m = new Map<string, Group>();
    for (const r of filteredRows) {
      let key: string;
      let label: string;
      if (dimension === "branch") {
        key = r.branch_code || "";
        label = r.branch_code ? branchLabel(r.branch_code) : "不明";
      } else if (dimension === "rep") {
        key = r.rep_code || "";
        label = r.rep_code ? repLabel(r.rep_code) : "不明";
      } else if (dimension === "customer") {
        key = `${r.customer_code}__${r.customer_name}`;
        label = customerLabel(r.customer_code, r.customer_name);
      } else {
        key = r.carrier;
        label = r.carrier;
      }
      let g = m.get(key);
      if (!g) {
        g = {
          key,
          label,
          shipment_count: 0,
          actual_freight: 0,
          charged_freight: 0,
          margin: 0,
          matched_count: 0,
          no_freight_charge_count: 0,
          no_sales_data_count: 0,
          no_mapping_count: 0,
        };
        m.set(key, g);
      }
      g.shipment_count += r.shipment_count;
      g.actual_freight += r.actual_freight;
      g.charged_freight += r.charged_freight;
      g.margin += r.margin;
      g.matched_count += r.matched_count;
      g.no_freight_charge_count += r.no_freight_charge_count;
      g.no_sales_data_count += r.no_sales_data_count;
      g.no_mapping_count += r.no_mapping_count;
    }
    return Array.from(m.values()).sort((a, b) => b.actual_freight - a.actual_freight);
  }, [filteredRows, dimension]);

  const totals = useMemo(() => {
    let actual = 0;
    let charged = 0;
    let margin = 0;
    let shipments = 0;
    for (const r of filteredRows) {
      actual += r.actual_freight;
      charged += r.charged_freight;
      margin += r.margin;
      shipments += r.shipment_count;
    }
    return { actual, charged, margin, shipments };
  }, [filteredRows]);

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
        <h1>運賃実績集計</h1>
        <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
          <Link href="/freight-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            運賃照合(データ取込元)
          </Link>
          <Link href="/menu" className="ghost-btn" style={{ textDecoration: "none" }}>
            ← メニューに戻る
          </Link>
        </div>
      </div>
      <p className="subtitle">
        運賃照合画面(/freight-check)で集計・保存した、20日締め期間ごとの運賃実費・請求額・利益を、拠点/営業担当/得意先別に見られます。データは西濃運輸・福山通運の請求データを取り込んで保存するたびに更新されます(自動集計ではありません)。
      </p>

      {rows.length === 0 ? (
        <div className="card">
          <p>
            まだ保存された運賃実績がありません。<Link href="/freight-check">運賃照合</Link>
            画面で請求データを読み込み、「この集計をDBに保存」を実行してください。
          </p>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ fontSize: 13 }}>
                期間:{" "}
                <select
                  value={selectedPeriod}
                  onChange={(e) => setSelectedPeriod(e.target.value)}
                  style={{ padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 4 }}
                >
                  <option value="all">全期間</option>
                  {periods.map((p) => (
                    <option key={p} value={p}>
                      〜{p}締め
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                {(
                  [
                    ["branch", "拠点別"],
                    ["rep", "営業担当別"],
                    ["customer", "得意先別"],
                    ["carrier", "運送会社別"],
                  ] as [Dimension, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setDimension(key)}
                    className={dimension === key ? "" : "ghost-btn"}
                    style={
                      dimension === key
                        ? { padding: "6px 14px", borderRadius: 6, border: "1px solid var(--direct)", background: "var(--direct)", color: "#fff" }
                        : { padding: "6px 14px" }
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="kpi-row">
            <div className="kpi-tile">
              <div className="label">対象件数</div>
              <div className="value">{totals.shipments.toLocaleString("ja-JP")}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">実費運賃合計</div>
              <div className="value">{fmtYen(totals.actual)}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">請求運賃合計</div>
              <div className="value">{fmtYen(totals.charged)}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">運賃利益合計</div>
              <div className="value" style={{ color: totals.margin < 0 ? "var(--critical)" : undefined }}>
                {fmtYen(totals.margin)}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{dimension === "branch" ? "拠点" : dimension === "rep" ? "営業担当" : dimension === "customer" ? "得意先" : "運送会社"}</th>
                    <th className="num">件数</th>
                    <th className="num">実費運賃</th>
                    <th className="num">請求運賃</th>
                    <th className="num">利益</th>
                    <th className="num">照合済み</th>
                    <th className="num">請求漏れ</th>
                    <th className="num">売上データなし</th>
                    <th className="num">受注不明</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g) => (
                    <tr key={g.key}>
                      <td>{g.label}</td>
                      <td className="num">{g.shipment_count.toLocaleString("ja-JP")}</td>
                      <td className="num">{fmtYen(g.actual_freight)}</td>
                      <td className="num">{fmtYen(g.charged_freight)}</td>
                      <td className="num" style={{ color: g.margin < 0 ? "var(--critical)" : undefined }}>
                        {fmtYen(g.margin)}
                      </td>
                      <td className="num cell-sub">{g.matched_count.toLocaleString("ja-JP")}</td>
                      <td className="num cell-sub">{g.no_freight_charge_count.toLocaleString("ja-JP")}</td>
                      <td className="num cell-sub">{g.no_sales_data_count.toLocaleString("ja-JP")}</td>
                      <td className="num cell-sub">{g.no_mapping_count.toLocaleString("ja-JP")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
