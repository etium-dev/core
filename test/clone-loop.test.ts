// `etium clone-loop`: bundled loop libraries are copy-and-own content —
// cloned out of the installed package into the user's repo, never
// overwritten, with .etium/ kept out of the receiving repo's git.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { main } from "../src/cli.ts";

test("clone-loop: copies the library, ignores .etium/, never overwrites, rejects unknowns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "etium-clone-"));
  const dest = path.join(root, "ai-engineer");

  assert.equal(await main(["clone-loop", "ai-engineer", "--into", dest]), 0);
  assert.ok(fs.existsSync(path.join(dest, "loop.ts")));
  assert.ok(fs.existsSync(path.join(dest, "TUTORIAL.md")));
  assert.equal(fs.readdirSync(path.join(dest, "templates")).filter((f) => f.endsWith(".md")).length, 7);
  assert.ok(fs.readFileSync(path.join(root, ".gitignore"), "utf8").split("\n").includes(".etium/"));

  assert.equal(await main(["clone-loop", "ai-engineer", "--into", dest]), 1); // never overwrite
  assert.equal(await main(["clone-loop", "no-such-library"]), 2);
  assert.equal(await main(["clone-loop"]), 0); // bare form lists
});
