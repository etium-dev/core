// Wake-up generators (ADR-018, ADR-020). Pure-function tests only: launchctl
// and crontab are never invoked from the suite — the apply path is
// field-verified. Identity is minted (config.json), not derived: the label
// carries the sanitized basename for humans and the id as tie-breaker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLabel, cronBelongsTo, cronLine, launchAgentPlist, tickCommand } from "../src/wakeup.ts";

test("wakeup generators: identity-named label, marker in command, escaped plist, PATH baked in", () => {
  const cmd = tickCommand("/tmp/repo", "cafe0123");
  assert.ok(cmd.startsWith("cd /tmp/repo && "));
  assert.ok(cmd.includes('PATH="'), "scheduler environments are bare; PATH must ride along");
  assert.ok(!cmd.includes("ETIUM_GH_") && !cmd.includes("--surface"), "the line carries no wiring — tick reads config (ADR-030)");
  assert.ok(cmd.includes(" etium tick "), "bare tick is the whole tick");
  assert.ok(cmd.includes(">> .etium/tick.log 2>&1 #"), "identity marker rides after the redirect");
  assert.ok(cmd.endsWith(" # etium:repo.cafe0123"), "marker = sanitized basename + minted id");

  assert.equal(agentLabel("/tmp/repo", "cafe0123"), "dev.etium.tick.repo.cafe0123");
  assert.equal(agentLabel("/tmp/My Repo!", "cafe0123"), "dev.etium.tick.My-Repo.cafe0123"); // label-safe
  assert.notEqual(agentLabel("/tmp/repo", "cafe0123"), agentLabel("/tmp/repo", "beef4567")); // id is the tie-breaker

  const plist = launchAgentPlist("dev.etium.tick.repo.cafe0123", cmd);
  assert.ok(plist.includes("<string>dev.etium.tick.repo.cafe0123</string>"));
  assert.ok(plist.includes("<integer>60</integer>"));
  assert.ok(plist.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(plist.includes("&amp;&amp;"), "shell && must be XML-escaped");
  assert.ok(plist.includes("&gt;&gt;"), "log redirect must be XML-escaped");
  assert.ok(!plist.includes("&& "), "no raw ampersands may survive in the plist");

  assert.equal(cronLine(cmd), `* * * * * ${cmd}`);

  // Frozen-ABI enumeration (ADR-020): lines installed by ANY past version
  // must stay findable. Pre-0.14 lines carry the old signature + env; new
  // lines are identified by the marker. Both match; strangers don't.
  const oldLine = `* * * * * cd /tmp/repo && PATH="/x" ETIUM_GH_REPO=a/b ETIUM_GH_LOOP=x.ts etium tick --surface github >> .etium/tick.log 2>&1 # etium:repo.cafe0123`;
  assert.ok(cronBelongsTo(oldLine, "/tmp/repo", "cafe0123"), "old-signature lines still enumerate");
  assert.ok(cronBelongsTo(cronLine(cmd), "/tmp/repo", "cafe0123"), "new marker-identified lines enumerate");
  assert.ok(!cronBelongsTo(`* * * * * /usr/bin/backup.sh # nightly`, "/tmp/repo", "cafe0123"), "foreign lines untouched");
});
