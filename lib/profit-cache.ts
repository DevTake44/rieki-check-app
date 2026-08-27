import type { ProfitOrder } from "@/lib/types";

/**
 * 売上利益ダッシュボードのブラウザ内キャッシュ(2026-08-27追加)
 *
 * 背景: 売上利益画面は8万8千件超のデータをAPIから約30回に分けて読み込んでおり、
 * メニューに戻ってから再度開くたびに、この読み込みを毎回最初からやり直していた
 * (next/linkによる画面遷移の高速化やstaleTimesの設定は、サーバー側のページ本体の
 * キャッシュには効くが、このコンポーネントがマウントされるたびにuseEffectの中で
 * 自前で行っているAPI読み込みまでは効かないため)。
 *
 * 対策: 読み込み終わったデータを、このモジュール(ブラウザのJSが読み込まれている間だけ
 * 生きているメモリ上の変数)に保持しておく。next/linkでの画面遷移はページ全体を
 * 再読み込みしない(SPA的な遷移)ため、一度読み込んだあとはメニュー⇔売上利益を
 * 何度行き来してもこの変数は保持され、2回目以降は再取得せず一瞬で表示できる。
 *
 * ブラウザのlocalStorage/sessionStorageに保存しない理由: 8万8千件をJSON化すると
 * 約30MB程度になり、多くのブラウザのストレージ上限(5〜10MB程度)を超えて
 * 保存自体に失敗する可能性が高いため、メモリ上のみで保持する方式にしている。
 * そのためブラウザを完全に再読み込み(F5やURL再入力)した場合は失われ、その時は
 * 通常通り最初から読み込み直す(これは想定通りの動作)。
 *
 * 更新: 「データ更新」ページでのアップロードが成功した際(UploadForm.tsx)、
 * このキャッシュを明示的に破棄している。それ以外は自動更新せず、画面上の
 * 「更新」ボタンによる手動更新のみとしている(安全のため、まずは手動更新から)。
 */

type ProfitCacheEntry = {
  orders: ProfitOrder[];
  loadedAt: number;
};

let cache: ProfitCacheEntry | null = null;

export function getProfitCache(): ProfitCacheEntry | null {
  return cache;
}

export function setProfitCache(orders: ProfitOrder[]): void {
  cache = { orders, loadedAt: Date.now() };
}

export function clearProfitCache(): void {
  cache = null;
}
