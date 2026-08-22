#!/usr/bin/env node
/**
 * Deploy Bench 計測ハーネス（deploy 側）— format A の "cold/warm の実数" を取る。
 *
 * harness.mjs が測るのは **ビルド時間**。format A が要求する cold/warm は **配信の初回バイト**なので、
 * 別のハーネスが要る（bench/README.md §4 の定義）。ここで測るのは4つ:
 *   1. cold build   … .next / out / node_modules/.cache を消してからの `next build`
 *   2. warm build   … 消さずにもう一度
 *   3. deploy       … `wrangler pages deploy out` にかかった実時間
 *   4. TTFB cold/warm … デプロイ固有URL（<hash>.<project>.pages.dev）への初回リクエストと以降の反復
 *
 * 🔴 TTFB cold の定義について正直に書く: `*.pages.dev` は Cloudflare 自身のゾーンなので
 *    **こちらからキャッシュをパージする手段が無い**。したがって cold ＝「デプロイ直後、その
 *    デプロイ固有URLへ誰も触れていない状態での初回リクエスト」と定義する。エッジのキャッシュを
 *    強制的に空にした状態ではない。この定義をレポート側にもそのまま書くこと。
 *
 * 🔴 reference-app/next.config.ts は一時的に上書きし、**必ず元へ戻す**（finally）。
 *    tracked のまま `output:"export"` を残すと、publish-repo が公開リポへ同期して
 *    RUN-001 と上流PR #1219 の再現条件（output 未設定）が壊れる。
 *
 * 使い方: node deploy-static-cf.mjs [--runs N] [--project <cf-pages-project>] [--ttfb N]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "reference-app");
const resultsDir = join(here, "results");
const configPath = join(appDir, "next.config.ts");
mkdirSync(resultsDir, { recursive: true });

const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const RUNS = Number(argOf("runs", 3));
const PROJECT = argOf("project", "deploy-bench-ep02");
const TTFB_N = Number(argOf("ttfb", 5));

const startedAt = new Date().toISOString();
const log = [];
const say = (s) => { console.log(s); log.push(s); };

function sh(cmd, args, opts = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? appDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...opts.env } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ms };
}

/** 環境を数字と一緒に記録する。バージョンが載っていない計測は載せない（bench/README.md §4） */
function environment() {
  const v = (c, a) => sh(c, a).stdout.trim();
  const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8"));
  return {
    node: process.version,
    bun: v("bun", ["--version"]),
    wrangler: v("npx", ["wrangler", "--version"]).split("\n").pop(),
    next: pkg.dependencies?.next,
    os: `${v("sw_vers", ["-productName"])} ${v("sw_vers", ["-productVersion"])} (${v("uname", ["-m"])})`,
    started_at: startedAt,
  };
}

const EXPORT_CONFIG = `import type { NextConfig } from "next";
// 一時的な計測条件（bench/deploy-static-cf.mjs が書き、計測後に元へ戻す）
const nextConfig: NextConfig = { output: "export", images: { unoptimized: true }, turbopack: { root: __dirname } };
export default nextConfig;
`;

/** デプロイ固有URL（https://<hash>.<project>.pages.dev）を wrangler の出力から拾う */
function parseDeploymentUrl(out) {
  const m = out.match(/https:\/\/[0-9a-f]+\.[a-z0-9-]+\.pages\.dev/i);
  return m ? m[0] : null;
}

/**
 * TTFB を ms で返す。node の fetch はレスポンスヘッダが揃った時点で解決するので、
 * その時刻＝最初のバイトが届いた時刻として扱う。
 * curl(LibreSSL) を使わないのは、証明書未発行のホストで出るエラーが `http=000` に潰れて
 * 「0ms で返ってきた」ように見えるため（2026-08-23 に実際に踏んだ）。
 */
async function ttfb(url) {
  const t0 = process.hrtime.bigint();
  try {
    const r = await fetch(url, { cache: "no-store", redirect: "manual" });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    await r.arrayBuffer().catch(() => {});
    return { http: r.status, ms: Math.round(ms) };
  } catch (e) {
    return { http: 0, ms: null, error: e.cause?.message || e.message };
  }
}

/**
 * 新しい Pages プロジェクトの `*.<project>.pages.dev` ワイルドカード証明書は非同期に発行される。
 * 出るまでは TLS ハンドシェイクで落ちる（apex は先に出る）。**証明書待ちを計測値に混ぜない**ため、
 * 200 が返るまで待ってから測る。待ちきれなければ null を返し、呼び出し側が apex へ落とす。
 */
async function waitReady(url, maxMs = 15 * 60e3) {
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < maxMs; i++) {
    const r = await ttfb(url);
    if (r.http >= 200 && r.http < 400) return { waited_ms: Date.now() - t0, attempts: i + 1 };
    await new Promise((res) => setTimeout(res, 15e3));
  }
  return null;
}

const originalConfig = readFileSync(configPath, "utf8");
const result = { unit: "EP02", condition: "next static export → Cloudflare Pages", environment: environment(), builds: { cold: [], warm: [] }, deploy: null, ttfb: null };

try {
  say(`# deploy-static-cf ${startedAt}`);
  say(`project=${PROJECT} runs=${RUNS} ttfb_samples=${TTFB_N}`);
  writeFileSync(configPath, EXPORT_CONFIG);
  say(`next.config.ts を計測条件へ差し替え（output:"export"）`);

  for (let i = 1; i <= RUNS; i++) {
    for (const p of [".next", "out", "node_modules/.cache"]) rmSync(join(appDir, p), { recursive: true, force: true });
    const cold = sh("npx", ["next", "build"]);
    say(`cold build #${i}: ${cold.status === 0 ? "ok" : "FAIL"} ${Math.round(cold.ms)}ms`);
    if (cold.status !== 0) { say(cold.stdout.slice(-2000) + cold.stderr.slice(-2000)); throw new Error(`cold build #${i} failed`); }
    result.builds.cold.push(Math.round(cold.ms));

    const warm = sh("npx", ["next", "build"]);
    say(`warm build #${i}: ${warm.status === 0 ? "ok" : "FAIL"} ${Math.round(warm.ms)}ms`);
    if (warm.status !== 0) throw new Error(`warm build #${i} failed`);
    result.builds.warm.push(Math.round(warm.ms));
  }

  // production ブランチへ出す。apex（<project>.pages.dev）と固有URLの両方が立ち、
  // 固有URLの証明書が間に合わなくても apex へ落として計測を続けられる
  const branch = "main";
  const dep = sh("npx", ["wrangler", "pages", "deploy", "out", "--project-name", PROJECT, "--branch", branch, "--commit-dirty=true"]);
  const url = parseDeploymentUrl(dep.stdout + dep.stderr);
  say(`deploy: ${dep.status === 0 ? "ok" : "FAIL"} ${Math.round(dep.ms)}ms → ${url ?? "(URL を拾えなかった)"}`);
  if (dep.status !== 0 || !url) { say((dep.stdout + dep.stderr).slice(-2000)); throw new Error("deploy failed"); }
  result.deploy = { ms: Math.round(dep.ms), url, branch };

  // 証明書待ちを計測に混ぜない。固有URLが立たなければ apex を使い、どちらを測ったか記録する
  const apex = `https://${PROJECT}.pages.dev/`;
  const ready = await waitReady(url);
  const target = ready ? url : apex;
  say(ready
    ? `固有URLの証明書が出た（${Math.round(ready.waited_ms / 1000)}秒・${ready.attempts}回）→ ${target} を測る`
    : `固有URLの証明書が15分以内に出なかった → apex ${apex} を測る`);
  if (!ready) { const a = await waitReady(apex, 5 * 60e3); if (!a) throw new Error("apex も応答しない"); }

  const first = await ttfb(target);
  say(`TTFB cold: http=${first.http} ${first.ms}ms`);
  const warmSamples = [];
  for (let i = 0; i < TTFB_N; i++) { const w = await ttfb(target); warmSamples.push(w.ms); say(`TTFB warm #${i + 1}: http=${w.http} ${w.ms}ms`); }
  const sorted = warmSamples.filter((n) => n != null).sort((a, b) => a - b);
  result.ttfb = {
    definition: "cold = first request after the deployment became reachable, to a URL nothing had requested before. NOT a purged edge cache: *.pages.dev is Cloudflare's own zone and offers no purge control from our side.",
    measured_url: target,
    used_unique_url: Boolean(ready),
    cert_wait_ms: ready ? ready.waited_ms : null,
    cold_ms: first.ms, cold_http: first.http,
    warm_ms: warmSamples,
    warm_min: sorted[0], warm_median: sorted[Math.floor(sorted.length / 2)], warm_max: sorted[sorted.length - 1],
  };
} finally {
  writeFileSync(configPath, originalConfig);
  say("next.config.ts を元へ戻した");
  const same = readFileSync(configPath, "utf8") === originalConfig;
  say(`復元の確認: ${same ? "一致" : "🔴 不一致（手で戻すこと）"}`);
  result.config_restored = same;

  const stamp = startedAt.replace(/[:.]/g, "-");
  const jsonPath = join(resultsDir, `deploy-static-cf-${stamp}.json`);
  const logPath = join(resultsDir, `deploy-static-cf-${stamp}.log`);
  writeFileSync(jsonPath, JSON.stringify(result, null, 2) + "\n");
  writeFileSync(logPath, log.join("\n") + "\n");
  console.log(`\nresults:\n  ${jsonPath}\n  ${logPath}`);
}
