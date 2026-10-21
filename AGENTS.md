# AGENTS.md

このファイルは、このリポジトリでSupabase関連の開発(マイグレーション作成など)を行う際に、
エージェント(Claude Codeなど)が必ず確認・遵守すべきルールをまとめたものです。

## Supabaseのテーブル作成時に必ず守ること(2026-10-30の仕様変更対応)

2026年10月30日以降、Supabaseは既存プロジェクトであっても`public`スキーマに新規作成した
テーブル(ビュー・マテリアライズドビューも同様)に対し、Data API(PostgREST)向けの権限
(`anon`/`authenticated`/`service_role`へのGRANT)を自動的には付与しなくなります。

これにより、GRANTを明示しないまま新しいテーブル/ビューを作ると、アプリからSupabaseの
Data API経由でアクセスした際に `permission denied for table ...` のようなエラーになります。
これはRLSのポリシー設定とは別次元の問題で、RLSをどう設定していても、GRANTが無ければ
そもそもそのロールはテーブルに到達できません。

### このプロジェクトでの前提

- フロントエンド(ブラウザ)からSupabaseへ直接アクセスすることは無く、`anon`キーは
  一切使用しません(`lib/supabase-server.ts` が `SUPABASE_SERVICE_ROLE_KEY` を使い、
  サーバー側(Route Handler/Server Component)からのみ呼び出されます)。
- 既存テーブルはすべて `ENABLE ROW LEVEL SECURITY` 済み・ポリシーなしという設計です
  (`service_role` はRLSをバイパスするためポリシー無しでもアクセスでき、
  `anon`/`authenticated` はRLSで実質遮断される、という設計を踏襲しています)。

### 新規テーブル(ビュー・マテリアライズドビューを含む)作成・再作成時のルール

1. `CREATE TABLE`/`CREATE VIEW`/`CREATE MATERIALIZED VIEW` を含む同じmigration内で、
   必ず以下をセットで行う。
   - テーブルの場合: `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;`
     (ポリシーは追加しない。既存設計と同じ。ビュー・マテリアライズドビューにはRLSの
     概念が無いため不要)
   - `GRANT <必要な権限> ON <table_or_view> TO service_role;`
   - `anon` ・`authenticated` へのGRANTは行わない(このプロジェクトでは使わないロール)
2. `service_role` に付与する権限は、そのテーブル/ビューの実際の用途に合わせて絞る。
   メールの例文(全権限)をそのまま全テーブルにコピーしない。例:
   - アプリが読み取るだけのテーブル・ビュー・マテリアライズドビュー → `SELECT` のみ
   - アップロード機能でINSERT/UPSERTするテーブル → `SELECT, INSERT, UPDATE`
   - 洗い替え(全件削除→再投入)するテーブル → `SELECT, INSERT, UPDATE, DELETE`
3. 既存テーブルの権限は、変更する具体的な理由(用途変更など)がない限り触らない。
4. `supabase db reset`・新規環境・Preview Branchなど、migrationだけでDBを再構築した
   場合でも、上記1のGRANTが含まれていればData API経由のアクセスは問題なく動く状態にする。

### 雛形(新規テーブル作成時にコピーして用途に合わせて調整する)

```sql
create table if not exists public.<table_name> (
  ...
);

alter table public.<table_name> enable row level security;

-- 用途に応じて絞る。不要なinsert/update/deleteは付けない。
-- anon/authenticatedには何も付与しない。
grant select, insert, update on public.<table_name> to service_role;
```

```sql
-- ビュー/マテリアライズドビューの場合(RLSは不要、GRANTのみ)
create or replace view public.<view_name> as select ...;

grant select on public.<view_name> to service_role;
```
