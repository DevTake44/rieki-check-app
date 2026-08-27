import Link from "next/link";

/**
 * データ更新状況
 *
 * 目的: 「データ更新」ページでCSVを取り込んだあと、各データ(売上・仕入・社内間・送り状問合せ)が
 * 今どこまで入っているか(最新の日付・件数・最後に取り込んだのはいつか)を一覧で確認できるようにする。
 * 取り込み自体は upsert(同じ受注番号・仕入番号等の行は自動的に上書き)されるため重複の心配はない、
 * という前提のもとで、「重複していないか」ではなく「最新のデータがどこまで反映されているか」を
 * 見るためのページ(2026-08-07追加)。
 *
 * 注意: このアプリは「いつ・何件アップロードされたか」を記録する専用のログテーブルを持っていない
 * (アップロードのたびに各データテーブルへ直接upsert/置き換えするだけの設計)。そのため「直近の
 * 取り込み内容」は、各行のcreated_at(その行が最初にデータベースに入った日時)をもとに、
 * 最新のcreated_atから遡って一定時間(30分)以内の行を「直近1回分の取り込み」とみなして
 * 推定したものであり、正式な取り込み履歴ログではない。目安として利用すること。
 */

export type TableStatus = {
  key: string;
  label: string;
  dateColumnLabel: string;
  rowCount: number;
  minDate: string | null;
  maxDate: string | null;
  lastImportedAt: string | null;
  lastBatchCount: number | null;
  lastBatchMinDate: string | null;
  lastBatchMaxDate: string | null;
};

function fmtDate(d: string | null): string {
  if (!d) return "―";
  // "YYYY-MM-DD" 形式の日付、もしくはタイムスタンプの先頭10文字を想定
  const s = d.slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return s;
  return `${m[1]}/${m[2]}/${m[3]}`;
}

function fmtDateTime(d: string | null): string {
  if (!d) return "―";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}/${pad(dt.getMonth() + 1)}/${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(
    dt.getMinutes()
  )}`;
}

function daysAgo(d: string | null): string {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  const diffMs = Date.now() - dt.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "(今日)";
  if (diffDays === 1) return "(1日前)";
  return `(${diffDays}日前)`;
}

export default function DataStatus({ statuses }: { statuses: TableStatus[] }) {
  return (
    <div className="page">
      <h1>データ更新状況</h1>
      <p className="subtitle">
        「データ更新」ページで取り込んだ各データが、今どこまで入っているかを一覧で確認できます。取り込みは自動的にupsert(重複防止)されるため、同じ内容を再アップロードしても件数が増えることはありません。
      </p>

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>データ種別</th>
              <th className="num">件数</th>
              <th>データの日付範囲</th>
              <th>最終取り込み日時</th>
              <th>直近の取り込み(目安)</th>
            </tr>
          </thead>
          <tbody>
            {statuses.map((s) => (
              <tr key={s.key}>
                <td style={{ fontWeight: 600 }}>{s.label}</td>
                <td className="num">{s.rowCount.toLocaleString("ja-JP")}件</td>
                <td>
                  {s.minDate || s.maxDate ? (
                    <>
                      {s.dateColumnLabel}: {fmtDate(s.minDate)} 〜 {fmtDate(s.maxDate)}
                    </>
                  ) : (
                    "―"
                  )}
                </td>
                <td>
                  {fmtDateTime(s.lastImportedAt)}
                  {s.lastImportedAt && (
                    <span className="cell-sub" style={{ marginLeft: 6 }}>
                      {daysAgo(s.lastImportedAt)}
                    </span>
                  )}
                </td>
                <td>
                  {s.lastBatchCount ? (
                    <>
                      {s.lastBatchCount.toLocaleString("ja-JP")}件
                      {(s.lastBatchMinDate || s.lastBatchMaxDate) && (
                        <div className="cell-sub">
                          {s.dateColumnLabel}: {fmtDate(s.lastBatchMinDate)} 〜 {fmtDate(s.lastBatchMaxDate)}
                        </div>
                      )}
                    </>
                  ) : (
                    "―"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2 style={{ marginTop: 0 }}>見方</h2>
        <p className="cell-sub" style={{ margin: "0 0 8px" }}>
          「データの日付範囲」は、今そのデータに入っている一番古い日付〜一番新しい日付です。「最新のデータがどこまで入っているか」はここの右側(一番新しい日付)を見てください。
        </p>
        <p className="cell-sub" style={{ margin: "0 0 8px" }}>
          「最終取り込み日時」は、そのデータに最後に新しい行が追加された日時です(既存行の更新だけで新規行が無かった場合は反映されないことがあります)。
        </p>
        <p className="cell-sub" style={{ margin: 0 }}>
          「直近の取り込み(目安)」は、最終取り込み日時から遡って30分以内に入った行を1回分のアップロードとみなして集計した参考値です。このアプリはアップロード履歴を記録する専用のログを持っていないため、正式な取り込み履歴ではなく目安としてご利用ください。
        </p>
      </div>

      <div style={{ marginTop: 20 }}>
        <Link href="/upload" className="ghost-btn" style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}>
          データ更新
        </Link>
        <Link href="/menu" className="ghost-btn" style={{ display: "inline-block", textDecoration: "none" }}>
          ← メニューに戻る
        </Link>
      </div>
    </div>
  );
}
