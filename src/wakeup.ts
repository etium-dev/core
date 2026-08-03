// Always-on wake-up installation (§9, ADR-018), platform-correct. macOS: a
// launchd LaunchAgent in the gui session — the only scheduler context that
// can read the login keychain, where gh stores its token (cron runs in a
// different audit session and fails keychain reads; a LaunchDaemon needs
// sudo and has no session at all). Linux: a crontab line. `etium watch`
// stays the no-install foreground alternative.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The tick command both installers schedule. PATH is baked in at init time —
 * scheduler environments are bare, and "etium not found at 2am" is not a
 * failure mode worth having. */
export function tickCommand(repoDir: string, env: string): string {
  return `cd ${repoDir} && PATH="${process.env.PATH}" ${env} etium tick --surface github >> .etium/tick.log 2>&1`;
}

export function agentLabel(repoDir: string): string {
  return `dev.etium.tick.${createHash("sha256").update(repoDir).digest("hex").slice(0, 8)}`;
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

function retireCronLine(repoDir: string): void {
  const cur = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  if (cur.status !== 0 || !cur.stdout.includes("etium tick --surface github")) return;
  const kept = cur.stdout
    .split("\n")
    .filter((l) => l && !(l.includes("etium tick --surface github") && l.includes(repoDir)));
  spawnSync("crontab", ["-"], { input: kept.concat("").join("\n"), encoding: "utf8" });
}

/** Install the always-on wake-up; returns the lines to print. Idempotent:
 * re-running init replaces the agent (or the repo's cron line) in place. */
export function installWakeup(repoDir: string, env: string): string[] {
  const cmd = tickCommand(repoDir, env);
  if (process.platform === "darwin") {
    const label = agentLabel(repoDir);
    const dir = path.join(os.homedir(), "Library", "LaunchAgents");
    const plist = path.join(dir, `${label}.plist`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(plist, launchAgentPlist(label, cmd));
    const uid = process.getuid?.() ?? 501;
    spawnSync("launchctl", ["bootout", `gui/${uid}/${label}`], { stdio: "ignore" });
    const r = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { encoding: "utf8" });
    retireCronLine(repoDir); // an older etium may have installed a cron line here
    return r.status === 0
      ? [
          `Installed the launchd agent (${label}): ticks once a minute while`,
          "you're logged in, resumes at login. gh's token stays in your keychain.",
        ]
      : [`Wrote ${plist} — load it with:`, "", `  launchctl bootstrap gui/${uid} ${plist}`];
  }
  const line = cronLine(cmd);
  const cur = spawnSync("crontab", ["-l"], { encoding: "utf8" });
  const kept = (cur.status === 0 ? cur.stdout : "")
    .split("\n")
    .filter((l) => l && !(l.includes("etium tick --surface github") && l.includes(repoDir)));
  const w = spawnSync("crontab", ["-"], { input: [...kept, line, ""].join("\n"), encoding: "utf8" });
  return w.status === 0
    ? ["Installed the crontab entry (once a minute)."]
    : ["Could not edit crontab — install this line yourself:", "", `  ${line}`];
}

/** `print` mode: show what always-on would do — installing nothing, and on
 * macOS writing nothing (a plist in ~/Library/LaunchAgents would auto-load
 * at next login, which is an install, not a printout). */
export function printWakeup(repoDir: string, env: string): string[] {
  const cmd = tickCommand(repoDir, env);
  if (process.platform === "darwin")
    return [
      "When you want always-on, run: etium init --wakeup cron",
      "It installs a launchd agent (the scheduler that can read gh's keychain",
      "token) running, once a minute:",
      "",
      `  ${cmd}`,
    ];
  return ["Install this crontab line when you want always-on:", "", `  ${cronLine(cmd)}`];
}
