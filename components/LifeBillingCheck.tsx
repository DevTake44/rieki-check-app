"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";

/**
 * ライフ請求金額照合ダッシュボード
 *
 * ライフの受領実績CSV(output.csv、ライフ照合と同じ形式)の計上日(P列)を月単位で集計した金額と、
 * 太幸の請求出力CSV(べんりネット照合の自社請求データCSVと同じ形式・客先注番+受注行番号のキー)の
 * 金額を突き合わせる。月末締めのため、計上日が月をまたぐ場合は対象月を選べるようにする。
 * データはどこにも保存しない(その場限りの照合)。
 *
 * ■ 商品行の突き合わせ方
 * 1. 他伝票No(ライフ) = 客先注番(太幸)の完全一致キーで対応する太幸の行(複数あれば合算)を探す。
 *    同じ他伝票Noを持つライフ行が複数ある場合も合算してから比較する(実データで、1受注に
 *    2商品が含まれ、ライフ側では2行に分かれるケースを確認したため)。
 * 2. 見つからない場合は、納品日+店舗名で候補の太幸受注を探すフォールバックを行う
 *    (ライフ照合と同じロジック)。ただし金額の自動判定はできないため「要確認」として提示する。
 *
 * ■ 送料・運賃の突き合わせ方(太幸が追加で送料を計上している分の見つけ方)
 * ライフの「送料」行自体には商品コード・他伝票Noが空欄で入っておらず、太幸の運賃行(品番"99")の
 * ような明確なキーでは突き合わせられない。ただし実データを調べたところ、ライフの送料行には
 * 「概要」列に対象商品名が入っている(直前行の送料の場合は「上記送料」等と省略され、直前の
 * 商品行の概要を参照する形になっている)ことが分かった。そこで、店舗(店コード/店名 ⇔ 納入先名１)
 * ＋概要と品名の類似度で、太幸の運賃行1件ごとにライフの送料行を1件ずつ突き合わせる
 * (総当たりで最も類似度が高い組み合わせから確定していく)。一致しなかった太幸側の運賃は、
 * まだライフのシステムに送料が追加されていない受注の候補として一覧表示する。
 */

type LifeLine = {
  key: string;
  slipNo: string;
  lineNo: string;
  postingDate: string;
  postingMonth: string;
  storeCode: string;
  storeName: string;
  itemName: string;
  qty: number;
  price: number;
  amount: number;
  otherSlipNo: string;
  isFreight: boolean;
  // 送料行のみ使用。「概要」列を解決した実質的な対象商品名(直前行参照の解決込み)。
  freightItemDesc: string;
};

type TaikoLine = {
  key: string;
  customerOrderNo: string;
  lineNo: string;
  orderNo: string;
  customerCode: string;
  deliveryName: string;
  itemName: string;
  qty: number;
  price: number;
  amount: number;
  orderDate: string;
  deliveryDate: string;
  subject: string;
  isFreight: boolean;
};

type FileState = {
  fileName: string;
  encoding: string;
  loading: boolean;
  error: string | null;
};

function initialFileState(): FileState {
  return { fileName: "", encoding: "", loading: false, error: null };
}

// ライフコーポレーションの得意先コード(参考: べんりネットは 210302999)。
const LIFE_CUSTOMER_CODE = "210970188";

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

function toNum(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function fmtYen(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "―";
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toHalfWidth(s: string): string {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

function normalizeDate(s: string): string {
  return s.replace(/[^\d]/g, "");
}

function normalizeStoreName(s: string): string {
  return toHalfWidth(s)
    .replace(/ライフ/g, "")
    .replace(/[\s　]+/g, "")
    .replace(/[0-9]+/g, "");
}

function storeMatches(lifeStoreCode: string, lifeStoreName: string, taikoDeliveryName: string): boolean {
  const code = lifeStoreCode.trim();
  const halfWidthName = toHalfWidth(taikoDeliveryName);
  if (code && halfWidthName.includes(code)) return true;
  const a = normalizeStoreName(lifeStoreName);
  const b = normalizeStoreName(taikoDeliveryName);
  if (a && b && (b.includes(a) || a.includes(b))) return true;
  return false;
}

function normalizeItemName(s: string): string {
  return toHalfWidth(s).replace(/[\s　]+/g, "");
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  if (s.length <= 1) {
    if (s.length === 1) set.add(s);
    return set;
  }
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

function nameSimilarity(a: string, b: string): number {
  const A = bigrams(normalizeItemName(a));
  const B = bigrams(normalizeItemName(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach((x) => {
    if (B.has(x)) inter++;
  });
  return inter / (A.size + B.size - inter);
}

function findHeaderRow(rows: string[][], requiredCols: string[]): number {
  const scanLimit = Math.min(5, rows.length);
  for (let i = 0; i < scanLimit; i++) {
    const trimmed = rows[i].map((c) => c.trim());
    if (requiredCols.every((c) => trimmed.includes(c))) return i;
  }
  return -1;
}

function rowsToObjects(rows: string[][], headerIdx: number): Record<string, string>[] {
  const header = rows[headerIdx].map((c) => c.trim());
  return rows.slice(headerIdx + 1).map((row) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h) obj[h] = row[i] ?? "";
    });
    return obj;
  });
}

function monthOf(dateStr: string): string {
  const d = normalizeDate(dateStr);
  if (d.length < 6) return "";
  return `${d.slice(0, 4)}/${d.slice(4, 6)}`;
}

function parseLifeCsv(text: string): { records: LifeLine[]; warnings: string[] } {
  const rows = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
  const required = ["伝票Ｎｏ", "計上日", "店コード", "店名", "品名", "数量", "単価", "金額", "他伝票No"];
  const headerIdx = findHeaderRow(rows, required);
  if (headerIdx === -1) {
    return {
      records: [],
      warnings: ["必要な列を含むヘッダー行が見つかりませんでした。ライフの受領実績CSV(output.csv)で間違いないか確認してください。"],
    };
  }
  const objs = rowsToObjects(rows, headerIdx).filter((r) => (r["品名"] || "").trim() !== "");
  // 送料行の「概要」は、直前の商品行を指す省略表記(「上記送料」等)や空欄のことがあるため、
  // 伝票内で直前に出てきた商品行の概要(なければ品名)を引き継いで解決する。
  const lastDescBySlip = new Map<string, string>();
  const records: LifeLine[] = objs.map((r) => {
    const itemName = (r["品名"] || "").trim();
    const postingDate = (r["計上日"] || "").trim();
    const slipNo = (r["伝票Ｎｏ"] || "").trim();
    const isFreight = itemName === "送料";
    const desc = (r["概要"] || "").trim();
    let freightItemDesc = "";
    if (isFreight) {
      freightItemDesc = desc && !desc.includes("上記") && desc !== "送料" ? desc : lastDescBySlip.get(slipNo) || "";
    } else {
      lastDescBySlip.set(slipNo, desc || itemName);
    }
    return {
      key: `${slipNo}__${(r["行番号"] || "").trim()}`,
      slipNo,
      lineNo: (r["行番号"] || "").trim(),
      postingDate,
      postingMonth: monthOf(postingDate),
      storeCode: (r["店コード"] || "").trim(),
      storeName: (r["店名"] || "").trim(),
      itemName,
      qty: toNum(r["数量"]),
      price: toNum(r["単価"]),
      amount: toNum(r["金額"]),
      otherSlipNo: (r["他伝票No"] || "").trim(),
      isFreight,
      freightItemDesc,
    };
  });
  const warnings: string[] = [];
  if (records.length === 0) warnings.push("読み込める形式のデータ行が1件もありませんでした。");
  return { records, warnings };
}

function parseTaikoCsv(text: string): { records: TaikoLine[]; warnings: string[] } {
  const rows = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
  const required = ["受注番号", "客先注番", "受注行番号", "納入先名１", "品名", "受注総数量", "販売単価", "金額"];
  const headerIdx = findHeaderRow(rows, required);
  if (headerIdx === -1) {
    return {
      records: [],
      warnings: ["必要な列を含むヘッダー行が見つかりませんでした。太幸の請求出力CSV(べんりネット照合と同じ形式)で間違いないか確認してください。"],
    };
  }
  // 受注番号・品名がどちらも空欄の行(伝票消費税などの集計行)は除外する。
  const objs = rowsToObjects(rows, headerIdx).filter(
    (r) => (r["受注番号"] || "").trim() !== "" || (r["品名"] || "").trim() !== ""
  );
  const records: TaikoLine[] = objs.map((r) => {
    const itemNo = (r["品番"] || "").trim();
    const itemName = (r["品名"] || "").trim();
    return {
      key: `${(r["客先注番"] || "").trim()}__${(r["受注行番号"] || "").trim()}`,
      customerOrderNo: (r["客先注番"] || "").trim(),
      lineNo: (r["受注行番号"] || "").trim(),
      orderNo: (r["受注番号"] || "").trim(),
      customerCode: (r["得意先コード"] || "").trim(),
      deliveryName: (r["納入先名１"] || "").trim(),
      itemName,
      qty: toNum(r["受注総数量"]),
      price: toNum(r["販売単価"]),
      amount: toNum(r["金額"]),
      orderDate: (r["受注年月日"] || "").trim(),
      deliveryDate: (r["納品年月日"] || "").trim(),
      subject: (r["件名"] || "").trim(),
      isFreight: itemNo === "99" || itemName === "運賃",
    };
  });

  const warnings: string[] = [];
  if (records.length === 0) warnings.push("読み込める形式のデータ行が1件もありませんでした。");
  const otherCodes = new Map<string, number>();
  records.forEach((r) => {
    if (r.customerCode && r.customerCode !== LIFE_CUSTOMER_CODE) {
      otherCodes.set(r.customerCode, (otherCodes.get(r.customerCode) || 0) + 1);
    }
  });
  if (otherCodes.size > 0) {
    const detail = Array.from(otherCodes.entries())
      .map(([code, n]) => `${code}(${n}件)`)
      .join("、");
    warnings.push(
      `ライフの得意先コード(${LIFE_CUSTOMER_CODE})以外のデータが含まれています: ${detail}。ライフ向けの請求出力CSVで間違いないか確認してください。`
    );
  }
  return { records, warnings };
}

type MatchStatus = "match" | "amount_diff" | "need_check" | "taiko_not_found";

type LineResult = {
  key: string;
  lifeLines: LifeLine[];
  lifeAmount: number;
  taikoLines: TaikoLine[];
  taikoAmount: number;
  status: MatchStatus;
  matchType: "exact_key" | "date_store" | "none";
};

export default function LifeBillingCheck() {
  const [lifeState, setLifeState] = useState<FileState>(initialFileState());
  const [taikoState, setTaikoState] = useState<FileState>(initialFileState());
  const [lifeLines, setLifeLines] = useState<LifeLine[]>([]);
  const [taikoLines, setTaikoLines] = useState<TaikoLine[]>([]);
  const [lifeWarnings, setLifeWarnings] = useState<string[]>([]);
  const [taikoWarnings, setTaikoWarnings] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | MatchStatus>("all");
  const [targetMonth, setTargetMonth] = useState<string>("");
  const [dragOverLife, setDragOverLife] = useState(false);
  const [dragOverTaiko, setDragOverTaiko] = useState(false);

  async function handleLifeFile(file: File) {
    setLifeState({ ...initialFileState(), fileName: file.name, loading: true });
    try {
      const { text, encoding } = await readFileSmart(file);
      const { records, warnings } = parseLifeCsv(text);
      setLifeLines(records);
      setLifeWarnings(warnings);
      setLifeState({
        fileName: file.name,
        encoding,
        loading: false,
        error: records.length === 0 ? warnings[0] || "読み込みに失敗しました。" : null,
      });
      const months = Array.from(new Set(records.map((r) => r.postingMonth).filter(Boolean)));
      if (months.length > 0) {
        const counts = new Map<string, number>();
        records.forEach((r) => {
          if (r.postingMonth) counts.set(r.postingMonth, (counts.get(r.postingMonth) || 0) + 1);
        });
        const best = months.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0))[0];
        setTargetMonth(best);
      }
    } catch (e) {
      setLifeLines([]);
      setLifeState({ fileName: file.name, encoding: "", loading: false, error: String(e) });
    }
  }

  async function handleTaikoFile(file: File) {
    setTaikoState({ ...initialFileState(), fileName: file.name, loading: true });
    try {
      const { text, encoding } = await readFileSmart(file);
      const { records, warnings } = parseTaikoCsv(text);
      setTaikoLines(records);
      setTaikoWarnings(warnings);
      setTaikoState({
        fileName: file.name,
        encoding,
        loading: false,
        error: records.length === 0 ? warnings[0] || "読み込みに失敗しました。" : null,
      });
    } catch (e) {
      setTaikoLines([]);
      setTaikoState({ fileName: file.name, encoding: "", loading: false, error: String(e) });
    }
  }

  function reset() {
    setLifeState(initialFileState());
    setTaikoState(initialFileState());
    setLifeLines([]);
    setTaikoLines([]);
    setLifeWarnings([]);
    setTaikoWarnings([]);
    setSearch("");
    setStatusFilter("all");
    setTargetMonth("");
  }

  const monthOptions = useMemo(() => {
    const counts = new Map<string, number>();
    lifeLines.forEach((l) => {
      if (l.postingMonth) counts.set(l.postingMonth, (counts.get(l.postingMonth) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([month, count]) => ({ month, count }));
  }, [lifeLines]);

  const targetLifeLines = useMemo(() => lifeLines.filter((l) => l.postingMonth === targetMonth), [lifeLines, targetMonth]);

  // 太幸側は品番/客先注番ごとに合算しておく(1受注に商品行+運賃行が複数あるため)。
  const taikoByCustomerOrder = useMemo(() => {
    const map = new Map<string, TaikoLine[]>();
    taikoLines.forEach((t) => {
      if (!t.customerOrderNo) return;
      const arr = map.get(t.customerOrderNo) || [];
      arr.push(t);
      map.set(t.customerOrderNo, arr);
    });
    return map;
  }, [taikoLines]);

  const summary = useMemo(() => {
    const lifeItemTotal = targetLifeLines.filter((l) => !l.isFreight).reduce((s, l) => s + l.amount, 0);
    const lifeFreightTotal = targetLifeLines.filter((l) => l.isFreight).reduce((s, l) => s + l.amount, 0);
    const taikoItemTotal = taikoLines.filter((t) => !t.isFreight).reduce((s, t) => s + t.amount, 0);
    const taikoFreightTotal = taikoLines.filter((t) => t.isFreight).reduce((s, t) => s + t.amount, 0);
    return {
      lifeItemTotal,
      lifeFreightTotal,
      lifeTotal: lifeItemTotal + lifeFreightTotal,
      taikoItemTotal,
      taikoFreightTotal,
      taikoTotal: taikoItemTotal + taikoFreightTotal,
    };
  }, [targetLifeLines, taikoLines]);

  // 商品行(送料を除く)を他伝票Noでグループ化して太幸側と突き合わせる。
  const results: LineResult[] = useMemo(() => {
    const lifeByKey = new Map<string, LifeLine[]>();
    targetLifeLines
      .filter((l) => !l.isFreight)
      .forEach((l) => {
        const k = l.otherSlipNo || `__nokey__${l.key}`;
        const arr = lifeByKey.get(k) || [];
        arr.push(l);
        lifeByKey.set(k, arr);
      });

    return Array.from(lifeByKey.entries()).map(([k, group]) => {
      const lifeAmount = group.reduce((s, l) => s + l.amount, 0);
      const otherSlipNo = group[0].otherSlipNo;
      let taikoGroup: TaikoLine[] = [];
      let matchType: LineResult["matchType"] = "none";

      if (otherSlipNo && taikoByCustomerOrder.has(otherSlipNo)) {
        taikoGroup = taikoByCustomerOrder.get(otherSlipNo)!.filter((t) => !t.isFreight);
        matchType = "exact_key";
      } else {
        // フォールバック: 納品日+店舗名で候補を探す(自動的な金額判定はしない)。
        const normLifeDate = normalizeDate(group[0].postingDate);
        const candidateOrderNos = new Set<string>();
        taikoLines.forEach((t) => {
          if (t.isFreight) return;
          if (
            normalizeDate(t.deliveryDate) === normLifeDate &&
            storeMatches(group[0].storeCode, group[0].storeName, t.deliveryName) &&
            nameSimilarity(group[0].itemName, t.itemName) > 0.2
          ) {
            candidateOrderNos.add(t.customerOrderNo || t.orderNo);
          }
        });
        if (candidateOrderNos.size > 0) {
          taikoGroup = taikoLines.filter(
            (t) => !t.isFreight && candidateOrderNos.has(t.customerOrderNo || t.orderNo)
          );
          matchType = "date_store";
        }
      }

      const taikoAmount = taikoGroup.reduce((s, t) => s + t.amount, 0);
      let status: MatchStatus;
      if (taikoGroup.length === 0) {
        status = "taiko_not_found";
      } else if (matchType === "date_store") {
        status = "need_check";
      } else if (Math.abs(lifeAmount - taikoAmount) < 1) {
        status = "match";
      } else {
        status = "amount_diff";
      }

      return { key: k, lifeLines: group, lifeAmount, taikoLines: taikoGroup, taikoAmount, status, matchType };
    });
  }, [targetLifeLines, taikoByCustomerOrder, taikoLines]);

  const statusCounts = useMemo(() => {
    const c = { match: 0, amount_diff: 0, need_check: 0, taiko_not_found: 0 };
    results.forEach((r) => c[r.status]++);
    return c;
  }, [results]);

  const lifeFreightLines = useMemo(
    () => targetLifeLines.filter((l) => l.isFreight).sort((a, b) => (a.slipNo < b.slipNo ? -1 : 1)),
    [targetLifeLines]
  );
  const taikoFreightLines = useMemo(
    () => taikoLines.filter((t) => t.isFreight).sort((a, b) => (a.orderNo < b.orderNo ? -1 : 1)),
    [taikoLines]
  );

  // 太幸の運賃(受注単位)を、店舗+品目の類似度でライフの送料行と1件ずつ突き合わせる。
  // 一致しなかった太幸側の運賃が「まだライフのシステムに送料が追加されていない受注」の候補。
  type FreightMatch = { taikoOrderNo: string; con: string; deliveryName: string; itemNames: string[]; amount: number; score: number };
  const freightMatchResult = useMemo(() => {
    const ordersMap = new Map<string, TaikoLine[]>();
    taikoLines.forEach((t) => {
      const arr = ordersMap.get(t.orderNo) || [];
      arr.push(t);
      ordersMap.set(t.orderNo, arr);
    });
    const taikoFreightOrders: { orderNo: string; con: string; deliveryName: string; itemNames: string[]; amount: number }[] = [];
    ordersMap.forEach((items, orderNo) => {
      const freight = items.find((t) => t.isFreight);
      if (!freight) return;
      taikoFreightOrders.push({
        orderNo,
        con: items[0].customerOrderNo,
        deliveryName: items[0].deliveryName,
        itemNames: items.filter((t) => !t.isFreight).map((t) => t.itemName),
        amount: freight.amount,
      });
    });

    const lifePool = lifeFreightLines;
    const usedLife = new Set<number>();
    const matched: FreightMatch[] = [];
    const unmatchedTaiko: typeof taikoFreightOrders = [];
    taikoFreightOrders.forEach((t) => {
      let best = -1;
      let bestScore = 0;
      lifePool.forEach((l, i) => {
        if (usedLife.has(i)) return;
        if (!storeMatches(l.storeCode, l.storeName, t.deliveryName)) return;
        const s = t.itemNames.reduce((max, nm) => Math.max(max, nameSimilarity(l.freightItemDesc, nm)), 0);
        if (s > bestScore) {
          bestScore = s;
          best = i;
        }
      });
      if (best >= 0 && bestScore > 0.3) {
        usedLife.add(best);
        matched.push({ ...t, taikoOrderNo: t.orderNo, score: bestScore });
      } else {
        unmatchedTaiko.push(t);
      }
    });

    // 2巡目: 品目名では一致しなかったもの(表記違い・修理返品などの特殊なケース)を、
    // 店舗+送料の金額が完全一致し、かつ候補が1件だけに絞れる場合のみ救済する。
    const stillUnmatched: typeof taikoFreightOrders = [];
    unmatchedTaiko.forEach((t) => {
      const candidates = lifePool
        .map((l, i) => ({ l, i }))
        .filter(
          ({ l, i }) => !usedLife.has(i) && storeMatches(l.storeCode, l.storeName, t.deliveryName) && Math.abs(l.amount - t.amount) < 1
        );
      if (candidates.length === 1) {
        usedLife.add(candidates[0].i);
        matched.push({ ...t, taikoOrderNo: t.orderNo, score: -1 });
      } else {
        stillUnmatched.push(t);
      }
    });

    const unusedLife = lifePool.filter((_, i) => !usedLife.has(i));
    return { matched, unmatchedTaiko: stillUnmatched, unusedLife, totalTaikoFreightOrders: taikoFreightOrders.length };
  }, [taikoLines, lifeFreightLines]);

  const filteredResults = useMemo(() => {
    let r = results;
    if (statusFilter !== "all") r = r.filter((x) => x.status === statusFilter);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      r = r.filter((x) => x.lifeLines.some((l) => `${l.storeName} ${l.itemName}`.toLowerCase().includes(s)));
    }
    return r;
  }, [results, statusFilter, search]);

  function downloadCsv() {
    if (!results.length) return;
    const headers = [
      "他伝票No",
      "判定",
      "突合方法",
      "店名",
      "ライフ品名",
      "ライフ金額",
      "太幸品名",
      "太幸金額",
      "差額",
    ];
    const lines = [headers.map(csvEscape).join(",")];
    results.forEach((r) => {
      lines.push(
        [
          r.lifeLines[0].otherSlipNo || "(キーなし)",
          r.status === "match"
            ? "一致"
            : r.status === "amount_diff"
            ? "金額差あり"
            : r.status === "need_check"
            ? "要確認"
            : "太幸データなし",
          r.matchType === "exact_key" ? "客先注番一致" : r.matchType === "date_store" ? "日付・店舗一致" : "―",
          r.lifeLines[0].storeName,
          r.lifeLines.map((l) => l.itemName).join(" / "),
          r.lifeAmount,
          r.taikoLines.map((t) => t.itemName).join(" / "),
          r.taikoAmount,
          r.lifeAmount - r.taikoAmount,
        ]
          .map(csvEscape)
          .join(",")
      );
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ライフ請求金額照合_${targetMonth.replace("/", "")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const bothLoaded = lifeLines.length > 0 && taikoLines.length > 0;
  const totalDiff = summary.lifeTotal - summary.taikoTotal;

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1>ライフ請求金額照合</h1>
          <p className="subtitle">
            ライフの受領実績CSV(計上日・月末締めで集計)と、太幸の請求出力CSV(べんりネット照合と同じ形式)を突き合わせ、月の請求金額に差がないか確認します。商品行は他伝票No⇔客先注番で個別に突き合わせ、送料・運賃は受注に紐づけられないため月合計同士で比較します。
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
          <a href="/profit" className="ghost-btn" style={{ textDecoration: "none" }}>
            売上利益
          </a>
          <a href="/benrinet-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            べんりネット照合
          </a>
          <a href="/payable-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            買掛月報照合
          </a>
          <a href="/life-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            ライフ照合(受注番号さがし)
          </a>
          <a href="/upload" className="ghost-btn" style={{ textDecoration: "none" }}>
            データ更新
          </a>
          <a href="/" className="ghost-btn" style={{ textDecoration: "none" }}>
            ← 値上げ検知ダッシュボードへ
          </a>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 12,
          marginBottom: 20,
          marginTop: 4,
        }}
      >
        <div
          className="card"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverLife(true);
          }}
          onDragLeave={() => setDragOverLife(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverLife(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleLifeFile(f);
          }}
          style={dragOverLife ? { outline: "2px dashed var(--direct)", outlineOffset: -2 } : undefined}
        >
          <h2 style={{ marginTop: 0, fontSize: 16 }}>① ライフ受領実績CSV</h2>
          <p className="cell-sub" style={{ margin: "0 0 8px" }}>
            ファイルをここにドラッグ&ドロップ、または下のボタンで選択してください。計上日(P列)で月ごとに自動集計します。
          </p>
          <input
            type="file"
            accept=".csv"
            disabled={lifeState.loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleLifeFile(f);
              e.target.value = "";
            }}
          />
          {lifeState.fileName && (
            <div style={{ marginTop: 10, fontSize: 12.5 }}>
              <div>ファイル: {lifeState.fileName}</div>
              {lifeState.encoding && <div className="cell-sub">文字コード: {lifeState.encoding}</div>}
              {lifeState.loading && <div style={{ color: "var(--direct)" }}>読み込み中…</div>}
              {!lifeState.loading && lifeLines.length > 0 && (
                <div style={{ color: "var(--good)" }}>{lifeLines.length.toLocaleString("ja-JP")}件を読み込みました</div>
              )}
              {lifeState.error && <div style={{ color: "var(--critical)" }}>{lifeState.error}</div>}
              {lifeWarnings.map((w, i) => (
                <div key={i} style={{ color: "var(--warning)" }}>
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
        <div
          className="card"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverTaiko(true);
          }}
          onDragLeave={() => setDragOverTaiko(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverTaiko(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleTaikoFile(f);
          }}
          style={dragOverTaiko ? { outline: "2px dashed var(--direct)", outlineOffset: -2 } : undefined}
        >
          <h2 style={{ marginTop: 0, fontSize: 16 }}>② 太幸請求出力CSV(ライフ分・べんりネット照合と同じ形式)</h2>
          <p style={{ margin: "0 0 8px", fontSize: 13 }}>
            基幹システムからダウンロードする際の得意先コード: <strong>{LIFE_CUSTOMER_CODE}</strong>(ライフ)
          </p>
          <p className="cell-sub" style={{ margin: "0 0 8px" }}>
            ファイルをここにドラッグ&ドロップ、または下のボタンで選択してください。
          </p>
          <input
            type="file"
            accept=".csv"
            disabled={taikoState.loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleTaikoFile(f);
              e.target.value = "";
            }}
          />
          {taikoState.fileName && (
            <div style={{ marginTop: 10, fontSize: 12.5 }}>
              <div>ファイル: {taikoState.fileName}</div>
              {taikoState.encoding && <div className="cell-sub">文字コード: {taikoState.encoding}</div>}
              {taikoState.loading && <div style={{ color: "var(--direct)" }}>読み込み中…</div>}
              {!taikoState.loading && taikoLines.length > 0 && (
                <div style={{ color: "var(--good)" }}>{taikoLines.length.toLocaleString("ja-JP")}件を読み込みました</div>
              )}
              {taikoState.error && <div style={{ color: "var(--critical)" }}>{taikoState.error}</div>}
              {taikoWarnings.map((w, i) => (
                <div key={i} style={{ color: "var(--warning)" }}>
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {(lifeLines.length > 0 || taikoLines.length > 0) && (
        <div className="filter-actions" style={{ marginTop: -8, marginBottom: 20 }}>
          <button className="ghost-btn" onClick={reset}>
            リセット
          </button>
        </div>
      )}

      {bothLoaded && (
        <>
          {monthOptions.length > 1 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="cell-sub" style={{ marginBottom: 6 }}>
                ライフの計上日が複数月にまたがっています。月末締めの対象月を選んでください。
              </div>
              <div className="segmented">
                {monthOptions.map((m) => (
                  <button key={m.month} className={targetMonth === m.month ? "active" : ""} onClick={() => setTargetMonth(m.month)}>
                    {m.month}({m.count}件)
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="card" style={{ marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>合計金額({targetMonth || "対象月未選択"})</h2>
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th className="num">商品計</th>
                  <th className="num">送料・運賃計</th>
                  <th className="num">合計</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>①ライフ(計上日 {targetMonth})</td>
                  <td className="num">{fmtYen(summary.lifeItemTotal)}</td>
                  <td className="num">{fmtYen(summary.lifeFreightTotal)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {fmtYen(summary.lifeTotal)}
                  </td>
                </tr>
                <tr>
                  <td>②太幸(アップロードしたファイル全体)</td>
                  <td className="num">{fmtYen(summary.taikoItemTotal)}</td>
                  <td className="num">{fmtYen(summary.taikoFreightTotal)}</td>
                  <td className="num" style={{ fontWeight: 700 }}>
                    {fmtYen(summary.taikoTotal)}
                  </td>
                </tr>
                <tr>
                  <td>差額(①−②)</td>
                  <td className="num">{fmtYen(summary.lifeItemTotal - summary.taikoItemTotal)}</td>
                  <td className="num">{fmtYen(summary.lifeFreightTotal - summary.taikoFreightTotal)}</td>
                  <td
                    className="num"
                    style={{ fontWeight: 700, color: Math.abs(totalDiff) < 100 ? "var(--good)" : "var(--critical)" }}
                  >
                    {fmtYen(totalDiff)}
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="cell-sub" style={{ marginTop: 8 }}>
              ②太幸は、アップロードしたファイルに含まれる全行の合計です。対象月とスコープが一致するファイルをアップロードしてください(期間がずれていると①と②は一致しません)。
            </p>
          </div>

          <div className="card" style={{ marginBottom: 20, borderColor: freightMatchResult.unmatchedTaiko.length > 0 ? "var(--critical)" : undefined }}>
            <h2 style={{ marginTop: 0 }}>ライフのシステムにまだ送料が追加されていない受注</h2>
            <p className="cell-sub" style={{ marginTop: -6, marginBottom: 10 }}>
              太幸の運賃({freightMatchResult.matched.length + freightMatchResult.unmatchedTaiko.length}件)を、店舗+品目でライフの送料行と1件ずつ突き合わせました。{freightMatchResult.matched.length}件は一致する送料行が見つかっています。下の{freightMatchResult.unmatchedTaiko.length}件は、まだライフのシステムに送料が追加されていない可能性があります(品目の書き方が違うだけで実際は追加済みのケースもあるため、追加前に念のため実際にライフのシステムを確認してください)。
            </p>
            {freightMatchResult.unmatchedTaiko.length === 0 ? (
              <div className="empty-state">対象月の太幸の運賃は、すべてライフの送料行と対応が取れました</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>受注番号</th>
                    <th>客先注番</th>
                    <th>納入先</th>
                    <th>太幸の品名</th>
                    <th className="num">追加が必要な送料</th>
                  </tr>
                </thead>
                <tbody>
                  {freightMatchResult.unmatchedTaiko.map((t) => (
                    <tr key={t.orderNo}>
                      <td>{t.orderNo}</td>
                      <td>{t.con || "(なし)"}</td>
                      <td>{t.deliveryName}</td>
                      <td>{t.itemNames.join(" / ")}</td>
                      <td className="num" style={{ fontWeight: 700, color: "var(--critical)" }}>
                        {fmtYen(t.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} style={{ fontWeight: 700 }}>
                      合計
                    </td>
                    <td className="num" style={{ fontWeight: 700, color: "var(--critical)" }}>
                      {fmtYen(freightMatchResult.unmatchedTaiko.reduce((s, t) => s + t.amount, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>

          <details className="card" style={{ marginBottom: 20 }}>
            <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 15 }}>
              送料・運賃の明細を全件見る(店舗・概要をもとに自動で突き合わせていますが、完全ではないため元データも確認できるようにしています)
            </summary>
            <p className="cell-sub" style={{ marginTop: 8 }}>
              ライフの「送料」行自体には商品コード・他伝票Noが入っていませんが、「概要」列の商品名と店舗をもとに太幸の運賃と突き合わせています。上の一覧に出てこない品目がないか、下の元データでも確認できます。
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
                gap: 16,
                marginTop: 10,
              }}
            >
              <div>
                <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>
                  ①ライフ 送料明細({targetMonth}・{lifeFreightLines.length}件)
                </h3>
                <div className="table-scroll-v" style={{ maxHeight: 320 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>伝票No</th>
                        <th>計上日</th>
                        <th>店名</th>
                        <th className="num">金額</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lifeFreightLines.map((l, i) => (
                        <tr key={i}>
                          <td>{l.slipNo}</td>
                          <td>{l.postingDate}</td>
                          <td>{l.storeName}</td>
                          <td className="num">{fmtYen(l.amount)}</td>
                        </tr>
                      ))}
                      {lifeFreightLines.length === 0 && (
                        <tr>
                          <td colSpan={4} className="cell-sub">
                            対象月の送料行はありません
                          </td>
                        </tr>
                      )}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3} style={{ fontWeight: 700 }}>
                          合計
                        </td>
                        <td className="num" style={{ fontWeight: 700 }}>
                          {fmtYen(summary.lifeFreightTotal)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
              <div>
                <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>
                  ②太幸 運賃明細(アップロードファイル全体・{taikoFreightLines.length}件)
                </h3>
                <div className="table-scroll-v" style={{ maxHeight: 320 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>受注番号</th>
                        <th>客先注番</th>
                        <th>納品日</th>
                        <th className="num">金額</th>
                      </tr>
                    </thead>
                    <tbody>
                      {taikoFreightLines.map((t, i) => (
                        <tr key={i}>
                          <td>{t.orderNo}</td>
                          <td>{t.customerOrderNo || "(なし)"}</td>
                          <td>{t.deliveryDate}</td>
                          <td className="num">{fmtYen(t.amount)}</td>
                        </tr>
                      ))}
                      {taikoFreightLines.length === 0 && (
                        <tr>
                          <td colSpan={4} className="cell-sub">
                            運賃行はありません
                          </td>
                        </tr>
                      )}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={3} style={{ fontWeight: 700 }}>
                          合計
                        </td>
                        <td className="num" style={{ fontWeight: 700 }}>
                          {fmtYen(summary.taikoFreightTotal)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </div>
          </details>

          <div className="kpi-row">
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("all")}>
              <div className="label">商品の突合件数</div>
              <div className="value">{results.length.toLocaleString("ja-JP")}</div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("match")}>
              <div className="label">金額一致</div>
              <div className="value" style={{ color: "var(--good)" }}>
                {statusCounts.match.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("amount_diff")}>
              <div className="label">金額差あり</div>
              <div className="value" style={{ color: statusCounts.amount_diff > 0 ? "var(--critical)" : undefined }}>
                {statusCounts.amount_diff.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("need_check")}>
              <div className="label">要確認(日付・店舗のみ)</div>
              <div className="value" style={{ color: statusCounts.need_check > 0 ? "var(--warning)" : undefined }}>
                {statusCounts.need_check.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("taiko_not_found")}>
              <div className="label">太幸データなし</div>
              <div className="value" style={{ color: statusCounts.taiko_not_found > 0 ? "var(--critical)" : undefined }}>
                {statusCounts.taiko_not_found.toLocaleString("ja-JP")}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0 }}>商品行ごとの突合結果</h2>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input
                  type="text"
                  placeholder="店名・品名で検索"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13, minWidth: 200 }}
                />
                <button className="ghost-btn" onClick={downloadCsv} disabled={!results.length}>
                  結果をCSVでダウンロード
                </button>
              </div>
            </div>

            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
              {filteredResults.length === 0 && <div className="empty-state">この条件に一致するデータはありません</div>}
              {filteredResults.map((r) => (
                <div key={r.key} className="record-panel">
                  <div className="record-item">
                    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
                      <div style={{ fontSize: 13 }}>
                        <strong>{r.lifeLines[0].storeName}</strong>
                        <span className="cell-sub"> ／ 計上日 {r.lifeLines[0].postingDate}</span>
                        <span className="cell-sub"> ／ 他伝票No {r.lifeLines[0].otherSlipNo || "(なし)"}</span>
                      </div>
                      <div>
                        {r.status === "match" && <span className="badge good">一致</span>}
                        {r.status === "amount_diff" && <span className="badge critical">金額差あり</span>}
                        {r.status === "need_check" && <span className="badge warning">要確認(日付・店舗一致)</span>}
                        {r.status === "taiko_not_found" && <span className="badge critical">太幸データなし</span>}
                      </div>
                    </div>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 10,
                        padding: "8px 10px",
                        borderRadius: 6,
                        background:
                          r.status === "match"
                            ? "rgba(30,125,69,0.08)"
                            : r.status === "need_check"
                            ? "rgba(220,180,40,0.10)"
                            : "rgba(192,57,43,0.08)",
                      }}
                    >
                      <div>
                        <div className="cell-sub">ライフ</div>
                        <div>{r.lifeLines.map((l) => l.itemName).join(" / ")}</div>
                        <div style={{ fontSize: 18, fontWeight: 700 }}>{fmtYen(r.lifeAmount)}</div>
                      </div>
                      <div>
                        <div className="cell-sub">太幸</div>
                        <div>{r.taikoLines.length > 0 ? r.taikoLines.map((t) => t.itemName).join(" / ") : "(対応する行が見つかりません)"}</div>
                        <div
                          style={{
                            fontSize: 18,
                            fontWeight: 700,
                            color: r.status === "match" ? "var(--good)" : r.taikoLines.length === 0 ? "var(--critical)" : undefined,
                          }}
                        >
                          {r.taikoLines.length > 0 ? fmtYen(r.taikoAmount) : "―"}
                        </div>
                      </div>
                    </div>
                    {r.status === "amount_diff" && (
                      <div className="cell-sub" style={{ marginTop: 4, color: "var(--critical)", fontWeight: 600 }}>
                        差額 {fmtYen(r.lifeAmount - r.taikoAmount)}(ライフ側の単価が更新されていないか、数量・行の対応がずれている可能性があります)
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
