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

type ChunkResponse = {
  rows: ProfitOrder[];
  total: number;
  offset: number;
  hasMore: boolean;
  error?: string;
};

async function fetchChunk(offset: number): Promise<ChunkResponse> {
  try {
    const res = await fetch(`/api/profit-orders?offset=${offset}&limit=${CHUNK_SIZE}`, { cache: "no-store" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { rows: [], total: 0, offset, hasMore: false, error: json.error ?? res.statusText ?? "不明なエラー" };
    }
    return json as ChunkResponse;
  } catch (e) {
    return { rows: [], total: 0, offset, hasMore: false, error: String(e) };
  }
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
      if (first.error) {
        setError(first.error);
        return;
      }

      const collected: ProfitOrder[] = [...first.rows];
      setTotal(first.total);
      setLoadedCount(collected.length);

      const remainingOffsets: number[] = [];
      for (let o = first.rows.length; o < first.total; o += CHUNK_SIZE) {
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
          <p>データの取得に失敗しました。</p>
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
