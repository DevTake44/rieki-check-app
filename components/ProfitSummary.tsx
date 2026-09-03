"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ProfitSummaryRow } from "@/lib/types";
import { branchLabel } from "@/lib/branch-names";
import { repLabel } from "@/lib/rep-names";

/**
 * 拠点・営業担当・得意先別 利益ダッシュボード
 *
 * 目的: 従来の売上利益(/profit)は売上総利益(revenue-cost、粗利)止まりで、
 * 運賃の実費(freight_actual_summary、Seino請求データの取り込みで判明するように
 * なった実費)が反映されていなかった。ユーザーの要望は「運賃の利益(請求額と
 * 実費の差)を見たいのではなく、運賃の実費も引いた後の本当の利益・粗利率が
 * 見たい」というもの。そのため、事前集計テーブルprofit_summary(20日締め期間×
 * 拠点×営業担当×得意先、詳しくはlib/types.tsのProfitSummaryRowのコメント参照)を
 * このダッシュボードで表示する。2026-09-03追加。
 *
 * 【重要】profit_summaryは2026-09時点で21,399行あり、freight_actual_summary
 * (運賃照合画面から手動保存されたものだけで件数が少ない)と違って売上データ全体の
 * ロールアップのため、今後も行数が増え続ける「大きい」テーブルである。そのため
 * FreightActualSummary.tsxのようにサーバー側で1回のクエリ(.limit())で全件取得する
 * 実装は使わず、/api/profit-summary をoffsetをずらしながら何回かに分けて呼び出し、
 * ブラウザ側で全件を組み立ててから集計する(components/ProfitDashboardLoader.tsxと
 * 同じ考え方。過去にPostgRESTのdb-max-rows設定で1回のレスポンスが無言で
 * 切り詰められ、データが実態の一部しか表示されない障害が起きたため)。
 */

type Dimension = "branch" | "rep" | "customer";

const CHUNK_SIZE = 5000;
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const MAX_GAP_FILL_ROUNDS = 20;

type ChunkResponse = {
  rows: ProfitSummaryRow[];
  total: number | null;
  offset: number;
  hasMore: boolean;
  error?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchChunkOnce(offset: number): Promise<ChunkResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/profit-summary?offset=${offset}&limit=${CHUNK_SIZE}`, {
      cache: "no-store",
      signal: controller.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        rows: [],
        total: null,
        offset,
        hasMore: false,
        error: json.error ?? res.statusText ?? "不明なエラー",
      };
    }
    return json as ChunkResponse;
  } catch (e) {
    const message =
      e instanceof DOMException && e.name === "AbortError"
        ? `タイムアウトしました(${REQUEST_TIMEOUT_MS / 1000}秒応答なし)`
        : String(e);
    return { rows: [], total: null, offset, hasMore: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchChunk(offset: number): Promise<ChunkResponse> {
  let last: ChunkResponse = { rows: [], total: null, offset, hasMore: false, error: "不明なエラー" };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await fetchChunkOnce(offset);
    if (!result.error) return result;
    last = result;
    if (attempt < MAX_RETRIES) {
      await sleep(1000 * (attempt + 1));
    }
  }
  return { ...last, error: `${last.error}(${MAX_RETRIES + 1}回試行しても失敗)` };
}

function fmtYen(n: number): string {
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

function fmtPct(n: number | null): string {
  if (n === null) return "―";
  return `${n.toFixed(1)}%`;
}

// revenue合計から粗利率・最終粗利率を再計算する(パーセントを平均するのではなく、
// 必ず合計後の実額から計算し直す。freight_actual_summaryのUI/計算と同じ考え方)。
function marginPct(numerator: number, revenue: number): number | null {
  if (revenue === 0) return null;
  return Math.round((numerator / revenue) * 10000) / 100;
}

function customerLabel(code: string | null, name: string | null): string {
  if (!name && !code) return "不明";
  if (!name) return code ?? "不明";
  return name;
}

export default function ProfitSummary() {
  const [rows, setRows] = useState<ProfitSummaryRow[] | null>(null);
  const [loadedCount, setLoadedCount] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const startedRef = useRef(false);
  const cancelledRef = useRef(false);

  const [selectedPeriod, setSelectedPeriod] = useState<string>("all");
  const [dimension, setDimension] = useState<Dimension>("branch");

  async function runLoad(isRefresh: boolean) {
    if (isRefresh) {
      setRefreshing(true);
      setRefreshError(null);
    } else {
      setLoadedCount(0);
      setTotal(null);
      setInitialError(null);
    }

    const fail = (message: string) => {
      if (isRefresh) {
        setRefreshError(message);
        setRefreshing(false);
      } else {
        setInitialError(message);
      }
    };

    const first = await fetchChunk(0);
    if (cancelledRef.current) return;
    if (first.error || first.total === null) {
      fail(first.error ?? "件数の取得に失敗しました");
      return;
    }

    const firstTotal = first.total;
    // サーバーが実際に1回で返してくる件数(要求した件数より少ないことがある。
    // PostgRESTのdb-max-rows設定次第)。これを基準にoffsetを進めることで、
    // 読み飛ばしを防ぐ(profit-orders/profit-linesと同じ理由)。
    const actualPageSize = first.rows.length;

    const collected: ProfitSummaryRow[] = [...first.rows];
    if (!isRefresh) {
      setTotal(firstTotal);
      setLoadedCount(collected.length);
    }

    if (actualPageSize > 0 && collected.length < firstTotal) {
      const remainingOffsets: number[] = [];
      for (let o = actualPageSize; o < firstTotal; o += actualPageSize) {
        remainingOffsets.push(o);
      }

      for (let i = 0; i < remainingOffsets.length; i += CONCURRENCY) {
        const batch = remainingOffsets.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map((o) => fetchChunk(o)));
        if (cancelledRef.current) return;
        for (const r of results) {
          if (r.error) {
            fail(r.error);
            return;
          }
          collected.push(...r.rows);
        }
        if (!isRefresh) setLoadedCount(collected.length);
      }
    }

    // 念のための最終確認: 実際に返ってきたページサイズが途中で変わっていた場合などに
    // 備えて、集計後に合計件数が一致するか検証し、足りなければ不足分を追加取得する。
    let gapFillRounds = 0;
    while (collected.length < firstTotal && gapFillRounds < MAX_GAP_FILL_ROUNDS) {
      if (cancelledRef.current) return;
      const r = await fetchChunk(collected.length);
      if (r.error) {
        fail(r.error);
        return;
      }
      if (r.rows.length === 0) break; // これ以上取得できない(異常系)
      collected.push(...r.rows);
      if (!isRefresh) setLoadedCount(collected.length);
      gapFillRounds++;
    }

    if (cancelledRef.current) return;

    if (collected.length !== firstTotal) {
      fail(
        `件数が一致しませんでした(取得: ${collected.length.toLocaleString(
          "ja-JP"
        )}件 / 本来: ${firstTotal.toLocaleString("ja-JP")}件)。もう一度お試しください。それでも解消しない場合は開発者に連絡してください。`
      );
      return;
    }

    setRows(collected);
    setLoadedAt(Date.now());
    if (isRefresh) setRefreshing(false);
  }

  useEffect(() => {
    // React 18 Strict Mode(開発時)のuseEffect二重実行で二重取得しないようにする
    if (!startedRef.current) {
      startedRef.current = true;
      runLoad(false);
    }
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const periods = useMemo(() => {
    if (!rows) return [];
    const s = new Set(rows.map((r) => r.period_end));
    return Array.from(s).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // 新しい順
  }, [rows]);

  const filteredRows = useMemo(() => {
    if (!rows) return [];
    if (selectedPeriod === "all") return rows;
    return rows.filter((r) => r.period_end === selectedPeriod);
  }, [rows, selectedPeriod]);

  const grouped = useMemo(() => {
    type Group = {
      key: string;
      label: string;
      revenue: number;
      cost: number;
      gross_profit: number;
      freight_actual: number;
      final_profit: number;
      line_count: number;
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
      } else {
        key = `${r.customer_code ?? ""}__${r.customer_name ?? ""}`;
        label = customerLabel(r.customer_code, r.customer_name);
      }
      let g = m.get(key);
      if (!g) {
        g = { key, label, revenue: 0, cost: 0, gross_profit: 0, freight_actual: 0, final_profit: 0, line_count: 0 };
        m.set(key, g);
      }
      g.revenue += r.revenue;
      g.cost += r.cost;
      g.gross_profit += r.gross_profit;
      g.freight_actual += r.freight_actual;
      g.final_profit += r.final_profit;
      g.line_count += r.line_count;
    }
    // 売上総利益(gross_profit)の大きい順。運賃だけの不明行(revenue=0)は自然と下に来る。
    return Array.from(m.values())
      .map((g) => ({
        ...g,
        gross_margin_pct: marginPct(g.gross_profit, g.revenue),
        final_margin_pct: marginPct(g.final_profit, g.revenue),
      }))
      .sort((a, b) => b.gross_profit - a.gross_profit);
  }, [filteredRows, dimension]);

  const totals = useMemo(() => {
    let revenue = 0;
    let cost = 0;
    let gross_profit = 0;
    let freight_actual = 0;
    let final_profit = 0;
    let line_count = 0;
    for (const r of filteredRows) {
      revenue += r.revenue;
      cost += r.cost;
      gross_profit += r.gross_profit;
      freight_actual += r.freight_actual;
      final_profit += r.final_profit;
      line_count += r.line_count;
    }
    return {
      revenue,
      cost,
      gross_profit,
      freight_actual,
      final_profit,
      line_count,
      gross_margin_pct: marginPct(gross_profit, revenue),
      final_margin_pct: marginPct(final_profit, revenue),
    };
  }, [filteredRows]);

  if (!rows) {
    if (initialError) {
      return (
        <div className="page">
          <h1>拠点・営業・得意先 利益</h1>
          <div className="card">
            <p>データの取得に失敗しました。</p>
            <pre style={{ whiteSpace: "pre-wrap", color: "#c0392b" }}>{initialError}</pre>
            <button className="ghost-btn" style={{ marginTop: 12 }} onClick={() => runLoad(false)}>
              もう一度読み込む
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="page">
        <h1>拠点・営業・得意先 利益</h1>
        <div className="card">
          <p>
            読み込み中… {loadedCount.toLocaleString("ja-JP")}
            {total !== null ? ` / ${total.toLocaleString("ja-JP")}` : ""} 件
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
        <h1>拠点・営業・得意先 利益</h1>
        <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
          <Link href="/menu" className="ghost-btn" style={{ textDecoration: "none" }}>
            ← メニューに戻る
          </Link>
        </div>
      </div>
      <p className="subtitle">
        売上・原価に加えて運賃の実費(freight_actual)まで引いた最終利益・最終粗利率を、拠点別・営業担当別・得意先別に確認できます。売上に紐付かない運賃だけの行(送り状↔受注番号の対応が取れなかったもの)は「不明」として集計されます。
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", margin: "0 0 16px" }}>
        <span className="cell-sub">
          最終読み込み: {loadedAt !== null ? new Date(loadedAt).toLocaleString("ja-JP") : "―"}
          {refreshing && (
            <>
              {" "}
              (更新中… {loadedCount.toLocaleString("ja-JP")}
              {total !== null ? ` / ${total.toLocaleString("ja-JP")}` : ""} 件)
            </>
          )}
        </span>
        <button className="ghost-btn" onClick={() => runLoad(true)} disabled={refreshing}>
          {refreshing ? "更新中…" : "更新"}
        </button>
        {refreshError && <span style={{ color: "#c0392b", fontSize: 12.5 }}>更新に失敗しました: {refreshError}</span>}
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <p>まだ profit_summary にデータがありません。</p>
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
              <div className="label">売上</div>
              <div className="value">{fmtYen(totals.revenue)}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">売上総利益</div>
              <div className="value">{fmtYen(totals.gross_profit)}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">運賃実費合計</div>
              <div className="value">{fmtYen(totals.freight_actual)}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">最終利益</div>
              <div className="value" style={{ color: totals.final_profit < 0 ? "var(--critical)" : undefined }}>
                {fmtYen(totals.final_profit)}
              </div>
            </div>
            <div className="kpi-tile">
              <div className="label">最終粗利率</div>
              <div className="value">{fmtPct(totals.final_margin_pct)}</div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{dimension === "branch" ? "拠点" : dimension === "rep" ? "営業担当" : "得意先"}</th>
                    <th className="num">売上</th>
                    <th className="num">原価</th>
                    <th className="num">売上総利益</th>
                    <th className="num">粗利率</th>
                    <th className="num">運賃実費</th>
                    <th className="num">最終利益</th>
                    <th className="num">最終粗利率</th>
                    <th className="num">明細行数</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((g) => (
                    <tr key={g.key}>
                      <td>{g.label}</td>
                      <td className="num">{fmtYen(g.revenue)}</td>
                      <td className="num">{fmtYen(g.cost)}</td>
                      <td className="num">{fmtYen(g.gross_profit)}</td>
                      <td className="num cell-sub">{fmtPct(g.gross_margin_pct)}</td>
                      <td className="num">{fmtYen(g.freight_actual)}</td>
                      <td className="num" style={{ color: g.final_profit < 0 ? "var(--critical)" : undefined }}>
                        {fmtYen(g.final_profit)}
                      </td>
                      <td className="num cell-sub">{fmtPct(g.final_margin_pct)}</td>
                      <td className="num cell-sub">{g.line_count.toLocaleString("ja-JP")}</td>
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
