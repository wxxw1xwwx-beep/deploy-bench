import { execSync, spawnSync } from "node:child_process";
process.env.PROBE_AFTER_START = "true";
const rt = typeof Bun !== "undefined" ? "bun " + Bun.version : "node " + process.version;
const g = (o) => { try { return (execSync('printenv PROBE_AFTER_START || echo "(未伝播)"', o) || "").toString().trim(); } catch { return "ERROR"; } };
console.log(`${rt}`);
console.log(`  execSync  env省略        : ${g(undefined)}`);
console.log(`  execSync  env: process.env: ${g({ env: process.env })}`);
const s = spawnSync("printenv", ["PROBE_AFTER_START"], { env: process.env });
console.log(`  spawnSync env: process.env: ${(s.stdout||"").toString().trim() || "(empty)"}`);
