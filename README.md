# cURL Web Runner

ブラウザ上で `curl` コマンドを入力し、安全なサーバ側 HTTP クライアントで実行して結果を確認する Web アプリです。

- ページ: `/`
- API: `/api/execute`
- 実行方式: ユーザー入力の `curl` をシェル実行せず、サーバ側でパースして HTTP リクエストへ変換

## 機能

- `curl` コマンド入力と実行
- 結果表示
  - `Body`
  - `Headers`
  - `Raw`
  - `Cookies`
- HTML Preview
- Image Preview
- User-Agent プリセット
  - Chrome / Windows
  - Chrome / macOS
  - Chrome / Android
  - Chrome / iPhone
- フォームからの cURL 生成
- History 保存と検索
- Share URL
- ダーク/ライト切り替え
- PM2 運用対応
- 監査ログ出力

## 対応している curl オプション

初版で対応している主なオプション:

- URL
- `-X`, `--request`
- `-H`, `--header`
- `-d`, `--data`
- `--data-raw`
- `--data-binary`
- `-u`, `--user`
- `-I`, `--head`
- `-A`, `--user-agent`
- `-e`, `--referer`
- `--cookie`
- `-L`, `--location`
- `-k`, `--insecure`

## 非対応または禁止しているもの

禁止または未対応:

- `--proxy`, `-x`
- `--output`, `-o`
- `--remote-name`, `-O`
- `--config`, `-K`
- `--interface`
- `--resolve`
- `--connect-to`
- `--form`, `-F`
- `--upload-file`, `-T`
- `--unix-socket`
- `--aws-sigv4`
- `file://` など `http/https` 以外のスキーム
- ローカルファイル参照 `@file`
- `CONNECT` など許可外メソッド

## 技術構成

- Node.js
- 依存なしの単体サーバー
- 静的フロントエンド
- サーバ側 HTTP/HTTPS クライアント

主要ファイル:

- `server.js`: API、curl パーサ、SSRF 対策、HTTP 実行、静的配信
- `public/index.html`: UI
- `public/app.js`: クライアントロジック
- `public/styles.css`: スタイル
- `ecosystem.config.cjs`: PM2 設定

## セットアップ

Node.js 20 以上を想定しています。

このプロジェクトは外部パッケージ依存がないため、`npm install` は必須ではありません。

## 開発起動

```bash
npm run dev
```

デフォルトでは `http://localhost:3000` で起動します。

## 本番起動

```bash
npm start
```

## PM2 運用

起動:

```bash
pm2 start ecosystem.config.cjs
```

状態確認:

```bash
pm2 status
pm2 describe curl-web-runner
```

再起動:

```bash
pm2 restart curl-web-runner
```

停止:

```bash
pm2 stop curl-web-runner
```

保存:

```bash
pm2 save
```

## ビルド/構文チェック

```bash
npm run build
node --check public/app.js
```

## API

### `POST /api/execute`

Request:

```json
{
  "curl": "curl -L https://example.com"
}
```

Response:

```json
{
  "ok": true,
  "request": {
    "method": "GET",
    "url": "https://example.com",
    "headers": {
      "User-Agent": "CurlWebRunner/1.0"
    },
    "followRedirects": true,
    "headOnly": false,
    "insecure": false
  },
  "response": {
    "finalUrl": "https://example.com",
    "redirects": [],
    "status": 200,
    "statusText": "OK",
    "headers": {
      "content-type": "text/html"
    },
    "body": "<!doctype html>...",
    "bodyBase64": "",
    "bodyType": "html",
    "size": 528,
    "durationMs": 40
  }
}
```

Error example:

```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN_HOST",
    "message": "プライベートIPやローカルIPにはアクセスできません。"
  }
}
```

## セキュリティ方針

このアプリは、ユーザー入力をそのまま OS シェルで実行しません。`curl` 文字列を内部でパースし、安全な HTTP リクエスト定義へ変換して実行します。

実装している主な対策:

- SSRF 対策
  - `localhost`
  - private IP
  - link-local
  - IPv4-mapped IPv6
  - 予約IP帯
  - DNS 解決後のIP検査
  - 安全確認したIPへの固定接続
  - リダイレクト先の再検査
- 危険ヘッダー拒否
  - `Host`
  - `Content-Length`
  - `Transfer-Encoding`
  - `Connection`
  - `Upgrade`
  - `Proxy-*`
- リクエスト制限
  - curl 長
  - URL 長
  - ヘッダー数
  - ヘッダー長
  - Body サイズ
  - レスポンスサイズ
  - タイムアウト
  - レート制限
- 静的配信強化
  - CSP
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy`
  - `X-Frame-Options: DENY`
  - path traversal 対策
- フロント側の保護
  - `Authorization` / `Cookie` / `-u` / `--cookie` を含む curl は History に保存しない
  - 機微情報を含む可能性がある Share URL は確認ダイアログを出す

## HTML Preview / Image Preview

- HTML レスポンスは sandbox iframe でプレビュー
- 画像レスポンスは `data:` URL でプレビュー

注意:

- HTML Preview は安全優先の制限付き表示です
- 外部リソース読込が発生しうる HTML は、その制限の範囲でのみ表示されます

## History

- LocalStorage に保存
- 最大 200 件
- 検索可能
- 機密値を含む curl は保存しない

## 監査ログ

実行結果は内部ログへ記録されます。

- パス: `logs/audit.log`
- 形式: 1 行 1 JSON
- 権限: `600`

記録内容:

- 時刻
- 実行元 IP
- 成功/失敗
- マスク済み curl
- パース後のリクエスト概要
- ステータスや応答サイズなどの概要

機密値はログに平文で残さないようマスクしています。

確認例:

```bash
tail -n 50 logs/audit.log
```

## 補足

- 認証機能はアプリ自体には入れていません
- インターネット公開する場合は、必要に応じてリバースプロキシ側で IP 制限や Basic 認証を追加してください
