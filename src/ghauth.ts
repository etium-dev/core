// GitHub sign-in for `etium configure` (ADR-021). Etium never reads,
// stores, or transports the credential: gh runs with the terminal
// inherited and the user pastes the token straight into gh (MODEL_AUTH's
// delegation, applied to GitHub). Token sign-in is the headless-proof
// path — gh stores it in its own hosts.yml (0600), readable from ssh,
// cron, launchd, and the GUI alike, so no step of setup or operation ever
// needs a GUI session. A fine-grained token scoped to one repository also
// beats a keychain-held all-repo OAuth token on blast radius.

import { spawnSync } from "node:child_process";

type Menu = (
  title: string,
  explain: string[],
  options: { label: string; value: string }[],
  defIdx: number,
) => Promise<string>;
type Sh = (cmd: string, args: string[]) => { status: number | null; stdout: string };

const TOKEN_CMD = "gh auth login -h github.com --with-token --insecure-storage";

function runGhLogin(withToken: boolean): boolean {
  // The questionnaire's readline leaves the tty in raw mode, where Ctrl-D
  // is a byte, not EOF — gh would read stdin forever and Ctrl-C couldn't
  // interrupt. Hand gh a cooked terminal.
  if (process.stdin.isTTY) spawnSync("stty", ["sane"], { stdio: ["inherit", "ignore", "ignore"] });
  const args = withToken
    ? ["auth", "login", "-h", "github.com", "--with-token", "--insecure-storage"]
    : ["auth", "login", "-h", "github.com"];
  const r = spawnSync(process.env.ETIUM_GH_CMD ?? "gh", args, { stdio: "inherit" });
  return r.status === 0;
}

/** Get gh into a usable state for wiring, or explain exactly how. Returns
 * the (possibly fresh) login when it can be resolved. */
export async function ensureGhAuth(o: {
  installed: boolean;
  authed: boolean;
  unverifiable: boolean; // darwin-over-ssh: keychain unreadable, not proof of anything
  interactive: boolean;
  repo: string;
  out: (t?: string) => void;
  menu: Menu;
  sh: Sh;
  suspendInput?: () => void; // release the readline's grip on the tty before gh takes it
  resumeInput?: () => void;
}): Promise<{ ok: boolean; login?: string }> {
  const { out } = o;
  if (!o.installed) {
    out();
    out("GitHub wiring needs the GitHub CLI (gh):");
    out();
    out("  curl -sS https://webi.sh/gh | sh   (else https://cli.github.com)");
    out();
    out("Then run: etium configure");
    return { ok: false };
  }
  if (o.authed) return { ok: true };
  if (!o.interactive) {
    if (o.unverifiable) return { ok: true }; // agent-driven over ssh; step-level checks verify for real
    out();
    out("gh isn't signed in. Sign in, then re-run etium configure:");
    out(`  headless / bot machine:  ${TOKEN_CMD}   (paste a repo-scoped token)`);
    out("  interactive:             gh auth login");
    return { ok: false };
  }

  const how = await o.menu(
    "GitHub sign-in",
    o.unverifiable
      ? [
          "gh's sign-in lives in the macOS login keychain, which SSH sessions",
          "cannot read. Token sign-in is the sturdy path for a machine driven",
          "over SSH: it works from ssh, cron, and launchd alike — no GUI needed.",
        ]
      : [
          "gh isn't signed in on this machine. Token sign-in is the sturdy path",
          "for bot machines: it works from ssh, cron, and launchd alike.",
        ],
    [
      { label: "Sign in with a token now (headless-proof; recommended)", value: "token" },
      { label: "Sign in with the browser device flow", value: "web" },
      ...(o.unverifiable
        ? [{ label: "Keep the GUI-keychain sign-in (wake-up will need a GUI session)", value: "keep" }]
        : []),
    ],
    0,
  );
  if (how === "keep") return { ok: true };
  if (how === "token") {
    out();
    out(`Create a fine-grained personal access token — signed in as the account`);
    out(`the engineer acts as (you, or the bot):`);
    out();
    out("  https://github.com/settings/personal-access-tokens/new");
    out();
    out(`  Repository access:  only ${o.repo}`);
    out("  Permissions:        Issues, Pull requests, Contents — read and write");
    out();
    out("Paste it at gh's prompt below (press Enter, then Ctrl-D). It goes");
    out("straight into gh — etium never sees or stores it.");
    out();
  }
  o.suspendInput?.();
  const ok = runGhLogin(how === "token");
  o.resumeInput?.();
  if (!ok) {
    out();
    out("gh sign-in did not complete — run etium configure again.");
    return { ok: false };
  }
  if (o.sh("gh", ["auth", "status"]).status !== 0) {
    out("gh still reports no sign-in — run etium configure again.");
    return { ok: false };
  }
  const login = (o.sh("gh", ["api", "user", "--jq", ".login"]).stdout || "").trim();
  // Route git's own pushes through gh too: otherwise HTTPS remotes use the
  // osxkeychain helper — the same GUI-only wall, one layer down (ADR-021).
  spawnSync(process.env.ETIUM_GH_CMD ?? "gh", ["auth", "setup-git"], { stdio: "ignore" });
  out();
  out(`  ok     gh — signed in as ${login || "unknown"}; git pushes authenticate through gh`);
  return { ok: true, login };
}
