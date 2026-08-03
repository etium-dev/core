// Persisted wiring (ADR-019): configure's memory, never the runtime's input.
// `etium configure` records the non-secret answers it applied, so later
// invocations can manage state — install or remove the wake-up, show status
// — without re-interrogating the operator. The runtime contract is
// unchanged: tick and the github surface read env vars only; this file only
// reconstructs the commands configure itself prints and runs. No secrets
// live here — GitHub auth is gh's, model auth is the harness's (ADR-007).

import * as fs from "node:fs";
import * as path from "node:path";

export interface EtiumConfig {
  v: 1;
  library: string; // ralph | ai-engineer | none
  github: { repo: string; trusted: string; agent: string; loop: string } | null;
}

const cfgPath = (base: string) => path.join(base, "config.json");

export function readConfig(base: string): EtiumConfig | null {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath(base), "utf8")) as EtiumConfig;
    return c && c.v === 1 ? c : null;
  } catch {
    return null;
  }
}

export function writeConfig(base: string, cfg: EtiumConfig): void {
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(cfgPath(base), JSON.stringify(cfg, null, 2) + "\n");
}

export function ghEnv(g: NonNullable<EtiumConfig["github"]>): string {
  return `ETIUM_GH_REPO=${g.repo} ETIUM_GH_TRUSTED=${g.trusted} ETIUM_GH_AGENT=${g.agent} ETIUM_GH_LOOP=${g.loop}`;
}

/** The `status` action's view of a repository, ready to print. */
export function statusLines(cfg: EtiumConfig | null, wakeOn: boolean, base: string, cwd: string): string[] {
  const runsDir = path.join(base, "runs");
  return [
    `  library   ${cfg?.library ?? "none recorded"}`,
    `  github    ${cfg?.github ? `${cfg.github.repo} (trusted: ${cfg.github.trusted}; acts as ${cfg.github.agent}; loop: ${cfg.github.loop || "your own"})` : "off"}`,
    `  wake-up   ${wakeOn ? "installed — ticks once a minute" : "not installed"}`,
    `  runs      ${fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0} under ${path.relative(cwd, runsDir) || "."}/`,
  ];
}
