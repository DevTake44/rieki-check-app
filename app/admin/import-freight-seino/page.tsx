"use client";

// 西濃運輸(兵庫)の運賃実績集計(freight_actual_summary)を一括で書き戻すための
// 一回限りの取込ページ(2026-09-04追加)。
//
// 背景: このデータはClaude側で計算済みで、本来なら運賃照合画面(FreightCheck)の
// 「この集計をDBに保存」ボタンと同じ保存API(/api/upload/freight-actual)にそのまま
// POSTすれば済む。ただしClaude側の実行環境からこのアプリの本番/プレビューURLへ
// 直接HTTPで書き込みに行くことができない(組織のネットワークポリシーで
// 外向き通信が許可リストの外だと拒否される)ため、代わりにブラウザ側から
// 実行できるこの画面を用意した。
//
// 使い方: このページを開いてボタンを押すだけ。データは public/data/ 配下に
// 静的ファイルとして同梱済み(5,421行を5,000件上限に収まるよう2ファイルに分割)。
// 既存の /api/upload/freight-actual は (period_end, carrier, source_label) 単位で
// 洗い替え(削除→挿入)するので、やり直しても二重計上にはならない。
//
// 用が済んだら、このファイルと public/data/freight-actual-seino-hyogo-batch*.json は
// 削除して構わない(残しておいても実害はないが、次に別の実績データを取り込む際は
// 別名のファイル・ページを作ること)。

import { useState } from "react";

const BATCH_FILES = [
  "/data/freight-actual-seino-hyogo-batch1.json",
  "/data/freight-actual-seino-hyogo-batch2.json",
];

type BatchResult = {
  file: string;
  status: "pending" | "ok" | "error";
  message: string;
};

export default function ImportFreightSeinoPage() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BatchResult[]>(
    BATCH_FILES.map((file) => ({ file, status: "pending", message: "" }))
  );

  async function runImport() {
    setRunning(true);
    const next: BatchResult[] = BATCH_FILES.map((file) => ({ file, status: "pending", message: "" }));
    setResults([...next]);

    for (let i = 0; i < BATCH_FILES.length; i++) {
      const file = BATCH_FILES[i];
      try {
        const fileRes = await fetch(file, { cache: "no-store" });
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

        next[i] = {
          file,
          status: "ok",
          message: `${apiJson.inserted ?? "?"}件保存(期間${apiJson.periods ?? "?"}件ぶん)`,
        };
      } catch (e) {
        next[i] = { file, status: "error", message: e instanceof Error ? e.message : String(e) };
      }
      setResults([...next]);
    }

    setRunning(false);
  }

  const allDone = results.every((r) => r.status === "ok");
  const anyError = results.some((r) => r.status === "error");

  return (
    <main style={{ maxWidth: 640, margin: "40px auto", padding: "0 16px", fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>西濃(兵庫) 運賃実績データ取込(一回限り)</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>
        2025-10-20〜2026-07-20の20日締め期間、計5,421行(拠点/営業担当/得意先別)を
        freight_actual_summary に書き戻します。ボタンを押すだけで完了します。
        押し直しても、この期間ぶんは洗い替えされるだけなので二重計上にはなりません。
      </p>
      <button
        onClick={runImport}
        disabled={running}
        style={{
          padding: "10px 20px",
          fontSize: 15,
          background: running ? "#999" : "#2563eb",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: running ? "default" : "pointer",
          marginTop: 12,
        }}
      >
        {running ? "取込中..." : "取込を実行する"}
      </button>

      <ul style={{ marginTop: 20, padding: 0, listStyle: "none" }}>
        {results.map((r) => (
          <li key={r.file} style={{ marginBottom: 8, fontSize: 14 }}>
            <span
              style={{
                display: "inline-block",
                width: 18,
                color: r.status === "ok" ? "#16a34a" : r.status === "error" ? "#dc2626" : "#999",
              }}
            >
              {r.status === "ok" ? "✓" : r.status === "error" ? "×" : "…"}
            </span>
            {r.file.split("/").pop()} {r.message}
          </li>
        ))}
      </ul>

      {allDone && <p style={{ color: "#16a34a", fontWeight: "bold" }}>完了しました。</p>}
      {anyError && (
        <p style={{ color: "#dc2626" }}>
          エラーが出た場合は、そのままこの画面のメッセージを教えてください。
        </p>
      )}
    </main>
  );
}
