// GitHub sign-in for `etium configure` (ADR-021, ADR-022). The identity is
// the DEPLOYMENT's, not the machine's: every gh call here runs against this
// checkout's own config dir (`.etium/gh`), where gh stores the token in its
// hosts.yml — 0600, file-held, gitignored with the rest of `.etium/`. The
// machine's personal gh sign-in is never read, never written, never fought
// over. Etium never reads, stores, or transports the credential itself: gh
// runs with the terminal inherited and the operator pastes the token
// straight into gh (MODEL_AUTH's delegation, applied to GitHub). File-held
// and repo-scoped, the sign-in works identically from ssh, cron, launchd,
// and the GUI — no GUI session anywhere in the path.

import { spawnSync } from "node:child_process";
import { ghConfigDir } from "./config.ts";

type Menu = (
  title: string,
  explain: string[],
  options: { label: string; value: string }[],
  defIdx: number,
) => Promise<string>;

const GH = () => process.env.ETIUM_GH_CMD ?? "gh";
const envFor = (repoDir: string) => ({ ...process.env, GH_CONFIG_DIR: ghConfigDir(repoDir) });

/** Pre-provisioning form for operators and agent reports: same sign-in,
 * no configure session needed. */
export function tokenCmdHint(repoDir: string): string {
  return `GH_CONFIG_DIR=${ghConfigDir(repoDir)} gh auth login -h github.com --with-token --insecure-storage`;
}

/** The deployment's signed-in login, or "" when there is none. */
export function repoLogin(repoDir: string): string {
  const r = spawnSync(GH(), ["api", "user", "--jq", ".login"], { encoding: "utf8", timeout: 15_000, env: envFor(repoDir) });
  return r.status === 0 ? (r.stdout || "").trim() : "";
}

/** gh's --with-token mode prints no prompt, echoes the paste, and waits for
 * EOF — hostile as a human interface. Own the prompt instead: a hidden
 * single-line read in sh (plain Enter ends it), piped straight into gh —
 * the token never passes through etium's process. Exported for the test
 * that proves the token reaches gh's stdin intact. */
export const TOKEN_READ_SCRIPT =
  'stty -echo 2>/dev/null; printf "Token (input hidden): " >&2; IFS= read -r t; ' +
  'stty echo 2>/dev/null; printf "\\n" >&2; [ -n "$t" ] && printf %s "$t" | "$GHBIN" auth login -h github.com --with-token --insecure-storage';

function runGhLogin(withToken: boolean, repoDir: string): boolean {
  // The questionnaire's readline leaves the tty in raw mode, where Ctrl-D
  // is a byte, not EOF — and a raw tty breaks line reads. Cooked first.
  if (process.stdin.isTTY) spawnSync("stty", ["sane"], { stdio: ["inherit", "ignore", "ignore"] });
  const env = { ...envFor(repoDir), GHBIN: GH() };
  if (!withToken) {
    // --insecure-storage here too: the token must land in the repo's own
    // hosts.yml, never the shared system keyring (repo-scoping's whole point).
    const r = spawnSync(GH(), ["auth", "login", "-h", "github.com", "--insecure-storage"], { stdio: "inherit", env });
    return r.status === 0;
  }
  spawnSync(GH(), ["auth", "logout", "-h", "github.com"], { stdio: "ignore", env }); // clean slate on re-sign-in
  const r = spawnSync("/bin/sh", ["-c", TOKEN_READ_SCRIPT], { stdio: "inherit", env });
  return r.status === 0;
}

/** Route this repository's git pushes through the deployment's gh sign-in:
 * local config only (never the machine's), with an empty first entry so
 * git stops consulting global helpers like osxkeychain — the same GUI
 * coupling one layer down (ADR-021). Worktrees inherit repo config. */
function setupRepoCredential(repoDir: string): void {
  spawnSync("git", ["-C", repoDir, "config", "--replace-all", "credential.https://github.com.helper", ""]);
  spawnSync("git", ["-C", repoDir, "config", "--add", "credential.https://github.com.helper", "!gh auth git-credential"]);
}

/** Get the deployment signed in and able to push, or explain exactly how.
 * Trust needs no configuring (ADR-022): anyone with Write commands. */
export async function ensureGhAuth(o: {
  installed: boolean;
  interactive: boolean;
  repoDir: string;
  repo: string;
  out: (t?: string) => void;
  menu: Menu;
  suspendInput?: () => void; // release the readline's grip on the tty before gh takes it
  resumeInput?: () => void;
}): Promise<{ ok: boolean; login?: string }> {
  const { out } = o;
  const env = envFor(o.repoDir);
  const run = (args: string[]) => spawnSync(GH(), args, { encoding: "utf8", timeout: 15_000, env });
  if (!o.installed) {
    out();
    out("GitHub wiring needs the GitHub CLI (gh):");
    out();
    out("  curl -sS https://webi.sh/gh | sh   (else https://cli.github.com)");
    out();
    out("Then run: etium configure");
    return { ok: false };
  }
  // The bar is what projections need: push. A wrong-account token, a
  // fine-grained token pointed at another owner's private repo, or a
  // non-collaborator all fail HERE with the cause named — never as 404s
  // at first tick.
  const checkAccess = (): boolean => {
    const push = (run(["api", `repos/${o.repo}`, "--jq", ".permissions.push"]).stdout || "").trim();
    if (push === "true") return true;
    out();
    out(`This deployment's sign-in can't push to ${o.repo}${push ? "" : " (not visible to this token)"}.`);
    out("Common causes: the token belongs to the wrong account; a fine-grained");
    out("token pointed at another owner's private repository (those can only");
    out("reach repos their own account owns — use a classic `repo`-scope");
    out("token); or the account isn't a collaborator with Write.");
    return false;
  };
  if (run(["auth", "status"]).status === 0) {
    if (checkAccess()) {
      setupRepoCredential(o.repoDir);
      return { ok: true, login: repoLogin(o.repoDir) };
    }
    if (!o.interactive) return { ok: false };
    out();
    out("Signing in again with a working token fixes this here:");
    // fall through to the sign-in menu — recovery stays in-product
  } else if (!o.interactive) {
    out();
    out("This repository has no deployment sign-in yet. Create one, then re-run:");
    out(`  ${tokenCmdHint(o.repoDir)}   (paste a repo-scoped token)`);
    return { ok: false };
  }

  const how = await o.menu(
    "GitHub sign-in",
    [
      "This repository gets its own GitHub sign-in, stored under .etium/gh —",
      "the machine's personal gh account is never touched, and the sign-in",
      "works from ssh, cron, launchd, and the GUI alike.",
    ],
    [
      { label: "Sign in with a token (headless-proof; recommended)", value: "token" },
      { label: "Sign in with the browser device flow", value: "web" },
    ],
    0,
  );
  if (how === "token") {
    out();
    out("Create a token while signed in as the account this deployment acts as:");
    out();
    out(`  • That account OWNS ${o.repo}: a fine-grained token scoped to it`);
    out("    (github.com/settings/personal-access-tokens/new) — Issues,");
    out("    Pull requests, Contents: read and write.");
    out(`  • That account is a COLLABORATOR on ${o.repo} (the usual bot setup):`);
    out("    fine-grained tokens cannot reach another owner's private repo —");
    out("    use a classic `repo`-scope token:");
    out("    github.com/settings/tokens/new?scopes=repo");
    out();
    out("Paste it below — input is hidden; press Enter when done. It goes");
    out("straight into gh — etium never sees or stores it.");
    out();
  }
  o.suspendInput?.();
  const ok = runGhLogin(how === "token", o.repoDir);
  o.resumeInput?.();
  if (!ok || run(["auth", "status"]).status !== 0) {
    out();
    out("gh sign-in did not complete — run etium configure again.");
    return { ok: false };
  }
  const login = repoLogin(o.repoDir);
  out();
  out(`  ok     gh — this deployment is signed in as ${login || "unknown"}`);
  if (!checkAccess()) return { ok: false };
  setupRepoCredential(o.repoDir);
  return { ok: true, login };
}
