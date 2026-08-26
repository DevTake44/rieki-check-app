"use client";

import { useEffect, useRef, useState } from "react";
import ProfitDashboard from "./ProfitDashboard";
import type { ProfitOrder } from "@/lib/types";

// v_profit_by_order の全件(8万8千件超、2026-08時点)をサーバー側で1回のレスポンスに
// 詰めるとJSONで約30MBになり、Vercel Functionsのレスポンスサイズ上限(4.5MB)を超えて
// 500エラーになる(実際に発生した障害)。そのため app/profit/page.tsx 側では取得せず、
// このコンポーネントがブラウザ上で /api/profit-orders を何回かに分けて呼び出し、
// 手元で全件を組み立ててから ProfitDashboard に渡す。
const CHUNK_SIZE = 3000;
const CONCURRENCY = 4;

// 2026-08-18判明: 1リクエストがタイムアウトなく無応答のまま固まると、
// Promise.allで待っているバッチ全体が永遠に止まってしまい、エラーも出ずに
// 「読み込み中… 13,000 / 88,481 件」のまま進まなくなる不具合があった。
// これを防ぐため、リクエストごとにタイムアウトと再試行を設ける。
const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;

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

async function fetchChunkOnce(offset: number): Promise<ChunkResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/profit-orders?offset=${offset}&limit=${CHUNK_SIZE}`, {
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
      // 単純な再試行だと同じ理由で失敗し続けることがあるため、少し間隔をあける
      await sleep(1000 * (attempt + 1));
    }
  }
  return { ...last, error: `${last.error}(${MAX_RETRIES + 1}回試行しても失敗)` };
}

export default function ProfitDashboardLoader() {
  const [orders, setOrders] = useState<ProfitOrder[] | null>(null);
  const [loadedCount, setLoadedCount] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    // React 18 Strict Mode(開発時)のuseEffect二重実行で二重取得しないようにする
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;

    (async () => {
      const first = await fetchChunk(0);
      if (cancelled) return;
      if (first.error || first.total === null) {
        setError(first.error ?? "件数の取得に失敗しました");
        return;
      }

      const collected: ProfitOrder[] = [...first.rows];
      const firstTotal = first.total;
      setTotal(firstTotal);
      setLoadedCount(collected.length);

      const remainingOffsets: number[] = [];
      for (let o = first.rows.length; o < firstTotal; o += CHUNK_SIZE) {
        remainingOffsets.push(o);
      }

      for (let i = 0; i < remainingOffsets.length; i += CONCURRENCY) {
        const batch = remainingOffsets.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map((o) => fetchChunk(o)));
        if (cancelled) return;
        for (const r of results) {
          if (r.error) {
            setError(r.error);
            return;
          }
          collected.push(...r.rows);
        }
        setLoadedCount(collected.length);
      }

      if (!cancelled) setOrders(collected);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="page">
        <h1>売上利益</h1>
        <div className="card">
          <p>データの取得に失敗しました。時間をおいてページを再読み込みしてください。</p>
          <pre style={{ whiteSpace: "pre-wrap", color: "#c0392b" }}>{error}</pre>
        </div>
      </div>
    );
  }

  if (!orders) {
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

  return <ProfitDashboard orders={orders} />;
}
