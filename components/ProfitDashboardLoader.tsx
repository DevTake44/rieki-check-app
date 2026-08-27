"use client";

import { useEffect, useRef, useState } from "react";
import ProfitDashboard from "./ProfitDashboard";
import type { ProfitOrder } from "@/lib/types";
import { getProfitCache, setProfitCache } from "@/lib/profit-cache";

// v_profit_by_order の全件(8万8千件超、2026-08時点)をサーバー側で1回のレスポンスに
// 詰めるとJSONで約30MBになり、Vercel Functionsのレスポンスサイズ上限(4.5MB)を超えて
// 500エラーになる(実際に発生した障害)。そのため app/profit/page.tsx 側では取得せず、
// このコンポーネントがブラウザ上で /api/profit-orders を何回かに分けて呼び出し、
// 手元で全件を組み立ててから ProfitDashboard に渡す。
const REQUESTED_CHUNK_SIZE = 3000;
const CONCURRENCY = 4;

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
// 進めるようにし、最後に合計件数が一致するかも必ず検証する。
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const MAX_GAP_FILL_ROUNDS = 20;

type ChunkResponse = {
  rows: ProfitOrder[];
  total: number | null;
  offset: number;
  hasMore: boolean;
  error?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchChunkOnce(offset: number, limit: number): Promise<ChunkResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/profit-orders?offset=${offset}&limit=${limit}`, {
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

async function fetchChunk(offset: number, limit: number): Promise<ChunkResponse> {
  let last: ChunkResponse = { rows: [], total: null, offset, hasMore: false, error: "不明なエラー" };
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await fetchChunkOnce(offset, limit);
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

    const first = await fetchChunk(0, REQUESTED_CHUNK_SIZE);
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
        const results = await Promise.all(batch.map((o) => fetchChunk(o, REQUESTED_CHUNK_SIZE)));
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
      const r = await fetchChunk(collected.length, REQUESTED_CHUNK_SIZE);
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
  }

  useEffect(() => {
    // React 18 Strict Mode(開発時)のuseEffect二重実行で二重取得しないようにする
    if (!startedRef.current) {
      startedRef.current = true;

      const cached = getProfitCache();
      if (cached) {
        setOrders(cached.orders);
        setLoadedAt(cached.loadedAt);
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

  return <ProfitDashboard orders={orders} headerExtra={statusBar} />;
}
