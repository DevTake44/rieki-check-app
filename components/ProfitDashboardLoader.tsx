"use client";

import { useEffect, useRef, useState } from "react";
import ProfitDashboard from "./ProfitDashboard";
import type { ProfitOrder, ProfitLine } from "@/lib/types";
import {
  getProfitCache,
  setProfitCache,
  getProfitLinesCache,
  setProfitLinesCache,
  clearProfitLinesCache,
} from "@/lib/profit-cache";
import { periodKeyFor, fiscalYearStartOf, fiscalYearRangeFor } from "@/lib/period";

// v_profit_by_order の全件(8万8千件超、2026-08時点)をサーバー側で1回のレスポンスに
// 詰めるとJSONで約30MBになり、Vercel Functionsのレスポンスサイズ上限(4.5MB)を超えて
// 500エラーになる(実際に発生した障害)。そのため app/profit/page.tsx 側では取得せず、
// このコンポーネントがブラウザ上で /api/profit-orders を何回かに分けて呼び出し、
// 手元で全件を組み立ててから ProfitDashboard に渡す。
const REQUESTED_CHUNK_SIZE = 3000;
const CONCURRENCY = 4;

// 経営マトリクス(月別集計)専用データ(/api/profit-lines)のチャンクサイズ。
// 1行あたりのフィールド数がordersより少ないため、少し大きめでも安全。
//
// 2026-09-04変更(5000→10000→5000): 往復回数を減らす目的で一時的に10,000件に
// 上げたが、Supabase側のアクセスログを見ると、10,000件にした後は「1回目の
// チャンク(offset=0)だけ成功し、2回目以降(offset=10000〜)が一切発生しない」
// という状態が複数回再現した。5,000件のときは offset=195000 まで問題なく
// 進んでいた実績があり、DB自体は速い(数ミリ秒)ことも確認済みなので、原因は
// 特定できていないが10,000件固有の問題(レスポンスサイズか何らかの上限に
// 関係している可能性)と判断し、実績のある5,000件に戻す。往復回数を減らす
// 効果よりも「確実に完走する」ことを優先する。
const LINES_CHUNK_SIZE = 5000;

// 2026-08-26判明(重要): SupabaseのREST API(PostgREST)には1リクエストあたりの
// 最大件数(Max Rows)設定があり、この案件の環境では要求した3000件ではなく実際には
// もっと少ない件数(例: 1000件)しか返ってこないことが分かった。
// 従来のコードは「1回のリクエストで必ずCHUNK_SIZE件返ってくる」という前提で
// 次のoffsetを機械的に+3000ずつ進めていたため、実際の返却件数がそれより少ないと
// 途中の受注が読み飛ばされたまま「読み込み完了」になってしまい、エラーも出ずに
// 経営マトリクスの売上が本来の約3分の1程度になる、という不具合が発生していた
// (拠点別マトリクスで東京・10月が本来154,051,945円のはずが53,688,899円と表示された
// 実際の障害。53,688,899 ÷ 154,051,945 ≈ 34.9%で、1000件/3000件要求の比率と一致)。
// そのため、次のoffsetは「要求した件数」ではなく「実際に返ってきた件数」を基準に
// 進めるようにし、最後に合計件数が一致するかも必ず検証する。/api/profit-lines の
// 読み込みでも同じ考え方を使う。
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const MAX_GAP_FILL_ROUNDS = 20;

type ChunkResponse<T> = {
  rows: T[];
  total: number | null;
  offset: number;
  hasMore: boolean;
  error?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchChunkOnce<T>(url: string, offset: number): Promise<ChunkResponse<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
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
    return json as ChunkResponse<T>;
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

async function fetchChunk<T>(url: string, offset: number): Promise<ChunkResponse<T>> {
  let last: ChunkResponse<T> = { rows: [], total: null, offset, hasMore: false, error: "不明なエラー" };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await fetchChunkOnce<T>(url, offset);
    if (!result.error) return result;
    last = result;
    if (attempt < MAX_RETRIES) {
      // 単純な再試行だと同じ理由で失敗し続けることがあるため、少し間隔をあける
      await sleep(1000 * (attempt + 1));
    }
  }
  return { ...last, error: `${last.error}(${MAX_RETRIES + 1}回試行しても失敗)` };
}

function fmtDateTime(ms: number): string {
  const dt = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}/${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(
    dt.getMinutes()
  )}`;
}

// 経営マトリクスが必要とする範囲(今期・前期のうち一番古い期の開始日)を、
// ProfitDashboard.tsx が availablePeriods/availableFiscalYears を計算するのと
// 全く同じロジックで求める(表示される期間と取得範囲がズレないようにするため)。
// 前期データが無ければ今期分だけで十分なので、無駄に古いデータまでは取得しない。
function computeMatrixSince(orders: ProfitOrder[]): string | null {
  const periodKeys = new Set<string>();
  orders.forEach((o) => {
    if (o.delivery_date) periodKeys.add(periodKeyFor(o.delivery_date));
  });
  if (periodKeys.size === 0) return null;
  const fyStarts = Array.from(new Set(Array.from(periodKeys).map(fiscalYearStartOf))).sort((a, b) => b - a);
  // fyStarts[0]=今期の期首年, fyStarts[1]=前期の期首年(あれば)
  const targetFYStart = fyStarts.length > 1 ? fyStarts[1] : fyStarts[0];
  return fiscalYearRangeFor(targetFYStart).from;
}

export default function ProfitDashboardLoader() {
  // orders: 実際に画面に表示するデータ。キャッシュ由来か、読み込み直後のものかを問わない。
  const [orders, setOrders] = useState<ProfitOrder[] | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  // 初回読み込み(まだ orders が無い状態)専用の進捗・エラー
  const [loadedCount, setLoadedCount] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [initialError, setInitialError] = useState<string | null>(null);

  // 手動更新(既に orders があり、裏で読み直している状態)専用の進捗・エラー。
  // 更新中も古いデータを表示し続けたいので、初回読み込みの状態とは分けている。
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // 2026-08-31追加: 経営マトリクス専用(行単位)データ。ordersとは別に読み込む。
  // まだ読み込めていない間も、経営マトリクス以外(受注番号別内訳など)は
  // ordersだけで表示できるので、ページ全体はブロックしない。
  const [matrixLines, setMatrixLines] = useState<ProfitLine[] | null>(null);
  const [matrixLinesLoading, setMatrixLinesLoading] = useState(false);
  const [matrixLinesError, setMatrixLinesError] = useState<string | null>(null);
  // 2026-09-04追加: 経営マトリクスの読み込み中、進捗件数が全く表示されず
  // 「読み込み中…」の固定文言だけだったため、実際には正常に進んでいても
  // 止まっているように見えてしまい、途中で再読み込みされて最初からやり直しに
  // なる、という悪循環が起きていた(Supabaseのアクセスログで、1回目のチャンクが
  // 一瞬で成功した直後にリクエストが途切れるパターンを複数回確認)。受注データ側
  // (loadedCount/total)と同じように進捗を表示できるようにする。
  const [matrixLinesLoadedCount, setMatrixLinesLoadedCount] = useState(0);
  const [matrixLinesTotal, setMatrixLinesTotal] = useState<number | null>(null);

  const startedRef = useRef(false);
  const cancelledRef = useRef(false);

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

    const first = await fetchChunk<ProfitOrder>(
      `/api/profit-orders?offset=0&limit=${REQUESTED_CHUNK_SIZE}`,
      0
    );
    if (cancelledRef.current) return;
    if (first.error || first.total === null) {
      fail(first.error ?? "件数の取得に失敗しました");
      return;
    }

    const firstTotal = first.total;
    // サーバーが実際に1回で返してくる件数(要求した件数より少ないことがある)。
    // これを基準にoffsetを進めることで、読み飛ばしを防ぐ。
    const actualPageSize = first.rows.length;

    const collected: ProfitOrder[] = [...first.rows];
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
        const results = await Promise.all(
          batch.map((o) => fetchChunk<ProfitOrder>(`/api/profit-orders?offset=${o}&limit=${REQUESTED_CHUNK_SIZE}`, o))
        );
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
      const r = await fetchChunk<ProfitOrder>(
        `/api/profit-orders?offset=${collected.length}&limit=${REQUESTED_CHUNK_SIZE}`,
        collected.length
      );
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

    // 2026-08-27追加: 読み込み終わったデータをブラウザ内(モジュール変数)にキャッシュしておく。
    // これにより、メニューに戻ってから再度この画面を開いたとき(next/linkでの画面遷移である限り)、
    // 再取得せずに即座に表示できる。ブラウザを完全に再読み込みした場合は失われ、通常通り読み直す。
    setProfitCache(collected);
    setOrders(collected);
    setLoadedAt(Date.now());
    if (isRefresh) setRefreshing(false);

    // 手動更新のときは、経営マトリクス用データも古いキャッシュのまま使い回さず、
    // ordersと一緒に読み直す(仕入確定などでordersの数字が変われば、行単位の
    // 集計結果も当然変わりうるため)。
    if (isRefresh) clearProfitLinesCache();
    runLoadMatrixLines(collected, isRefresh);
  }

  async function runLoadMatrixLines(currentOrders: ProfitOrder[], forceReload: boolean) {
    const since = computeMatrixSince(currentOrders);
    if (since === null) {
      setMatrixLines([]);
      return;
    }

    if (!forceReload) {
      const cached = getProfitLinesCache(since);
      if (cached) {
        setMatrixLines(cached.lines);
        return;
      }
    }

    setMatrixLinesLoading(true);
    setMatrixLinesError(null);
    setMatrixLinesLoadedCount(0);
    setMatrixLinesTotal(null);

    const first = await fetchChunk<ProfitLine>(
      `/api/profit-lines?since=${since}&offset=0&limit=${LINES_CHUNK_SIZE}`,
      0
    );
    if (cancelledRef.current) return;
    if (first.error || first.total === null) {
      setMatrixLinesError(first.error ?? "件数の取得に失敗しました");
      setMatrixLinesLoading(false);
      return;
    }

    const firstTotal = first.total;
    const actualPageSize = first.rows.length;
    const collected: ProfitLine[] = [...first.rows];
    setMatrixLinesTotal(firstTotal);
    setMatrixLinesLoadedCount(collected.length);

    if (actualPageSize > 0 && collected.length < firstTotal) {
      const remainingOffsets: number[] = [];
      for (let o = actualPageSize; o < firstTotal; o += actualPageSize) {
        remainingOffsets.push(o);
      }
      for (let i = 0; i < remainingOffsets.length; i += CONCURRENCY) {
        const batch = remainingOffsets.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map((o) =>
            fetchChunk<ProfitLine>(`/api/profit-lines?since=${since}&offset=${o}&limit=${LINES_CHUNK_SIZE}`, o)
          )
        );
        if (cancelledRef.current) return;
        for (const r of results) {
          if (r.error) {
            setMatrixLinesError(r.error);
            setMatrixLinesLoading(false);
            return;
          }
          collected.push(...r.rows);
        }
        setMatrixLinesLoadedCount(collected.length);
      }
    }

    let gapFillRounds = 0;
    while (collected.length < firstTotal && gapFillRounds < MAX_GAP_FILL_ROUNDS) {
      if (cancelledRef.current) return;
      const r = await fetchChunk<ProfitLine>(
        `/api/profit-lines?since=${since}&offset=${collected.length}&limit=${LINES_CHUNK_SIZE}`,
        collected.length
      );
      if (r.error) {
        setMatrixLinesError(r.error);
        setMatrixLinesLoading(false);
        return;
      }
      if (r.rows.length === 0) break;
      collected.push(...r.rows);
      setMatrixLinesLoadedCount(collected.length);
      gapFillRounds++;
    }

    if (cancelledRef.current) return;

    if (collected.length !== firstTotal) {
      setMatrixLinesError(
        `経営マトリクス用データの件数が一致しませんでした(取得: ${collected.length.toLocaleString(
          "ja-JP"
        )}件 / 本来: ${firstTotal.toLocaleString("ja-JP")}件)。`
      );
      setMatrixLinesLoading(false);
      return;
    }

    setProfitLinesCache(since, collected);
    setMatrixLines(collected);
    setMatrixLinesLoading(false);
  }

  useEffect(() => {
    // React 18 Strict Mode(開発時)のuseEffect二重実行で二重取得しないようにする
    if (!startedRef.current) {
      startedRef.current = true;

      const cached = getProfitCache();
      if (cached) {
        setOrders(cached.orders);
        setLoadedAt(cached.loadedAt);
        runLoadMatrixLines(cached.orders, false);
      } else {
        runLoad(false);
      }
    }

    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!orders) {
    if (initialError) {
      return (
        <div className="page">
          <h1>売上利益</h1>
          <div className="card">
            <p>データの取得に失敗しました。</p>
            <pre style={{ whiteSpace: "pre-wrap", color: "#c0392b" }}>{initialError}</pre>
            <button
              className="ghost-btn"
              style={{ marginTop: 12 }}
              onClick={() => runLoad(false)}
            >
              もう一度読み込む
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="page">
        <h1>売上利益</h1>
        <div className="card">
          <p>
            読み込み中… {loadedCount.toLocaleString("ja-JP")}
            {total !== null ? ` / ${total.toLocaleString("ja-JP")}` : ""} 件
          </p>
        </div>
      </div>
    );
  }

  const statusBar = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
        margin: "0 0 8px",
      }}
    >
      <span className="cell-sub">
        最終読み込み: {loadedAt !== null ? fmtDateTime(loadedAt) : "―"}
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
      {refreshError && (
        <span style={{ color: "#c0392b", fontSize: 12.5 }}>更新に失敗しました: {refreshError}</span>
      )}
    </div>
  );

  return (
    <ProfitDashboard
      orders={orders}
      headerExtra={statusBar}
      matrixLines={matrixLines}
      matrixLinesLoading={matrixLinesLoading}
      matrixLinesError={matrixLinesError}
      matrixLinesLoadedCount={matrixLinesLoadedCount}
      matrixLinesTotal={matrixLinesTotal}
      onRetryMatrixLines={() => runLoadMatrixLines(orders, true)}
    />
  );
}
