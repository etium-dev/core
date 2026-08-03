// install.sh's shadow-pair guard (inherited from pi's installer): when npm's
// global prefix is root-owned AND already contains etium, the installer must
// refuse to mint a second install in ~/.local — one machine, one etium.
// Hermetic: the refusal happens before any network access.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("install.sh: refuses to install beside an existing etium in an unwritable npm prefix", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-blocker-"));
  const prefix = path.join(root, "prefix");
  fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
  fs.mkdirSync(path.join(prefix, "lib"), { recursive: true });
  fs.writeFileSync(path.join(prefix, "bin", "etium"), "#!/bin/sh\necho 0.0.0\n", { mode: 0o755 });
  // Simulate the root-owned prefix of a system-installed Node.
  fs.chmodSync(path.join(prefix, "lib"), 0o555);
  fs.chmodSync(path.join(prefix, "bin"), 0o555);
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  try {
    const r = spawnSync("/bin/sh", [path.resolve("docs/install.sh")], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, npm_config_prefix: prefix },
      input: "",
      timeout: 60_000,
    });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    assert.notEqual(r.status, 0, out);
    assert.match(out, /already installed at/i);
    assert.match(out, /uninstall/);
  } finally {
    fs.chmodSync(path.join(prefix, "lib"), 0o755);
    fs.chmodSync(path.join(prefix, "bin"), 0o755);
  }
});
