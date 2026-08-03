#!/usr/bin/env node
// LOC budgets are part of the public contract (DESIGN §12) and enforced in CI.
// Raw line counts, comments included: verbosity spends the budget too.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const count = (p) => readFileSync(p, "utf8").split("\n").length - 1;
const srcFiles = readdirSync("src").filter((f) => f.endsWith(".ts"));
const core = srcFiles.filter((f) => f !== "adapters.ts" && f !== "cli.ts" && f !== "github.ts");

const rows = [
  ["core (src minus adapters, cli, github)", core.reduce((n, f) => n + count(join("src", f)), 0), 3000],
  ["adapters (src/adapters.ts)", count("src/adapters.ts"), 900],
  ["github surface (src/github.ts)", count("src/github.ts"), 450],
  ["cli (src/cli.ts)", count("src/cli.ts"), 1000],
  ...readdirSync("loops").filter((f) => /\.(js|ts)$/.test(f)).map((f) => [`loop ${f}`, count(join("loops", f)), 150]),
  ["ai-engineer loop (ai-engineer/loop.ts)", count("ai-engineer/loop.ts"), 150],
];
let fail = false;
for (const [name, loc, budget] of rows) {
  const over = loc > budget;
  if (over) fail = true;
  console.log(`${String(name).padEnd(34)} ${String(loc).padStart(5)} / ${budget}${over ? "  OVER BUDGET" : ""}`);
}
process.exit(fail ? 1 : 0);
