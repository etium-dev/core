// Persisted wiring (ADR-019): configure's memory, never the runtime's input.
// `etium configure` records the non-secret answers it applied, so later
// invocations can manage state — install or remove the wake-up, show status
// — without re-interrogating the operator. The runtime contract is
// unchanged: tick and the github surface read env vars only; this file only
// reconstructs the commands configure itself prints and runs. No secrets
// live here — GitHub auth is gh's, model auth is the harness's (ADR-007).

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface EtiumConfig {
  v: 1;
  /** Mint-once deployment identity (8 hex): names this checkout's wake-up
   * artifacts (ADR-020) and survives repo moves — never re-minted. */
  id: string;
  library: string; // ralph | ai-engineer | none
  /** Who acts and who commands are not config (ADR-022): the deployment
   * acts as its repo-scoped gh sign-in, and anyone with Write commands. */
  github: { repo: string; loop: string } | null;
  /** Default loop params for every run this deployment creates (ADR-025):
   * merged under task/flag params, so explicit values always win. This is
   * where `harness`, `harness.<step>`, `model.<step>`, `rounds`, … live. */
  params?: Record<string, string>;
  /** Named param bundles a loop can select per run from the operator's words
   * (ADR-037). `describe` guides the interpreter's match; `params` is the
   * overlay it applies. Carried to the loop as the `modes` run-param. */
  modes?: Record<string, { describe?: string; params?: Record<string, string> }>;
}

/** The deployment's own gh home (ADR-022): sign-in stored by gh, in a file,
 * inside this checkout's .etium — the machine's gh is never touched. */
export function ghConfigDir(repoDir: string): string {
  return path.join(repoDir, ".etium", "gh");
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

/** Write the config, minting `id` on first write and preserving it forever
 * after — re-minting would orphan the wake-up artifacts the id names. */
export function writeConfig(base: string, cfg: Omit<EtiumConfig, "id"> & { id?: string }): EtiumConfig {
  const prev = readConfig(base);
  // `id` and hand-edited `params`/`modes` survive re-runs that don't set them.
  const full: EtiumConfig = { params: prev?.params, modes: prev?.modes, ...cfg, id: cfg.id ?? prev?.id ?? randomBytes(4).toString("hex") };
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(cfgPath(base), JSON.stringify(full, null, 2) + "\n");
  return full;
}

/** Deployment-default params (ADR-025) — {} when unconfigured. Callers
 * spread this UNDER explicit params: config never overrides an explicit
 * flag, task field, or surface-computed value. */
export function defaultParams(base: string): Record<string, string> {
  return readConfig(base)?.params ?? {};
}

/** The mode catalog carried to the loop as one run-param (ADR-037): loops
 * that don't offer modes never see it, so behavior is unchanged without it. */
export function modesParam(base: string): Record<string, string> {
  const m = readConfig(base)?.modes;
  return m && Object.keys(m).length ? { modes: JSON.stringify(m) } : {};
}

export function ghEnv(g: NonNullable<EtiumConfig["github"]>): string {
  return `ETIUM_GH_REPO=${g.repo} ETIUM_GH_LOOP=${g.loop}`;
}

/** The `status` action's view of a repository, ready to print. */
export function statusLines(cfg: EtiumConfig | null, wakeOn: boolean, base: string, cwd: string, login?: string): string[] {
  const runsDir = path.join(base, "runs");
  return [
    `  library   ${cfg?.library ?? "none recorded"}`,
    `  params    ${cfg?.params && Object.keys(cfg.params).length ? Object.entries(cfg.params).map(([k, v]) => `${k}=${v}`).join(" ") : "none (loop defaults rule)"}`,
    `  modes     ${cfg?.modes && Object.keys(cfg.modes).length ? Object.keys(cfg.modes).join(", ") : "none"}`,
    `  github    ${cfg?.github ? `${cfg.github.repo} (loop: ${cfg.github.loop || "your own"}; commands: anyone with Write)` : "off"}`,
    `  identity  ${cfg?.github ? (login ? `signed in as ${login} (this repository's own gh sign-in)` : "not signed in — re-run setup") : "-"}`,
    `  wake-up   ${wakeOn ? "installed — ticks once a minute" : "not installed"}`,
    `  runs      ${fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0} under ${path.relative(cwd, runsDir) || "."}/`,
  ];
}
