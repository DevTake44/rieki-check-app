"use client";

import { useState } from "react";
import Papa from "papaparse";
import { mapSalesRow, mapPurchaseRow, mapTransferRow, mapShippingNoteRow } from "@/lib/row-mapping";
import type { SalesRowInsert, PurchaseRowInsert, TransferRowInsert, ShippingNoteRowInsert } from "@/lib/row-mapping";
import { transformProductMasterCsv } from "@/lib/productMasterTransform";
import { transformSupplierMasterCsv } from "@/lib/supplierMasterTransform";
import Link from "next/link";
import { clearProfitCache } from "@/lib/profit-cache";

type Kind = "sales" | "purchase" | "transfer" | "shippingNote";

// 2026-08-28追加: 「受注番号+受注行番号+品番+数量+単価」は既存行と同じだが
// 納品書番号(または納品書行番号)だけが違う、二重登録の疑いがある行の情報。
// /api/upload/sales が検知して返してくる(削除はせず警告のみ)。
type DuplicateWarning = {
  order_no: string;
  order_line: string;
  item_code: string | null;
  qty: number | null;
  sell_price: number | null;
  delivery_date: string | null;
  incoming_delivery_note_no: string | null;
  incoming_delivery_note_line: string | null;
  existing_delivery_note_no: string | null;
  existing_delivery_note_line: string | null;
};

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
  duplicateWarnings: DuplicateWarning[];
  duplicateCandidateTotal: number;
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
    duplicateWarnings: [],
    duplicateCandidateTotal: 0,
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

// 商品マスタ・仕入先マスタは、上の4種類(列番号ベース)と違い、
// 見出し行(ヘッダー)付きのCSVをそのまま読み込む(Papa.parseにheader:trueを渡す)。
// 全件洗い替え(upsert)方式で、件数も少なめなので進捗表示は簡略化している。
type MasterKind = "productMaster" | "supplierMaster";

type MasterStatus = {
  fileName: string;
  detectedEncoding: string;
  totalRows: number;
  sentRows: number;
  totalBatches: number;
  doneBatches: number;
  skipped: string[];
  errors: string[];
  running: boolean;
  finished: boolean;
};

const MASTER_BATCH_SIZE = 1000;

function initialMasterStatus(): MasterStatus {
  return {
    fileName: "",
    detectedEncoding: "",
    totalRows: 0,
    sentRows: 0,
    totalBatches: 0,
    doneBatches: 0,
    skipped: [],
    errors: [],
    running: false,
    finished: false,
  };
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
  const [productMasterStatus, setProductMasterStatus] = useState<MasterStatus>(initialMasterStatus());
  const [supplierMasterStatus, setSupplierMasterStatus] = useState<MasterStatus>(initialMasterStatus());
  const [masterDragOver, setMasterDragOver] = useState<Record<MasterKind, boolean>>({
    productMaster: false,
    supplierMaster: false,
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

    // 売上データのときだけ、/api/upload/sales が返してくる重複候補の警告を積み上げる。
    const allDuplicateWarnings: DuplicateWarning[] = [];
    let duplicateCandidateTotal = 0;

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
          if (kind === "sales") {
            if (Array.isArray(json.duplicateWarnings)) {
              allDuplicateWarnings.push(...(json.duplicateWarnings as DuplicateWarning[]));
            }
            if (typeof json.duplicateCandidateTotal === "number") {
              duplicateCandidateTotal += json.duplicateCandidateTotal;
            }
          }
        }
      } catch (e) {
        errors.push(`バッチ${i + 1}/${batches.length}: ${String(e)}`);
      }
      setStatus((s) => ({
        ...s,
        sentRows: sent,
        doneBatches: i + 1,
        errors: [...errors],
        duplicateWarnings: allDuplicateWarnings.slice(0, 50),
        duplicateCandidateTotal,
      }));
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
      // 2026-08-27追加: 売上利益画面はブラウザ内にデータをキャッシュしているため、
      // ここでアップロード(=データが変わった)が成功した以上、古いキャッシュを
      // 残したままにすると更新前の数字が表示され続けてしまう。取り込んだデータの
      // 反映を確実にするため、成功したらキャッシュを破棄し、次に売上利益を開いたときは
      // 必ず最新データを読み直すようにする。
      if (!refreshError) {
        clearProfitCache();
      }
    }

    setStatus((s) => ({ ...s, running: false, finished: true }));
  }

  async function handleMasterFile(kind: MasterKind, file: File) {
    const setStatus = kind === "productMaster" ? setProductMasterStatus : setSupplierMasterStatus;
    setStatus({ ...initialMasterStatus(), fileName: file.name, running: true });

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

    // このCSVは見出し行(ヘッダー)付きなので、列番号ではなく列名で読み込む。
    const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
    const raw = parsed.data;

    const { rows, skipped }: { rows: (import("@/lib/productMasterTransform").ProductMasterRow | import("@/lib/supplierMasterTransform").SupplierMasterRow)[]; skipped: string[] } =
      kind === "productMaster" ? transformProductMasterCsv(raw) : transformSupplierMasterCsv(raw);

    if (rows.length === 0) {
      setStatus((s) => ({
        ...s,
        running: false,
        finished: true,
        skipped,
        errors: [
          ...s.errors,
          "有効なデータ行が1件も見つかりませんでした。見出し行の列名(品番・品名など、または仕入先コード・仕入先名上段など)を確認してください。",
        ],
      }));
      return;
    }

    const endpoint = kind === "productMaster" ? "/api/upload/product-master" : "/api/upload/supplier-master";
    const batches = chunk(rows, MASTER_BATCH_SIZE);
    setStatus((s) => ({ ...s, totalRows: rows.length, totalBatches: batches.length, skipped }));

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
          sent += typeof json.inserted === "number" ? json.inserted : batches[i].length;
        }
      } catch (e) {
        errors.push(`バッチ${i + 1}/${batches.length}: ${String(e)}`);
      }
      setStatus((s) => ({ ...s, sentRows: sent, doneBatches: i + 1, errors: [...errors] }));
    }

    setStatus((s) => ({ ...s, running: false, finished: true }));
  }

  function renderMasterBlock(kind: MasterKind, label: string, hint: string, status: MasterStatus) {
    const isDragOver = masterDragOver[kind];
    return (
      <div
        className="card"
        style={{ marginBottom: 20 }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!status.running) setMasterDragOver((d) => ({ ...d, [kind]: true }));
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          if (!status.running) setMasterDragOver((d) => ({ ...d, [kind]: true }));
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setMasterDragOver((d) => ({ ...d, [kind]: false }));
        }}
        onDrop={(e) => {
          e.preventDefault();
          setMasterDragOver((d) => ({ ...d, [kind]: false }));
          if (status.running) return;
          const f = e.dataTransfer.files?.[0];
          if (f) handleMasterFile(kind, f);
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
              if (f) handleMasterFile(kind, f);
              e.target.value = "";
            }}
          />
        </label>
        {status.fileName && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div>ファイル: {status.fileName}</div>
            {status.detectedEncoding && <div>判定した文字コード: {status.detectedEncoding}</div>}
            {status.totalRows > 0 && (
              <div>
                読み込んだ行数: {status.totalRows.toLocaleString("ja-JP")}件 ／ 送信済み:{" "}
                {status.sentRows.toLocaleString("ja-JP")}件 ／ バッチ {status.doneBatches}/{status.totalBatches}
              </div>
            )}
            {status.running && (
              <div style={{ color: "var(--direct)", marginTop: 4 }}>取り込み中(全件洗い替え)…</div>
            )}
            {status.finished && status.errors.length === 0 && status.totalRows > 0 && (
              <div style={{ color: "var(--good)", marginTop: 4 }}>
                完了しました。{status.sentRows.toLocaleString("ja-JP")}件を反映しました(同じコードの行は上書き)。
              </div>
            )}
            {status.skipped.length > 0 && (
              <div style={{ color: "var(--direct)", marginTop: 4 }}>
                {status.skipped.length.toLocaleString("ja-JP")}行を除外しました(先頭の例:{" "}
                {Array.from(new Set(status.skipped)).slice(0, 3).join(" / ")})。
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
            {kind === "sales" && status.finished && status.duplicateCandidateTotal > 0 && (
              <div
                className="card"
                style={{ marginTop: 10, padding: "10px 12px", background: "rgba(220,180,40,0.08)" }}
              >
                <span className="badge warning">二重登録の疑いあり</span>
                <span style={{ marginLeft: 8 }}>
                  受注番号・受注行番号・品番・数量・単価は同じなのに、納品書番号だけが違う行が
                  {status.duplicateCandidateTotal.toLocaleString("ja-JP")}件見つかりました。
                  同じ出荷が納品書番号を変えて2回登録されている(=売上が二重計上されている)可能性があります。
                  ただし、取消(マイナス)行とセットで正しく相殺される訂正や、実際に複数回に分けて出荷しただけの
                  正当なケースも混ざるため、自動では削除していません。内容を見て、本当に重複しているものだけ手動で削除してください。
                </span>
                <div className="table-scroll" style={{ marginTop: 8 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>受注番号</th>
                        <th>行</th>
                        <th>品番</th>
                        <th className="num">数量</th>
                        <th className="num">単価</th>
                        <th>納品日</th>
                        <th>今回の納品書番号</th>
                        <th>既存の納品書番号</th>
                      </tr>
                    </thead>
                    <tbody>
                      {status.duplicateWarnings.map((w, i) => (
                        <tr key={i}>
                          <td>{w.order_no}</td>
                          <td>{w.order_line}</td>
                          <td>{w.item_code ?? "—"}</td>
                          <td className="num">{w.qty ?? "—"}</td>
                          <td className="num">{w.sell_price ?? "—"}</td>
                          <td>{w.delivery_date ?? "—"}</td>
                          <td>
                            {w.incoming_delivery_note_no ?? "—"}
                            {w.incoming_delivery_note_line ? `-${w.incoming_delivery_note_line}` : ""}
                          </td>
                          <td>
                            {w.existing_delivery_note_no ?? "—"}
                            {w.existing_delivery_note_line ? `-${w.existing_delivery_note_line}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {status.duplicateCandidateTotal > status.duplicateWarnings.length && (
                  <p className="cell-sub" style={{ marginTop: 6 }}>
                    上位{status.duplicateWarnings.length}件のみ表示しています(該当は全部で
                    {status.duplicateCandidateTotal.toLocaleString("ja-JP")}件)。
                  </p>
                )}
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
      <Link
        href="/data-status"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginBottom: 16 }}
      >
        データ更新状況を見る(最新のデータがどこまで入っているか)
      </Link>
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
      {renderMasterBlock(
        "productMaster",
        "商品マスタ",
        "見出し行付きのCSVを選択してください(品番・品名・カナ品名・実仕入先・仕入基準単価（バラ）・副仕入先・副仕入単価・削除フラグ・更新年月日)。品番をキーに全件洗い替え(upsert)します。仕入価格検索で、まだ仕入実績が無い商品コードでも「未登録」ではなく「登録済みだが実績なし」と正しく表示するために使います。",
        productMasterStatus
      )}
      {renderMasterBlock(
        "supplierMaster",
        "仕入先マスタ",
        "見出し行付きのCSVを選択してください(仕入先コード・仕入先名上段・仕入先名下段・削除フラグ)。仕入先コードをキーに全件洗い替え(upsert)します。商品マスタの実仕入先コードから仕入先名を表示するために使います。",
        supplierMasterStatus
      )}
      <Link
        href="/benrinet-check"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        べんりネット照合
      </Link>
      <Link
        href="/payable-check"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        買掛月報照合
      </Link>
      <Link
        href="/life-check"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        ライフ照合
      </Link>
      <Link
        href="/life-billing-check"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        ライフ請求金額照合
      </Link>
      <Link
        href="/freight-check"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        運賃照合
      </Link>
      <Link
        href="/data-status"
        className="ghost-btn"
        style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
      >
        データ更新状況
      </Link>
      <Link href="/menu" className="ghost-btn" style={{ display: "inline-block", textDecoration: "none" }}>
        ← メニューに戻る
      </Link>
    </div>
  );
}
