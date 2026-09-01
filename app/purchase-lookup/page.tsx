"use client";
import { useState } from "react";

type SupplierPriceRow = {
  supplier_name: string;
  unit_price: number | null;
  purchase_date: string;
};
type PurchaseHistoryRow = {
  purchase_date: string;
  supplier_name: string | null;
  unit_price: number | null;
  purchase_number: string;
  purchase_line: string;
  customer_name: string | null;
  sell_price: number | null;
  delivery_note_no: string | null;
  freight_amount: number | null;
};
type MasterInfo = {
  product_name: string;
  product_kana: string | null;
  is_deleted: boolean;
  primary_supplier_code: string | null;
  primary_supplier_name: string | null;
  primary_supplier_price: number | null;
  secondary_supplier_code: string | null;
  secondary_supplier_name: string | null;
  secondary_supplier_price: number | null;
};
type ProductSearchResult = {
  product_code: string;
  product_name: string;
  master: MasterInfo | null;
  masterMismatch: string | null;
  latestBySupplier: SupplierPriceRow[];
  history: PurchaseHistoryRow[];
};
type SearchOutcome = {
  results: ProductSearchResult[];
  truncated: boolean;
};

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function isOld(dateStr: string): boolean {
  return Date.now() - new Date(dateStr).getTime() > ONE_YEAR_MS;
}
function yen(n: number | null): string {
  return n === null ? "-" : `${n.toLocaleString()}円`;
}

export default function PurchaseLookupPage() {
  const [mode, setMode] = useState<"code" | "keyword">("code");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch() {
    if (query.trim() === "") return;
    setLoading(true);
    setError(null);
    setOutcome(null);
    try {
      const params = new URLSearchParams({ mode, query: query.trim() });
      const res = await fetch(`/api/search-purchase-prices?${params.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? `検索に失敗しました(status ${res.status})`);
      setOutcome(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleReset() {
    setQuery("");
    setOutcome(null);
    setError(null);
  }

  return (
    <div className="page">
      <h1>仕入価格検索</h1>
      <p className="subtitle">
        品番の完全一致、または品名のキーワード(あいまい検索)で仕入実績を調べます。データはrieki-check自身が持つ直近の仕入・売上データ(保持期間内)のみが対象です。
      </p>

      <div style={{ display: "flex", gap: 16, marginBottom: 16, alignItems: "center" }}>
        <label style={{ fontSize: 13 }}>
          <input type="radio" checked={mode === "code"} onChange={() => setMode("code")} /> 品番で検索(完全一致)
        </label>
        <label style={{ fontSize: 13 }}>
          <input type="radio" checked={mode === "keyword"} onChange={() => setMode("keyword")} /> 品名で検索(キーワードのあいまい検索)
        </label>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder={mode === "code" ? "品番を入力" : "品名のキーワードを入力(スペース区切りで複数語OK)"}
          style={{ flex: 1, padding: "8px 12px", fontSize: 14, border: "1px solid var(--border)", borderRadius: 6 }}
        />
        <button
          onClick={handleSearch}
          disabled={loading || query.trim() === ""}
          style={{
            padding: "8px 20px",
            borderRadius: 6,
            border: "1px solid var(--direct)",
            background: loading || query.trim() === "" ? "#c3d6f8" : "var(--direct)",
            color: "#fff",
            cursor: loading || query.trim() === "" ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "検索中…" : "検索"}
        </button>
        <button onClick={handleReset} disabled={loading} className="ghost-btn">
          リセット
        </button>
      </div>

      {error && <p style={{ color: "var(--critical)" }}>❌ {error}</p>}
      {outcome && outcome.results.length === 0 && !error && (
        <p style={{ color: "var(--text-muted)" }}>該当する商品が見つかりませんでした。</p>
      )}
      {outcome?.truncated && (
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 12 }}>
          ヒット件数が多いため、先頭20件のみ表示しています。キーワードを絞り込んでください。
        </p>
      )}

      {outcome?.results.map((r) => (
        <ProductCard key={r.product_code} result={r} />
      ))}
    </div>
  );
}

function ProductCard({ result }: { result: ProductSearchResult }) {
  const hasHistory = result.history.length > 0;
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <h2
        style={{
          fontSize: 16,
          margin: "0 0 14px",
          paddingBottom: 10,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {result.product_code} {result.product_name}
        {result.master?.is_deleted && (
          <span className="badge warning" style={{ marginLeft: 8 }}>
            商品マスタ上は削除フラグあり
          </span>
        )}
      </h2>

      {result.master && (
        <div
          className="card"
          style={{ marginBottom: 16, padding: "10px 12px", background: "rgba(37, 99, 235, 0.04)" }}
        >
          <h3 style={{ fontSize: 13, margin: "0 0 6px" }}>商品マスタ登録情報</h3>
          <div style={{ fontSize: 13, display: "grid", gridTemplateColumns: "auto 1fr", rowGap: 4, columnGap: 10 }}>
            {result.master.product_kana && (
              <>
                <span style={{ color: "var(--text-muted)" }}>カナ品名</span>
                <span>{result.master.product_kana}</span>
              </>
            )}
            <span style={{ color: "var(--text-muted)" }}>実仕入先</span>
            <span>
              {result.master.primary_supplier_name ?? (result.master.primary_supplier_code ? `コード:${result.master.primary_supplier_code}(仕入先マスタ未登録)` : "-")}
              {result.master.primary_supplier_price !== null && ` / ${yen(result.master.primary_supplier_price)}`}
            </span>
            {(result.master.secondary_supplier_name || result.master.secondary_supplier_code) && (
              <>
                <span style={{ color: "var(--text-muted)" }}>副仕入先</span>
                <span>
                  {result.master.secondary_supplier_name ?? `コード:${result.master.secondary_supplier_code}(仕入先マスタ未登録)`}
                  {result.master.secondary_supplier_price !== null && ` / ${yen(result.master.secondary_supplier_price)}`}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {result.masterMismatch && (
        <p style={{ color: "var(--critical)", fontSize: 13, marginBottom: 12 }}>⚠ {result.masterMismatch}</p>
      )}

      {hasHistory ? (
        <>
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>
            仕入先ごとの最新価格({result.latestBySupplier.length}社)
          </h3>
          <table style={{ marginBottom: 16, tableLayout: "auto" }}>
            <thead>
              <tr>
                <th>仕入先</th>
                <th>単価</th>
                <th>最終仕入日</th>
              </tr>
            </thead>
            <tbody>
              {result.latestBySupplier.map((s) => (
                <tr key={s.supplier_name} style={{ background: isOld(s.purchase_date) ? "#fff3e0" : undefined }}>
                  <td>{s.supplier_name}</td>
                  <td>{yen(s.unit_price)}</td>
                  <td>{s.purchase_date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16 }}>仕入実績がありません。</p>
      )}

      {hasHistory && (
        <>
          <h3 style={{ fontSize: 13, marginBottom: 6 }}>仕入実績(全{result.history.length}件、新しい順)</h3>
          <table style={{ tableLayout: "auto" }}>
            <thead>
              <tr>
                <th>日付</th>
                <th>仕入先</th>
                <th>単価</th>
                <th>伝票番号</th>
                <th>得意先</th>
                <th>売値</th>
                <th>運賃(仕入)</th>
              </tr>
            </thead>
            <tbody>
              {result.history.map((h) => (
                <tr
                  key={`${h.purchase_number}_${h.purchase_line}`}
                  style={{ background: isOld(h.purchase_date) ? "#fff3e0" : undefined }}
                >
                  <td>{h.purchase_date}</td>
                  <td>{h.supplier_name ?? "-"}</td>
                  <td>{yen(h.unit_price)}</td>
                  <td>{h.purchase_number}-{h.purchase_line}</td>
                  <td>{h.customer_name ?? "-"}</td>
                  <td>{yen(h.sell_price)}</td>
                  <td>{h.freight_amount !== null ? yen(h.freight_amount) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
