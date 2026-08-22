# 上流PR 提出記録

- **PR: https://github.com/opennextjs/opennextjs-aws/pull/1219**
- 提出日: 2026-08-23（`date` 実測）
- 宛先: `opennextjs/opennextjs-aws`（`opennextjs/aws` は存在しない。npm パッケージ名とリポジトリ名が違う）
- fork: `wxxw1xwwx-beep/opennextjs-aws` / branch `fix/pass-env-to-next-build`
- patch は `main`（`3342279`）へ **clean apply** を確認。適用前に `buildNextApp.ts:20` の
  `cp.execSync(command, { stdio, cwd })` に `env` が無いことを現物で確認した（バグは現 main に残存）

## 提出前に直した本文の誤り2件（鮮度切れ）

1. **「bun 1.3.14 が最新リリース」→ 誤り。** 2026-08-20 に **bun 1.4.0** が出ている（`gh api` 実測）。
   1.4.0 で挙動が変わったかは**未測定**なので、測っていないことを本文に明記する形へ書き換えた。
   PR の価値は「`installDeps.ts` と揃える・Node では無コスト」で独立に立つ
2. **「`@opennextjs/aws` at `main` で検証」→ 誤り。** 実測ログは **4.1.0**（`results/*.json`）。
   実測対象を 4.1.0 と明記し、main へは patch が当たることだけを別行で述べる形にした

## 残

- レビュー待ち。CLA・changeset 規約の指摘が来たら対応する
- EP01 の台本・説明欄は「PR未提出」を前提にヘッジした表現のまま。**この PR URL を反映すると
  `artifact_set_sha256` が変わり独立レビューのやり直しになる**ので、次に EP01 を触る時にまとめて直す
