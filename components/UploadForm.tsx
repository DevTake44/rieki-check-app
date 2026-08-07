"use client";

import { useState } from "react";
import Papa from "papaparse";
import { mapSalesRow, mapPurchaseRow, mapTransferRow, mapShippingNoteRow } from "@/lib/row-mapping";
import type { SalesRowInsert, PurchaseRowInsert, TransferRowInsert, ShippingNoteRowInsert } from "@/lib/row-mapping";

type Kind = "sales" | "purchase" | "transfer" | "shippingNote";

type Status = {
  fileName: string;
  detectedEncoding: string;
  totalRows: number;
  sentRows: number;
  totalBatches: number;
  doneBatches: number;
  errors: string[];
  running: boolean;
  finished: boolean;
  refreshing: boolean;
  refreshed: boolean;
  duplicatesRemoved: number | null;
  pruned: number | null;
};

const BATCH_SIZE = 1000;

function initialStatus(): Status {
  return {
    fileName: "",
    detectedEncoding: "",
    totalRows: 0,
    sentRows: 0,
    totalBatches: 0,
    doneBatches: 0,
    errors: [],
    running: false,
    finished: false,
    refreshing: false,
    refreshed: false,
    duplicatesRemoved: null,
    pruned: null,
  };
}

async function callRefreshApi(): Promise<string | null> {
  try {
    const res = await fetch("/api/refresh", { method: "POST" });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json.error ?? res.statusText ?? "不明なエラー";
    }
    return null;
  } catch (e) {
    return String(e);
  }
}

/**
 * アップロードされたファイルの文字コードを自動判定して読み込む。
 *
 * 基幹システムから直接落としたCSVはShift_JIS(CP932)だが、
 * 大きいファイルを分割・再保存する過程でUTF-8に変わってしまうことがある。
 * 「Shift_JISのはず」と決め打ちすると、UTF-8のファイルを渡された時に
 * 文字化けする(UTF-8のバイト列をShift_JISとして誤読してしまう)ため、
 * 実際のバイト列を見て判定する。
 *
 * 判定方法:
 * 1. 先頭にUTF-8のBOM(EF BB BF)があれば、UTF-8として読む。
 * 2. BOMが無ければ、まず厳密モード(fatal: true)でUTF-8として読んでみる。
 *    これが成功すれば、そのファイルは有効なUTF-8バイト列だったということなので
 *    UTF-8として扱う。実際のShift_JIS(CP932)のファイルは、日本語部分が
 *    ほぼ確実にこの厳密なUTF-8デコードに失敗する(バイトパターンが異なるため)。
 * 3. 厳密UTF-8デコードが失敗した場合は、Shift_JIS(CP932)として読む。
 */
async function readFileSmart(file: File): Promise<{ text: string; encoding: string }> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(buf), encoding: "UTF-8 (BOM付き)" };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text, encoding: "UTF-8" };
  } catch {
    const text = new TextDecoder("shift_jis").decode(buf);
    return { text, encoding: "Shift_JIS (CP932)" };
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function UploadForm() {
  const [salesStatus, setSalesStatus] = useState<Status>(initialStatus());
  const [purchaseStatus, setPurchaseStatus] = useState<Status>(initialStatus());
  const [transferStatus, setTransferStatus] = useState<Status>(initialStatus());
  const [shippingNoteStatus, setShippingNoteStatus] = useState<Status>(initialStatus());
  const [dragOver, setDragOver] = useState<Record<Kind, boolean>>({
    sales: false,
    purchase: false,
    transfer: false,
    shippingNote: false,
  });

  async function handleFile(kind: Kind, file: File) {
    const setStatus =
      kind === "sales"
        ? setSalesStatus
        : kind === "purchase"
        ? setPurchaseStatus
        : kind === "transfer"
        ? setTransferStatus
        : setShippingNoteStatus;
    setStatus({ ...initialStatus(), fileName: file.name, running: true });

    let text: string;
    let encoding: string;
    try {
      const result = await readFileSmart(file);
      text = result.text;
      encoding = result.encoding;
    } catch (e) {
      setStatus((s) => ({
        ...s,
        running: false,
        finished: true,
        errors: [...s.errors, `ファイルの読み込みに失敗しました: ${String(e)}`],
      }));
      return;
    }
    setStatus((s) => ({ ...s, detectedEncoding: encoding }));

    const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
    const dataRows = parsed.data.slice(1); // 1行目はヘッダー行なので除外

    const mapper =
      kind === "sales" ? mapSalesRow : kind === "purchase" ? mapPurchaseRow : kind === "transfer" ? mapTransferRow : mapShippingNoteRow;
    const mapped = dataRows
      .map((cols) => mapper(cols))
      .filter(
        (r): r is SalesRowInsert | PurchaseRowInsert | TransferRowInsert | ShippingNoteRowInsert => r !== null
      );

    // transfer(社内間・未納品の拠点間移動)は、対象外の行が最初から捨てられる設計
    // (手配区分=在庫の行のうち、拠点90/91宛は無条件、それ以外は納入先名1に「太幸」を
    // 含む行だけが残る)なので、0件でも異常ではない(該当する移動が無かった、というだけ)。
    // エラー扱いにしない。
    if (mapped.length === 0 && kind !== "transfer") {
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

    const endpoint =
      kind === "sales"
        ? "/api/upload/sales"
        : kind === "purchase"
        ? "/api/upload/purchase"
        : kind === "transfer"
        ? "/api/upload/transfer"
        : "/api/upload/shipping-note";
    let sent = 0;
    const errors: string[] = [];

    if (kind === "transfer") {
      // 全件洗い替え方式。件数が少ない想定なので分割せず1回で送る。
      setStatus((s) => ({ ...s, totalRows: mapped.length, totalBatches: 1 }));
      let duplicatesRemoved: number | null = null;
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: mapped }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          errors.push(json.error ?? res.statusText);
        } else {
          sent = typeof json.inserted === "number" ? json.inserted : mapped.length;
          duplicatesRemoved = typeof json.duplicatesRemoved === "number" ? json.duplicatesRemoved : null;
        }
      } catch (e) {
        errors.push(String(e));
      }
      setStatus((s) => ({ ...s, sentRows: sent, doneBatches: 1, errors: [...errors], duplicatesRemoved }));
      setStatus((s) => ({ ...s, running: false, finished: true }));
      return;
    }

    if (kind === "shippingNote") {
      // 蓄積(upsert)方式。2026-08-06判明: 実データ(3万件超)では1回で送ると
      // リクエストボディが大きくなりすぎ、サーバーに届く前に失敗してしまう
      // (エラーメッセージも空になる)ことを確認したため、他の種類と同様に
      // 1000件ずつのバッチに分割して送信する。値上げ検知・利益集計の更新
      // (callRefreshApi)はこのデータと無関係なので行わない。
      const batches = chunk(mapped, BATCH_SIZE);
      setStatus((s) => ({ ...s, totalRows: mapped.length, totalBatches: batches.length }));
      let pruned: number | null = null;

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
            sent += typeof json.inserted === "number" ? json.inserted : batches[i].length;
            if (typeof json.pruned === "number") pruned = (pruned ?? 0) + json.pruned;
          }
        } catch (e) {
          errors.push(`バッチ${i + 1}/${batches.length}: ${String(e)}`);
        }
        setStatus((s) => ({ ...s, sentRows: sent, doneBatches: i + 1, errors: [...errors], pruned }));
      }

      setStatus((s) => ({ ...s, running: false, finished: true }));
      return;
    }

    const batches = chunk(mapped, BATCH_SIZE);
    setStatus((s) => ({ ...s, totalRows: mapped.length, totalBatches: batches.length }));

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

    // アップロードが1件でも成功していれば、値上げ検知・売上利益の集計(マテリアライズドビュー)を更新する
    if (sent > 0) {
      setStatus((s) => ({ ...s, refreshing: true }));
      const refreshError = await callRefreshApi();
      setStatus((s) => ({
        ...s,
        refreshing: false,
        refreshed: !refreshError,
        errors: refreshError ? [...s.errors, `集計の更新に失敗しました: ${refreshError}`] : s.errors,
      }));
    }

    setStatus((s) => ({ ...s, running: false, finished: true }));
  }

  function renderBlock(
    kind: Kind,
    label: string,
    hint: string,
    status: Status,
    mode: "batch" | "replace" | "accumulate" = "batch"
  ) {
    const replaceMode = mode === "replace";
    const isDragOver = dragOver[kind];
    return (
      <div
        className="card"
        style={{ marginBottom: 20 }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!status.running) setDragOver((d) => ({ ...d, [kind]: true }));
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!status.running) setDragOver((d) => ({ ...d, [kind]: true }));
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragOver((d) => ({ ...d, [kind]: false }));
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver((d) => ({ ...d, [kind]: false }));
          if (status.running) return;
          const f = e.dataTransfer.files?.[0];
          if (f) handleFile(kind, f);
        }}
      >
        <h2 style={{ marginTop: 0 }}>{label}</h2>
        <p className="subtitle" style={{ margin: "0 0 12px" }}>
          {hint}
        </p>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "22px 12px",
            borderRadius: 8,
            border: isDragOver ? "2px dashed var(--direct)" : "2px dashed var(--border, #d0d5dd)",
            background: isDragOver ? "rgba(37, 99, 235, 0.06)" : "transparent",
            cursor: status.running ? "default" : "pointer",
            textAlign: "center",
            transition: "border-color 0.1s, background 0.1s",
          }}
        >
          <span style={{ fontSize: 13, color: isDragOver ? "var(--direct)" : undefined }}>
            {isDragOver ? "ここにドロップ" : "ここにCSVをドラッグ&ドロップ、またはクリックして選択"}
          </span>
          <input
            type="file"
            accept=".csv"
            disabled={status.running}
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleFile(kind, f);
              e.target.value = "";
            }}
          />
        </label>
        {status.fileName && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div>ファイル: {status.fileName}</div>
            {status.detectedEncoding && <div>判定した文字コード: {status.detectedEncoding}</div>}
            {(status.totalRows > 0 || (mode !== "batch" && status.finished)) && (
              <div>
                {mode === "replace"
                  ? `対象行(手配区分=在庫のうち、拠点90/91宛または納入先名1に「太幸」を含む行): ${status.totalRows.toLocaleString("ja-JP")}件`
                  : `読み込んだ行数: ${status.totalRows.toLocaleString("ja-JP")}件 ／ 送信済み: ${status.sentRows.toLocaleString("ja-JP")}件 ／ バッチ ${status.doneBatches}/${status.totalBatches}`}
              </div>
            )}
            {status.running && !status.refreshing && (
              <div style={{ color: "var(--direct)", marginTop: 4 }}>
                {mode === "replace" ? "置き換え中…" : mode === "accumulate" ? "取り込み中…" : "アップロード中…"}
              </div>
            )}
            {status.refreshing && (
              <div style={{ color: "var(--direct)", marginTop: 4 }}>
                値上げ検知・売上利益の集計を更新中…(数十秒かかる場合があります)
              </div>
            )}
            {status.finished && status.errors.length === 0 && (
              <div style={{ color: "var(--good)", marginTop: 4 }}>
                {mode === "replace"
                  ? `完了しました。既存データを削除し、${status.sentRows.toLocaleString("ja-JP")}件で置き換えました。`
                  : mode === "accumulate"
                  ? `完了しました。${status.sentRows.toLocaleString("ja-JP")}件を取り込みました(送り状番号が同じ行は上書き)。`
                  : "完了しました。"}
                {status.refreshed && "値上げ検知・売上利益の集計も更新済みです。"}
                {replaceMode && status.duplicatesRemoved !== null && status.duplicatesRemoved > 0 && (
                  <div style={{ color: "var(--direct)" }}>
                    うち、受注番号・受注行番号が重複していた{status.duplicatesRemoved.toLocaleString("ja-JP")}件は自動的に1件にまとめて取り込みました(金額の二重計上を防止)。
                  </div>
                )}
                {mode === "accumulate" && status.pruned !== null && status.pruned > 0 && (
                  <div style={{ color: "var(--direct)" }}>
                    あわせて、発行日が3か月より前の古いデータ{status.pruned.toLocaleString("ja-JP")}件を削除しました。
                  </div>
                )}
              </div>
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
      <a
        href="/data-status"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginBottom: 16 }}
      >
        データ更新状況を見る(最新のデータがどこまで入っているか)
      </a>
      {renderBlock("sales", "売上データ", "uriage.csvと同じ列構成のCSVを選択してください。", salesStatus)}
      {renderBlock(
        "purchase",
        "仕入データ",
        "仕入実績データと同じ列構成のCSVを選択してください(仕入先名1・仕入番号・仕入行番号などを含む55列)。",
        purchaseStatus
      )}
      {renderBlock(
        "transfer",
        "社内間(未納品の拠点間移動)",
        "受注出力CSV(受注データ、売上データと同じ54列構成)を選択してください。手配区分=在庫かつ納入先名1に「太幸」を含む行だけを取り込みます。アップロードのたびに既存データを全件削除してから置き換えます(今この瞬間のスナップショットとして扱うため)。受注番号・受注行番号が同じ行が万一含まれていても自動的に1件にまとめるため、重複計上の心配はありません。",
        transferStatus,
        "replace"
      )}
      {renderBlock(
        "shippingNote",
        "送り状問合せデータ(運賃照合用)",
        "送り状問合せCSVを選択してください(得意先コード・受注番号・運送会社名・送り状番号などを含む列構成)。送り状番号をキーに蓄積(upsert)され、発行日が3か月より前の古いデータは自動的に削除されます。",
        shippingNoteStatus,
        "accumulate"
      )}
      <a
        href="/benrinet-check"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        べんりネット照合
      </a>
      <a
        href="/payable-check"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        買掛月報照合
      </a>
      <a
        href="/life-check"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        ライフ照合
      </a>
      <a
        href="/life-billing-check"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        ライフ請求金額照合
      </a>
      <a
        href="/freight-check"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        運賃照合
      </a>
      <a
        href="/data-status"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        データ更新状況
      </a>
      <a href="/menu" className="ghost-btn" style={{ display: "inline-block", textDecoration: "none" }}>
        ← メニューに戻る
      </a>
    </div>
  );
}
