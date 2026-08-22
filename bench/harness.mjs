#!/usr/bin/env node
/**
 * Deploy Bench 計測ハーネス（build 側）
 *
 * サイトが公開した4つのルール（/method/）を、そのままコードにしたもの。
 *   - 同一リポジトリ・同一コミット・同一lockfile を全条件で使う
 *   - cold（キャッシュ破棄後）と warm を別々の数字として出す。平均に混ぜない
 *   - 生ログを results/ に丸ごと残す。ログを出せない数字はレポートに載せない
 *
 * 使い方: node harness.mjs [--runs N]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "reference-app");
const resultsDir = join(here, "results");
mkdirSync(resultsDir, { recursive: true });

const argRuns = process.argv.indexOf("--runs");
const RUNS = argRuns > -1 ? Number(process.argv[argRuns + 1]) : 3;

/** ISO文字列。ハーネス実行時の実時刻を記録する（数字に日付が付かないものは載せない） */
const startedAt = new Date().toISOString();

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: appDir,
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function dirSizeBytes(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    total += entry.isDirectory() ? dirSizeBytes(full) : statSync(full).size;
  }
  return total;
}

/** キャッシュを破棄して cold 条件を作る */
function purgeCaches() {
  for (const d of [".next", ".open-next", "out", "node_modules/.cache"]) {
    rmSync(join(appDir, d), { recursive: true, force: true });
  }
}

function timeBuild(label, cmd, args) {
  const t0 = process.hrtime.bigint();
  const res = sh(cmd, args);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return {
    label,
    command: `${cmd} ${args.join(" ")}`,
    ok: res.status === 0,
    exitCode: res.status,
    ms: Math.round(ms),
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

/* ---------------- 環境の記録（再現に必要な情報を全部残す） ---------------- */
function capture(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}

const env = {
  startedAt,
  os: capture("sw_vers", ["-productVersion"]),
  arch: capture("uname", ["-m"]),
  cpu: capture("sysctl", ["-n", "machdep.cpu.brand_string"]),
  memBytes: capture("sysctl", ["-n", "hw.memsize"]),
  node: process.version,
  bun: capture("bun", ["--version"]),
  nextVersion: (() => {
    try {
      return JSON.parse(
        execFileSync("cat", [join(appDir, "node_modules/next/package.json")], {
          encoding: "utf8",
        }),
      ).version;
    } catch {
      return "unknown";
    }
  })(),
};

/* ---------------- 実測 ---------------- */
const runs = [];

console.log(`Deploy Bench harness — ${RUNS} runs per condition`);
console.log(`  next: ${env.nextVersion}  node: ${env.node}  bun: ${env.bun}`);
console.log(`  cpu : ${env.cpu}\n`);

for (let i = 1; i <= RUNS; i++) {
  console.log(`[run ${i}/${RUNS}] cold …`);
  purgeCaches();
  const cold = timeBuild("cold", "bunx", ["--bun", "next", "build"]);
  const coldOut = dirSizeBytes(join(appDir, "out"));
  console.log(`           ${cold.ok ? "ok" : "FAIL"}  ${cold.ms} ms`);

  console.log(`[run ${i}/${RUNS}] warm …`);
  const warm = timeBuild("warm", "bunx", ["--bun", "next", "build"]);
  console.log(`           ${warm.ok ? "ok" : "FAIL"}  ${warm.ms} ms\n`);

  runs.push({ run: i, cold, warm, outBytes: coldOut });
}

/* ---------------- 集計 ---------------- */
function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    n: values.length,
    min: sorted[0],
    median:
      sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2),
    max: sorted[sorted.length - 1],
  };
}

const summary = {
  cold: stats(runs.filter((r) => r.cold.ok).map((r) => r.cold.ms)),
  warm: stats(runs.filter((r) => r.warm.ok).map((r) => r.warm.ms)),
  failures: runs.flatMap((r) =>
    [r.cold, r.warm].filter((b) => !b.ok).map((b) => ({ run: r.run, label: b.label, exitCode: b.exitCode })),
  ),
};

const stamp = startedAt.replace(/[:.]/g, "-");
const payload = { env, summary, runs };
const jsonPath = join(resultsDir, `build-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

/* 生ログは別ファイルに丸ごと残す。「ログを出せない数字は載せない」を守るため */
const logPath = join(resultsDir, `build-${stamp}.log`);
writeFileSync(
  logPath,
  runs
    .flatMap((r) =>
      [r.cold, r.warm].map(
        (b) =>
          `===== run ${r.run} / ${b.label} =====\n$ ${b.command}\nexit=${b.exitCode}  elapsed=${b.ms}ms\n\n--- stdout ---\n${b.stdout}\n--- stderr ---\n${b.stderr}\n`,
      ),
    )
    .join("\n"),
  "utf8",
);

console.log("summary");
console.log(`  cold  median ${summary.cold?.median ?? "-"} ms  (min ${summary.cold?.min ?? "-"} / max ${summary.cold?.max ?? "-"})`);
console.log(`  warm  median ${summary.warm?.median ?? "-"} ms  (min ${summary.warm?.min ?? "-"} / max ${summary.warm?.max ?? "-"})`);
console.log(`  failures: ${summary.failures.length}`);
console.log(`\n  ${jsonPath}`);
console.log(`  ${logPath}`);
