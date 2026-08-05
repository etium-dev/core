// Machine probes behind `etium configure`'s checks (§9). The didactic
// printing stays in the CLI; the probing logic lives here.

import * as fs from "node:fs";
import * as path from "node:path";
import { allAdapters } from "./adapters.ts";
import { checkHarnessAuth } from "./runner.ts";

/** Every distinct etium install reachable via PATH, in serving order —
 * the first entry is the one that runs. Two or more is a shadow pair:
 * updates land in a copy the shell never executes. */
export function etiumsOnPath(): string[] {
  const seen = new Map<string, string>(); // realpath -> first PATH entry serving it
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, "etium");
    try {
      fs.accessSync(p, fs.constants.X_OK);
      const real = fs.realpathSync(p);
      if (!seen.has(real)) seen.set(real, p);
    } catch {
      /* not in this dir */
    }
  }
  return [...seen.values()];
}

/** True when this checkout IS the loop-library source (@etium/core) —
 * where "clone" and "source" would collide: replace must refuse, and the
 * deployment's loop belongs in a pin under .etium/loop (ADR-034). */
export function isLibrarySource(repoDir: string): boolean {
  try {
    return (JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")) as { name?: string }).name === "@etium/core";
  } catch {
    return false;
  }
}

/** Configure's loop-placement question, asked only in the library-source
 * checkout (ADR-034): the deployment runs a pin under .etium/loop, or the
 * source tree live. Re-runs manage the pin (keep / refresh). */
export function loopPlacement(hasPin: boolean): { explain: string[]; options: { label: string; value: string }[] } {
  return {
    explain: [
      "This checkout is the loop library's source. The deployment can run a",
      "pinned copy of the installed etium's library under .etium/loop —",
      "untouched by your source edits — or run the source tree live, where",
      "uncommitted template edits drive the agents and can diverge runs.",
    ],
    options: hasPin
      ? [
          { label: "pinned — keep the existing .etium/loop copy", value: "keep" },
          { label: "pinned — refresh .etium/loop from the installed etium (old copy moves aside)", value: "refresh" },
          { label: "live — run the source tree directly", value: "live" },
        ]
      : [
          { label: "pinned — copy the installed library to .etium/loop (recommended)", value: "new" },
          { label: "live — run the source tree directly", value: "live" },
        ],
  };
}

/** Options for configure's default-harness question: installed first, then
 * known-but-absent (you may be installing it later), then skip. */
export function harnessOptions(installed: string[], current?: string): { options: { label: string; value: string }[]; defIdx: number } {
  const all = allAdapters().map((a) => a.id).filter((id) => id !== "exec" && id !== "replay");
  const options = [
    ...all.filter((id) => installed.includes(id)).map((id) => ({ label: `${id} — installed`, value: id })),
    ...all.filter((id) => !installed.includes(id)).map((id) => ({ label: `${id} — not found on PATH`, value: id })),
    { label: "skip — loops use their own default", value: "" },
  ];
  const cur = options.findIndex((o) => o.value === current);
  return { options, defIdx: cur >= 0 ? cur : 0 };
}

/** One ok/needs line per harness the params reference — `harness` and every
 * `harness.<step>` — probed with the same gate runs hit (ADR-025), so "this
 * persona's harness isn't ready" is caught at configure time, not mid-run. */
export function harnessParamLines(params: Record<string, string>): string[] {
  return Object.entries(params)
    .filter(([k]) => k === "harness" || k.startsWith("harness."))
    .map(([k, v]) => {
      try {
        const r = checkHarnessAuth(v);
        return r.ok ? `  ok     ${k} = ${v} — ready` : `  needs  ${k} = ${v}: ${r.detail}`;
      } catch {
        return `  needs  ${k} = ${v}: unknown harness (available: ${allAdapters().map((a) => a.id).join(", ")})`;
      }
    });
}
