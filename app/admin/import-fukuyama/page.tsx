"use client";

// 福山通運(土浦)の運賃実績集計(freight_actual_summary)を一括で書き戻すための
// 一回限りの取込ページ(2026-09-04追加)。西濃(兵庫)のときと同じ仕組み。
//
// 背景: このデータはClaude側で計算済みで、本来なら運賃照合画面(FreightCheck)の
// 「この集計をDBに保存」ボタンと同じ保存API(/api/upload/freight-actual)にそのまま
// POSTすれば済む。ただしClaude側の実行環境からこのアプリの本番/プレビューURLへ
// 直接HTTPで書き込みに行くことができない(組織のネットワークポリシーで
// 外向き通信が許可リストの外だと拒否される)ため、代わりにブラウザ側から
// 実行できるこの画面を用意した。
//
// 使い方: このページを開いてボタンを押すだけ。データは public/data/ 配下に
// 静的ファイルとして同梱済み(1,485行、上限5,000件以内なので1ファイルで完結)。
// 既存の /api/upload/freight-actual は (period_end, carrier, source_label) 単位で
// 洗い替え(削除→挿入)するので、押し直しても二重計上にはならない。
// carrier="福山通運", source_label="福山(土浦)" として保存される
// (西濃運輸(兵庫)とは別のsource_labelなので、互いのデータを消し合うことはない)。
//
// 用が済んだら、このファイルと public/data/freight-actual-fukuyama-tsuchiura.json は
// 削除して構わない(残しておいても実害はないが、次に別の実績データを取り込む際は
// 別名のファイル・ページを作ること)。

import { useState } from "react";

const DATA_FILE = "/data/freight-actual-fukuyama-tsuchiura.json";

type Status = "pending" | "running" | "ok" | "error";

export default function ImportFreightFukuyamaPage() {
  const [status, setStatus] = useState<Status>("pending");
  const [message, setMessage] = useState("");

  async function runImport() {
    setStatus("running");
    setMessage("");
    try {
      const fileRes = await fetch(DATA_FILE, { cache: "no-store" });
      if (!fileRes.ok) {
        throw new Error(`データファイルの取得に失敗しました(HTTP ${fileRes.status})`);
      }
      const body = await fileRes.json();
      const rows = body.rows ?? [];

      const apiRes = await fetch("/api/upload/freight-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const apiJson = await apiRes.json().catch(() => ({}));

      if (!apiRes.ok) {
        throw new Error(apiJson.error ?? `保存に失敗しました(HTTP ${apiRes.status})`);
      }

      setStatus("ok");
      setMessage(`${apiJson.inserted ?? "?"}件保存(期間${apiJson.periods ?? "?"}件ぶん)`);
    } catch (e) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", padding: "0 16px", fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>福山(土浦) 運賃実績データ取込(一回限り)</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        2025-09-20〜2026-07-20の21日〜20日サイクルで再集計した1,485行(拠点/営業担当/得意先別)を
        freight_actual_summary に書き戻します(carrier=福山通運, source_label=福山(土浦))。
        ボタンを押すだけで完了します。押し直しても、この期間ぶんは洗い替えされるだけなので
        二重計上にはなりません。
      </p>
      <button
        onClick={runImport}
        disabled={status === "running"}
        style={{
          padding: "10px 20px",
          fontSize: 15,
          background: status === "running" ? "#999" : "#2563eb",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: status === "running" ? "default" : "pointer",
          marginTop: 12,
        }}
      >
        {status === "running" ? "取込中..." : "取込を実行する"}
      </button>

      {status !== "pending" && (
        <p style={{ marginTop: 20, fontSize: 14 }}>
          <span
            style={{
              display: "inline-block",
              width: 18,
              color: status === "ok" ? "#16a34a" : status === "error" ? "#dc2626" : "#999",
            }}
          >
            {status === "ok" ? "✓" : status === "error" ? "×" : "…"}
          </span>
          {DATA_FILE.split("/").pop()} {message}
        </p>
      )}

      {status === "ok" && <p style={{ color: "#16a34a", fontWeight: "bold" }}>完了しました。</p>}
      {status === "error" && (
        <p style={{ color: "#dc2626" }}>
          エラーが出た場合は、そのままこの画面のメッセージを教えてください。
        </p>
      )}
    </main>
  );
}
