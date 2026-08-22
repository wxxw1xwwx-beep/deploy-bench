#!/usr/bin/env node
/**
 * 再現スクリプト: @opennextjs/cloudflare のビルドが落ちる条件を切り分ける
 *
 * 検証したいこと（当初の仮説は2回とも実測で否定された。経緯は RUN-001.md §3）:
 *   1. 「Cloudflare へ出すには Next.js を下げる必要がある」→ 誤り
 *   2. 「Next.js 16 が NEXT_PRIVATE_STANDALONE を無視する」→ 誤り（効く）
 *   3. 実際の原因 → **アダプタを走らせるランタイム**。
 *      アダプタは process.env.NEXT_PRIVATE_STANDALONE を立ててから
 *      child_process.execSync で next build を叩くが、Bun ランタイム下では
 *      その環境変数変更が子プロセスへ伝わらない。
 *      結果 standalone 出力が作られず、あとで ENOENT として表面化する。
 *
 * 使い方: node repro-opennext-standalone.mjs
 * 出力  : results/repro-opennext-standalone-<ISO>.{json,log}
 */
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "reference-app");
const resultsDir = join(here, "results");
mkdirSync(resultsDir, { recursive: true });

const startedAt = new Date().toISOString();

const CONFIG_WITHOUT = `import type { NextConfig } from "next";
const nextConfig: NextConfig = { turbopack: { root: __dirname } };
export default nextConfig;
`;

const CONFIG_WITH = `import type { NextConfig } from "next";
const nextConfig: NextConfig = { output: "standalone", turbopack: { root: __dirname } };
export default nextConfig;
`;

function version(pkg) {
  try {
    return JSON.parse(
      execFileSync("cat", [join(appDir, "node_modules", pkg, "package.json")], {
        encoding: "utf8",
      }),
    ).version;
  } catch {
    return "unknown";
  }
}

/**
 * @param {string} label
 * @param {string} configSource  next.config.ts の中身
 * @param {string[]} argv        アダプタ起動コマンド（ランタイムの違いがここに出る）
 */
function runCase(label, configSource, argv) {
  writeFileSync(join(appDir, "next.config.ts"), configSource, "utf8");
  for (const d of [".next", ".open-next"]) {
    rmSync(join(appDir, d), { recursive: true, force: true });
  }

  const t0 = process.hrtime.bigint();
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: appDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);

  return {
    label,
    runtime: argv[0] === "bunx" ? "bun" : "node",
    outputInConfig: configSource.includes('output: "standalone"') ? "standalone" : "(unset)",
    command: argv.join(" "),
    exitCode: res.status,
    ok: res.status === 0,
    ms,
    standaloneEmitted: existsSync(
      join(appDir, ".next/standalone/.next/server/pages-manifest.json"),
    ),
    workerEmitted: existsSync(join(appDir, ".open-next/worker.js")),
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const env = {
  startedAt,
  next: version("next"),
  openNextCloudflare: version("@opennextjs/cloudflare"),
  wrangler: version("wrangler"),
  node: process.version,
  bun: (() => {
    try {
      return execFileSync("bun", ["--version"], { encoding: "utf8" }).trim();
    } catch {
      return "unavailable";
    }
  })(),
  os: (() => {
    try {
      return execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })(),
};

console.log(
  `repro — next ${env.next} / @opennextjs/cloudflare ${env.openNextCloudflare} / node ${env.node} / bun ${env.bun}\n`,
);

const BUN_ADAPTER = ["bunx", "--bun", "opennextjs-cloudflare", "build"];
const NODE_ADAPTER = ["npx", "--no-install", "opennextjs-cloudflare", "build"];

const cases = [
  runCase("A: bun runtime / output unset", CONFIG_WITHOUT, BUN_ADAPTER),
  runCase("B: bun runtime / output standalone", CONFIG_WITH, BUN_ADAPTER),
  runCase("C: node runtime / output unset", CONFIG_WITHOUT, NODE_ADAPTER),
];

for (const c of cases) {
  console.log(
    `${c.label}\n  exit=${c.exitCode}  standalone=${c.standaloneEmitted}  worker=${c.workerEmitted}  ${c.ms}ms`,
  );
}

const [a, b, c] = cases;
const verdict =
  !a.ok && !a.standaloneEmitted && b.ok && c.ok && c.standaloneEmitted
    ? "CONFIRMED: 原因はランタイム。Bun下ではアダプタが立てた NEXT_PRIVATE_STANDALONE が子プロセスへ伝わらず standalone が作られない。Node で走らせれば設定変更なしで通る。Bun を使いたい場合は output:\"standalone\" を自分で書くのが回避策"
    : "INCONCLUSIVE: 想定した挙動と一致しなかった。生ログを読むこと";

console.log(`\n${verdict}`);

const errorLine =
  (a.stderr + a.stdout).split("\n").find((l) => l.includes("ENOENT")) ?? "";

const stamp = startedAt.replace(/[:.]/g, "-");
writeFileSync(
  join(resultsDir, `repro-opennext-standalone-${stamp}.json`),
  JSON.stringify({ env, verdict, errorLine, cases }, null, 2),
  "utf8",
);
writeFileSync(
  join(resultsDir, `repro-opennext-standalone-${stamp}.log`),
  cases
    .map(
      (x) =>
        `===== ${x.label} =====\nruntime=${x.runtime}  output=${x.outputInConfig}\n$ ${x.command}\nexit=${x.exitCode}  standalone=${x.standaloneEmitted}  worker.js=${x.workerEmitted}  elapsed=${x.ms}ms\n\n--- stdout ---\n${x.stdout}\n--- stderr ---\n${x.stderr}\n`,
    )
    .join("\n"),
  "utf8",
);

console.log(`\n  results/repro-opennext-standalone-${stamp}.json`);
console.log(`  results/repro-opennext-standalone-${stamp}.log`);

process.exitCode = verdict.startsWith("CONFIRMED") ? 0 : 1;
