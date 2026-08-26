"use client";

import { useEffect, useRef, useState } from "react";
import ProfitDashboard from "./ProfitDashboard";
import type { ProfitOrder } from "@/lib/types";

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
      const first = await fetchChunk(0, REQUESTED_CHUNK_SIZE);
      if (cancelled) return;
      if (first.error || first.total === null) {
        setError(first.error ?? "件数の取得に失敗しました");
        return;
      }

      const firstTotal = first.total;
      // サーバーが実際に1回で返してくる件数(要求した件数より少ないことがある)。
      // これを基準にoffsetを進めることで、読み飛ばしを防ぐ。
      const actualPageSize = first.rows.length;

      const collected: ProfitOrder[] = [...first.rows];
      setTotal(firstTotal);
      setLoadedCount(collected.length);

      if (actualPageSize > 0 && collected.length < firstTotal) {
        const remainingOffsets: number[] = [];
        for (let o = actualPageSize; o < firstTotal; o += actualPageSize) {
          remainingOffsets.push(o);
        }

        for (let i = 0; i < remainingOffsets.length; i += CONCURRENCY) {
          const batch = remainingOffsets.slice(i, i + CONCURRENCY);
          const results = await Promise.all(batch.map((o) => fetchChunk(o, REQUESTED_CHUNK_SIZE)));
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
      }

      // 念のための最終確認: 実際に返ってきたページサイズが途中で変わっていた場合などに
      // 備えて、集計後に合計件数が一致するか検証し、足りなければ不足分を追加取得する。
      let gapFillRounds = 0;
      while (collected.length < firstTotal && gapFillRounds < MAX_GAP_FILL_ROUNDS) {
        if (cancelled) return;
        const r = await fetchChunk(collected.length, REQUESTED_CHUNK_SIZE);
        if (r.error) {
          setError(r.error);
          return;
        }
        if (r.rows.length === 0) break; // これ以上取得できない(異常系)
        collected.push(...r.rows);
        setLoadedCount(collected.length);
        gapFillRounds++;
      }

      if (cancelled) return;

      if (collected.length !== firstTotal) {
        setError(
          `件数が一致しませんでした(取得: ${collected.length.toLocaleString(
            "ja-JP"
          )}件 / 本来: ${firstTotal.toLocaleString(
            "ja-JP"
          )}件)。ページを再読み込みしてください。それでも解消しない場合は開発者に連絡してください。`
        );
        return;
      }

      setOrders(collected);
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
