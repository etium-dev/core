// Machine probes behind `etium configure`'s checks (§9). The didactic
// printing stays in the CLI; the probing logic lives here.

import * as fs from "node:fs";
import * as path from "node:path";

/** On macOS over SSH, a failed `gh auth status` is unverifiable, not
 * definitive: gh keeps its token in the login keychain, which other audit
 * sessions (ssh, cron) cannot read even while the GUI session uses it
 * happily (ADR-018). The wake-up runs in the GUI session, so the honest
 * check happens there — at first tick — not here. */
export function ghUnverifiableHere(platform = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  return platform === "darwin" && !!(env.SSH_CONNECTION || env.SSH_TTY);
}

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
