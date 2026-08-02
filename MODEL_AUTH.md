# How Etium Does Model Auth

Status: position paper, agreed 2026-08-02. This document records the reasoning
and the chosen direction; the technical design lives in DESIGN.md (§6.3, §9,
§10.1) and DECISIONS.md ADR-007, and preserves the conclusions here. One
refinement made there: because harness choice can be runtime data, the
creation-time preflight is best-effort, and the authoritative check runs
before each step's first spawn — before anything is recorded, so "fix auth,
resume" replays cleanly.

"Model auth" deliberately, not "auth": etium touches three credential domains
and they must not be conflated. **Model auth** — how a harness authenticates to
its LLM provider (this document). **Publication credentials** — `GH_TOKEN` and
kin, governed by env profiles (DESIGN §9). **Decision authorization** — who may
approve a gate (DESIGN §8). This document is only about the first.

---

## The question

Every harness etium drives needs credentials to call its model. Who owns them?

Two extremes bound the space:

1. **Full delegation.** Each harness authenticates itself — its own login
   command, its own credential store. Etium just spawns processes and knows
   nothing. Purest philosophically; but it can mean per-harness manual setup
   before a user's first run, and (worse) auth failures that surface as
   cryptic errors deep inside a step's raw log.

2. **Etium as credential broker.** Etium stores provider keys and injects them
   into steps. One setup surface, uniform UX; but etium takes on secret
   storage and everything downstream of it.

The prior draft of DESIGN §11 pre-judged this ("no credential brokering") —
but the question deserved to be decided on its merits, and we re-examined it
against the two best references: Pi as the minimal-harness archetype, and
OpenHands as the closest prior art to what etium is — an orchestrator that
supervises agents.

## What the references actually do

**Pi** supports API keys (env vars, `--api-key`) and subscription OAuth
(`/login`) and keeps everything in one flat `~/.pi/agent/auth.json` — 0600
permissions, lockfile-guarded token auto-refresh so concurrent processes can't
double-refresh, one documented precedence order. Critically, Pi's headless
RPC/JSON mode has **no auth parameters at all**. The contract is:
authenticate once, out-of-band; headless invocations then just work off the
store and inherited env. Even the most minimalist harness assumes the layer
above it does *not* handle auth.

**OpenHands** brokers credentials — it has no choice, because its inner loop
calls models directly. What that one obligation grew into is the instructive
part: a settings store plus a separate secrets store, API keys in plaintext
JSON in the OSS version (encryption at rest is an enterprise feature), an API
that must be careful never to echo keys back, an `OH_SECRET_KEY` whose
rotation permanently orphans encrypted values, recurring self-hosting
complaints about secret-file permissions, env-precedence surprises
(`--override-with-envs`), and open, unresolved issues about brokered
credentials being over-privileged when handed to agents.

## The insights

**The baggage has a floor and a multiplier.** The floor — store credentials,
refresh OAuth tokens, define precedence — is irreducible *for anything that
calls models*. Pi pays the floor and pays it well. The multiplier is every
additional surface through which stored credentials can be reached: OpenHands'
REST API, GUI, persisted conversations, container mounts, and server→agent
trust boundary each spawned their own obligation class. Pi does auth "better"
than OpenHands mostly by having less product around the keys, not by superior
engineering of the store itself. The multiplier is where the pain lives — and
etium's surfaces (a greppable ledger, `rsync`-able run directories,
files-as-API) are exactly the kind that make stored secrets leak-prone.

**Etium is the only layer that can pay zero.** Pi must own model auth;
OpenHands must own model auth; both call models. Etium's core never does —
that invariant means etium alone gets the option of not paying the floor at
all. Brokering would additionally cost an N×M mapping (translating stored
credentials into each harness's expected intake: this env var for Pi, that
file for Codex, the keychain for Claude Code) that neither reference has,
because each is only itself.

**Subscription auth cannot be brokered — and it's what users actually have.**
The dominant, cheapest way people run these harnesses is subscription OAuth
(Claude Pro/Max in Claude Code, ChatGPT plans in Codex, both via `/login` in
Pi). Those tokens are tied to the harness product: refresh flows live in the
harness's store, and Anthropic policy explicitly bans third-party use of
Claude subscription OAuth tokens (which is why OpenHands ships subscription
login for OpenAI only, and why even Pi's Anthropic `/login` sits in policy
gray territory). A brokering etium could only ever inject raw API keys — the
most expensive mode, and not how its target users already work. Delegation is
not just cleaner; it is the only path to the auth mode users actually want,
with the vendor-policy risk staying where it belongs: between each harness
and its vendor.

**Delegation's real weakness is legibility, not setup.** Etium's target user
already runs these harnesses interactively, so delegation adds *zero* setup
for tools they already use. The genuine failure mode is silent asymmetry: a
credential-free step environment lets file/keychain-based auth work by
accident (through `HOME`) while env-var-based auth breaks mysteriously,
mid-run, with the evidence buried in a raw log. Silent success and silent
failure from the same mechanism. That is a fixable UX bug, not an argument
for brokering.

## The chosen middle ground: delegation, made legible

Auth stays harness-owned. Etium never stores, never prompts, never refreshes,
never OAuths. What etium adds is exactly the two things neither extreme
provides:

1. **Declared passthrough, not brokering.** Each adapter declares which env
   vars its harness consumes for credentials. The runner passes those through
   from the host environment when present — inherited at spawn time, stored
   nowhere — and registers their values with the existing redaction machinery.
   The ledger records the *names* passed through, never values. Etium holds
   nothing; it just widens the step environment deliberately and auditably
   instead of accidentally.

2. **Preflight, fail-closed, name the fix.** Before a run is created, etium
   checks that every harness the loop references exists and is authenticated
   (via each harness's own cheap status check, declared per-adapter). On
   failure it refuses to start and prints the harness's own remedy — "run
   `codex login`" — converting delegation's setup friction into one
   front-loaded moment with exact instructions, instead of a mystery forty
   minutes into step three. Runs fail closed, like gates.

Plus one documentation obligation: since store-based auth flows through
`HOME`, users who wrap harnesses in containers (the sanctioned isolation
path) must mount the harness's auth directory. A paragraph in the
loop-authoring guide, not a mechanism.

## The trade-off, recorded honestly

Declared passthrough means an `agent`-profile step is no longer strictly
credential-free: it may carry the model-provider credentials its adapter
declared (and, via `HOME`, always could reach harness credential stores).
The invariant that matters survives, sharpened: **publication credentials
never enter agent-controlled steps; model credentials enter only by adapter
declaration, and every passed-through value is redacted from raw.** That is a
more truthful statement of DESIGN Invariant 8 than "credential-free," which
the `HOME` passthrough already quietly violated in spirit. DESIGN §9 and the
§11 non-goal ("no credential brokering beyond env profiles and redaction")
should be amended to say this — the non-goal itself stands.

## What this rules out

- No etium credential store, vault, keychain integration, or encryption layer.
- No `etium login`, no OAuth flows, no token refresh in core.
- No settings surface for keys — no config field whose value is a secret.
- The OpenHands adapter drives the CLI's headless mode (which reads its own
  settings), not the agent-server (whose contract expects LLM credentials
  in-band — exactly the brokering rejected here).

If a future feature seems to need any of these, the answer is a harness, a
wrapper command, or the user's own environment — not core.
