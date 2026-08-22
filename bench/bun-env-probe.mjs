import { execSync, spawnSync, execFileSync } from "node:child_process";

// 起動後に環境変数を立てる（アダプタがやっているのと同じこと）
process.env.PROBE_AFTER_START = "true";

const read = (fn, label) => {
  try {
    return `${label}: ${fn().toString().trim() || "(empty)"}`;
  } catch (e) {
    return `${label}: ERROR ${e.message.slice(0, 60)}`;
  }
};

console.log(`runtime            : ${typeof Bun !== "undefined" ? "bun " + Bun.version : "node " + process.version}`);
console.log(`process.env 自身   : ${process.env.PROBE_AFTER_START}`);
console.log(read(() => execSync('printenv PROBE_AFTER_START || echo "(未伝播)"'), "execSync       "));
console.log(read(() => spawnSync("printenv", ["PROBE_AFTER_START"]).stdout, "spawnSync      "));
console.log(read(() => execFileSync("printenv", ["PROBE_AFTER_START"]), "execFileSync   "));
console.log(read(() => execSync('node -e "console.log(process.env.PROBE_AFTER_START ?? \\"(未伝播)\\")"'), "child node     "));
