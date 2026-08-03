// Wake-up generators (ADR-018). Pure-function tests only: launchctl and
// crontab are never invoked from the suite — the apply path is field-verified.

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLabel, cronLine, launchAgentPlist, tickCommand } from "../src/wakeup.ts";

test("wakeup generators: per-repo label, escaped plist, once a minute, PATH baked in", () => {
  const cmd = tickCommand("/tmp/repo", "ETIUM_GH_REPO=a/b ETIUM_GH_LOOP=x/loop.ts");
  assert.ok(cmd.startsWith("cd /tmp/repo && "));
  assert.ok(cmd.includes('PATH="'), "scheduler environments are bare; PATH must ride along");
  assert.ok(cmd.includes("ETIUM_GH_REPO=a/b"));
  assert.ok(cmd.endsWith(">> .etium/tick.log 2>&1"));

  const label = agentLabel("/tmp/repo");
  assert.match(label, /^dev\.etium\.tick\.[0-9a-f]{8}$/);
  assert.notEqual(label, agentLabel("/tmp/other"), "one agent per repo — labels must not collide");

  const plist = launchAgentPlist(label, cmd);
  assert.ok(plist.includes(`<string>${label}</string>`));
  assert.ok(plist.includes("<integer>60</integer>"));
  assert.ok(plist.includes("<key>RunAtLoad</key><true/>"));
  assert.ok(plist.includes("&amp;&amp;"), "shell && must be XML-escaped");
  assert.ok(plist.includes("&gt;&gt;"), "log redirect must be XML-escaped");
  assert.ok(!plist.includes("&& "), "no raw ampersands may survive in the plist");

  assert.equal(cronLine(cmd), `* * * * * ${cmd}`);
});
