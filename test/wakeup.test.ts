// Wake-up generators (ADR-018, ADR-020). Pure-function tests only: launchctl
// and crontab are never invoked from the suite — the apply path is
// field-verified. Identity is minted (config.json), not derived: the label
// carries the sanitized basename for humans and the id as tie-breaker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLabel, cronLine, launchAgentPlist, tickCommand } from "../src/wakeup.ts";

test("wakeup generators: identity-named label, marker in command, escaped plist, PATH baked in", () => {
  const cmd = tickCommand("/tmp/repo", "ETIUM_GH_REPO=a/b ETIUM_GH_LOOP=x/loop.ts", "cafe0123");
  assert.ok(cmd.startsWith("cd /tmp/repo && "));
  assert.ok(cmd.includes('PATH="'), "scheduler environments are bare; PATH must ride along");
  assert.ok(cmd.includes("ETIUM_GH_REPO=a/b"));
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
});
