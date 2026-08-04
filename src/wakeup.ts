// Always-on wake-up installation (§9, ADR-018, ADR-020), platform-correct.
// macOS: a launchd LaunchAgent in the gui session — the only scheduler
// context that can read the login keychain, where gh stores its token (cron
// runs in a different audit session and fails keychain reads; a LaunchDaemon
// needs sudo and has no session at all). Linux: a crontab line. `etium
// watch` stays the no-install foreground alternative.
//
// FROZEN on-machine ABI (ADR-020) — future versions must be able to find
// and remove everything today's version installs, so these never change:
//   1. the LaunchAgent label prefix   "dev.etium."
//   2. the label grammar              dev.etium.tick.<sanitized-basename>.<id>
//   3. the cron signature substring   "etium tick --surface github"
//      (the pre-0.14 command; enumeration still matches it forever —
//       lines installed today are identified by the marker, entry 4)
//   4. the identity marker            " # etium:<sanitized-basename>.<id>"
// Identity is MINTED, not derived: <id> comes from .etium/config.json
// (written once, preserved across re-runs), so a moved or renamed repo can
// still find its own artifacts. Removal never trusts name recomputation
// alone — it enumerates by prefix/signature and matches the embedded repo
// path or id, so even artifacts named by older grammars get cleaned up.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const PREFIX = "dev.etium.";
const SIGNATURE = "etium tick --surface github";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
const canon = (p: string) => {
  try {
    return fs.realpathSync(p); // one spelling per repo — symlinks and /tmp aliases must not fork identities
  } catch {
    return p;
  }
};

/** The tick command both installers schedule. PATH is baked in at configure
 * time — scheduler environments are bare, and "etium not found at 2am" is
 * not a failure mode worth having. The trailing comment is the identity
 * marker (inert under sh), so cron lines survive repo moves findably. */
export function tickCommand(repoDir: string, id: string): string {
  repoDir = canon(repoDir);
  // The command carries no wiring: tick reads .etium/config.json (ADR-030),
  // so configure re-runs change behavior without touching the scheduler.
  return `cd ${repoDir} && PATH="${process.env.PATH}" etium tick >> .etium/tick.log 2>&1 # etium:${sanitize(path.basename(repoDir))}.${id}`;
}

export function agentLabel(repoDir: string, id: string): string {
  repoDir = canon(repoDir);
  return `${PREFIX}tick.${sanitize(path.basename(repoDir))}.${id}`;
}

export function launchAgentPlist(label: string, cmd: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>-c</string>
    <string>${xml(cmd)}</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
</dict></plist>
`;
}

export function cronLine(cmd: string): string {
  return `* * * * * ${cmd}`;
}

// --- enumeration: the durable way to find our artifacts -------------------

function etiumAgents(): { plist: string; label: string; payload: string }[] {
  const dir = path.join(os.homedir(), "Library", "LaunchAgents");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(PREFIX) && f.endsWith(".plist"))
      .map((f) => {
        let payload = "";
        try {
          payload = fs.readFileSync(path.join(dir, f), "utf8");
        } catch {
          /* unreadable still gets removed by label */
        }
        return { plist: path.join(dir, f), label: f.slice(0, -".plist".length), payload };
      });
  } catch {
    return [];
  }
}

const belongsTo = (payload: string, repoDir: string, id?: string) =>
  payload.includes(xml(`cd ${repoDir} `)) || (id !== undefined && payload.includes(`.${id}<`));

export const cronBelongsTo = (line: string, repoDir: string, id?: string) =>
  (line.includes(SIGNATURE) || (line.includes(" etium tick ") && line.includes("# etium:"))) &&
  (line.includes(repoDir) || (id !== undefined && line.includes(`# etium:`) && line.endsWith(`.${id}`)));

function retireCronLines(repoDir: string, id?: string): boolean {
  const cur = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (cur.status !== 0) return false;
  const lines = cur.stdout.split("\n");
  const kept = lines.filter((l) => l && !cronBelongsTo(l, repoDir, id));
  if (kept.length === lines.filter(Boolean).length) return false;
  spawnSync("crontab", ["-"], { input: kept.concat("").join("\n"), encoding: "utf8" });
  return true;
}

// --- install / detect / remove --------------------------------------------

export function wakeupInstalled(repoDir: string): boolean {
  repoDir = canon(repoDir);
  if (process.platform === "darwin") return etiumAgents().some((a) => belongsTo(a.payload, repoDir));
  const cur = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  return cur.status === 0 && cur.stdout.split("\n").some((l) => cronBelongsTo(l, repoDir));
}

/** Remove this repository's always-on wake-up — by enumeration, never by
 * recomputed name alone, so artifacts from older label grammars (or a moved
 * repo, via `id`) are cleaned up too instead of stranding the machine. */
export function removeWakeup(repoDir: string, id?: string): string[] {
  repoDir = canon(repoDir);
  const lines: string[] = [];
  if (process.platform === "darwin") {
    const uid = process.getuid?.() ?? 501;
    for (const a of etiumAgents().filter((a) => belongsTo(a.payload, repoDir, id))) {
      spawnSync("launchctl", ["bootout", `gui/${uid}/${a.label}`], { stdio: "ignore" });
      try {
        fs.unlinkSync(a.plist);
      } catch {
        /* already gone */
      }
      lines.push(`Removed the launchd agent (${a.label}).`);
    }
  }
  if (retireCronLines(repoDir, id)) lines.push("Removed this repository's crontab entry.");
  return lines.length ? lines : ["No always-on wake-up was installed for this repository."];
}

/** One tick through the just-installed command, so the verdict comes from
 * the context that will actually run it — works identically over ssh. */
function verifyFirstTick(repoDir: string, cmd: string): { ok: boolean; lines: string[] } {
  const log = path.join(repoDir, ".etium", "tick.log");
  let before = 0;
  try {
    before = fs.statSync(log).size;
  } catch {
    /* first tick creates it */
  }
  spawnSync("/bin/sh", ["-c", cmd], { timeout: 120_000 });
  let appended = "";
  try {
    appended = fs.readFileSync(log, "utf8").slice(before);
  } catch {
    /* no log written */
  }
  const err = appended.split("\n").find((l) => l.includes("surface-error"));
  if (err)
    return {
      ok: false,
      lines: [
        "",
        "First tick ran — and reports a problem:",
        `  ${err.trim()}`,
        "",
        "Ticks retry every minute — fix the cause and it heals in place, or",
        "re-run: etium configure",
      ],
    };
  if (appended.trim()) return { ok: true, lines: ["", "First tick succeeded — the engineer is live."] };
  return { ok: true, lines: ["", `First tick wrote nothing — check ${log}`] };
}

/** Install the always-on wake-up; returns the lines to print. Idempotent
 * across re-runs and label-grammar changes: anything already installed for
 * this repository is removed first, then the current form is installed.
 * Mechanism is a platform constant (ADR-022): a launchd agent on macOS
 * (Apple's blessed scheduler — event triggers and prompt post-sleep ticks
 * later; runs while logged in, resumes at login), cron on Linux. Auth is
 * repo-scoped and file-held either way, so both verify inline. */
export function installWakeup(repoDir: string, id: string): { ok: boolean; lines: string[] } {
  repoDir = canon(repoDir);
  const cmd = tickCommand(repoDir, id);
  if (process.platform === "darwin") {
    for (const a of etiumAgents().filter((a) => belongsTo(a.payload, repoDir, id))) {
      spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${a.label}`], { stdio: "ignore" });
      try {
        fs.unlinkSync(a.plist);
      } catch {
        /* already gone */
      }
    }
    retireCronLines(repoDir, id); // an older etium may have used cron here
    const label = agentLabel(repoDir, id);
    const dir = path.join(os.homedir(), "Library", "LaunchAgents");
    const plist = path.join(dir, `${label}.plist`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(plist, launchAgentPlist(label, cmd));
    const r = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 501}`, plist], { encoding: "utf8" });
    if (r.status === 0) {
      const v = verifyFirstTick(repoDir, cmd);
      return {
        ok: v.ok,
        lines: [
          `Installed the launchd agent (${label}): ticks once a minute while`,
          "you're logged in, resumes at login (dedicated bot Macs: enable",
          "auto-login so a reboot resumes on its own).",
          ...v.lines,
        ],
      };
    }
    return {
      ok: false,
      lines: [
        `Could not load the agent — is a GUI session active? Wrote ${plist};`,
        `load it with:`,
        "",
        `  launchctl bootstrap gui/${process.getuid?.() ?? 501} ${plist}`,
      ],
    };
  }
  retireCronLines(repoDir, id);
  const line = cronLine(cmd);
  const cur = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  const kept = (cur.status === 0 ? cur.stdout : "").split("\n").filter(Boolean);
  const w = spawnSync("crontab", ["-"], { input: [...kept, line, ""].join("\n"), encoding: "utf8" });
  if (w.status !== 0) return { ok: false, lines: ["Could not edit crontab — install this line yourself:", "", `  ${line}`] };
  const v = verifyFirstTick(repoDir, cmd);
  return { ok: v.ok, lines: ["Installed the crontab entry (once a minute; no GUI session needed).", ...v.lines] };
}

/** `print` mode: show what always-on would do — installing nothing, and on
 * macOS writing nothing (a plist in ~/Library/LaunchAgents would auto-load
 * at next login, which is an install, not a printout). */
export function printWakeup(repoDir: string, id: string): string[] {
  const cmd = tickCommand(repoDir, id);
  if (process.platform === "darwin")
    return [
      "When you want always-on, run: etium configure --wakeup cron",
      "It installs a launchd agent running, once a minute:",
      "",
      `  ${cmd}`,
    ];
  return ["Install this crontab line when you want always-on:", "", `  ${cronLine(cmd)}`];
}
