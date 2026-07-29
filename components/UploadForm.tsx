"use client";

import { useState } from "react";
import Papa from "papaparse";
import { mapSalesRow, mapPurchaseRow } from "@/lib/row-mapping";
import type { SalesRowInsert, PurchaseRowInsert } from "@/lib/row-mapping";

type Kind = "sales" | "purchase";

type Status = {
  fileName: string;
  totalRows: number;
  sentRows: number;
  totalBatches: number;
  doneBatches: number;
  errors: string[];
  running: boolean;
  finished: boolean;
};

const BATCH_SIZE = 1000;

function initialStatus(): Status {
  return {
    fileName: "",
    totalRows: 0,
    sentRows: 0,
    totalBatches: 0,
    doneBatches: 0,
    errors: [],
    running: false,
    finished: false,
  };
}

async function readAsShiftJisText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const decoder = new TextDecoder("shift_jis");
  return decoder.decode(buf);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function UploadForm() {
  const [salesStatus, setSalesStatus] = useState<Status>(initialStatus());
  const [purchaseStatus, setPurchaseStatus] = useState<Status>(initialStatus());

  async function handleFile(kind: Kind, file: File) {
    const setStatus = kind === "sales" ? setSalesStatus : setPurchaseStatus;
    setStatus({ ...initialStatus(), fileName: file.name, running: true });

    let text: string;
    try {
      text = await readAsShiftJisText(file);
    } catch (e) {
      setStatus((s) => ({
        ...s,
        running: false,
        finished: true,
        errors: [...s.errors, `ファイルの読み込みに失敗しました: ${String(e)}`],
      }));
      return;
    }

    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
    const dataRows = parsed.data.slice(1); // 1行目はヘッダー行なので除外

    const mapper = kind === "sales" ? mapSalesRow : mapPurchaseRow;
    const mapped = dataRows
      .map((cols) => mapper(cols))
      .filter((r): r is SalesRowInsert | PurchaseRowInsert => r !== null);

    if (mapped.length === 0) {
      setStatus((s) => ({
        ...s,
        running: false,
        finished: true,
        errors: [
          ...s.errors,
          "有効なデータ行が1件も見つかりませんでした。ファイルの形式(列数・エンコーディング)を確認してください。",
        ],
      }));
      return;
    }

    const batches = chunk(mapped, BATCH_SIZE);
    setStatus((s) => ({ ...s, totalRows: mapped.length, totalBatches: batches.length }));

    const endpoint = kind === "sales" ? "/api/upload/sales" : "/api/upload/purchase";
    let sent = 0;
    const errors: string[] = [];

    for (let i = 0; i < batches.length; i++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: batches[i] }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          errors.push(`バッチ${i + 1}/${batches.length}: ${json.error ?? res.statusText}`);
        } else {
          sent += batches[i].length;
        }
      } catch (e) {
        errors.push(`バッチ${i + 1}/${batches.length}: ${String(e)}`);
      }
      setStatus((s) => ({ ...s, sentRows: sent, doneBatches: i + 1, errors: [...errors] }));
    }

    setStatus((s) => ({ ...s, running: false, finished: true }));
  }

  function renderBlock(kind: Kind, label: string, hint: string, status: Status) {
    return (
      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>{label}</h2>
        <p className="subtitle" style={{ margin: "0 0 12px" }}>
          {hint}
        </p>
        <input
          type="file"
          accept=".csv"
          disabled={status.running}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(kind, f);
            e.target.value = "";
          }}
        />
        {status.fileName && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div>ファイル: {status.fileName}</div>
            {status.totalRows > 0 && (
              <div>
                読み込んだ行数: {status.totalRows.toLocaleString("ja-JP")}件 ／ 送信済み:{" "}
                {status.sentRows.toLocaleString("ja-JP")}件 ／ バッチ {status.doneBatches}/{status.totalBatches}
              </div>
            )}
            {status.running && <div style={{ color: "var(--direct)", marginTop: 4 }}>アップロード中…</div>}
            {status.finished && status.errors.length === 0 && (
              <div style={{ color: "var(--good)", marginTop: 4 }}>完了しました。</div>
            )}
            {status.errors.length > 0 && (
              <div style={{ color: "var(--critical)", marginTop: 4 }}>
                エラーが発生しました:
                <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
                  {status.errors.slice(0, 10).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      <h1>データ更新</h1>
      <p className="subtitle">
        基幹システムから出力したCSV(shift_jis / CP932エンコーディング)をそのままアップロードできます。同じ受注番号・仕入番号の行は自動的に上書き(upsert)され、重複は発生しません。
      </p>
      {renderBlock("sales", "売上データ", "uriage.csvと同じ列構成のCSVを選択してください。", salesStatus)}
      {renderBlock(
        "purchase",
        "仕入データ",
        "仕入実績データと同じ列構成のCSVを選択してください(仕入先名1・仕入番号・仕入行番号などを含む55列)。",
        purchaseStatus
      )}
      <a href="/" className="ghost-btn" style={{ display: "inline-block", textDecoration: "none" }}>
        ← ダッシュボードに戻る
      </a>
    </div>
  );
}
