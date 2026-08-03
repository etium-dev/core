# OpenHands AI Engineer

This repository uses a self-hosted, multi-persona OpenHands SDK engineer with
explicit human gates for routing, architecture, planning, and implementation.

## Authorization boundary

- Only GitHub user `carlospche` may assign or authorize the AI engineer.
- OpenHands does not receive `PAT_TOKEN`, `GITHUB_TOKEN`, or other GitHub
  credentials in its tool environment.
- The controller loads subscription OAuth from its protected home, then gives
  persona-controlled terminal and browser tools a separate credential-free
  home directory.
- Repository publication uses a separate regular GitHub account named by the
  `OPENHANDS_BOT_USERNAME` repository variable.
- The bot account must have **Write**, never Maintain or Admin.
- Branch rules must require human approval and must not grant the bot bypass.
- The bot opens draft PRs and never merges.

## Repository configuration

Create:

- Actions secret `PAT_TOKEN`: classic PAT belonging to the bot account, with
  only the `repo` scope.
- Actions secret `LMNR_PROJECT_API_KEY`: project key for the self-hosted
  Laminar instance. The controller removes it from the environment before
  agent-controlled tools start.
- Actions variable `OPENHANDS_BOT_USERNAME`: the bot's GitHub username.

The self-hosted runner needs the custom label `penelope-openhands`. OpenHands
1.38.0, its tools package, managed Python, and subscription credentials are
stored below `/Users/Shared/openhands-tools`.

After these files reach the default branch, run **OpenHands AI engineer** once
from Actions with `initialize_ai_labels` enabled. This creates or verifies all
managed `ai-*` labels and removes the obsolete `fix-me` label.

## Issue lifecycle

1. Assign the issue to the AI. The Intake Analyst posts a recommendation and
   waits; assignment never creates a PR or silently selects a route.
2. On the issue, apply exactly one of `ai-debug`, `ai-architecture`, or
   `ai-plan`. Use `ai-intake` to repeat triage after adding information.
3. Debugging remains on the issue. Architecture or planning creates the first
   draft PR.
4. After a PR exists, all comments and command labels belong on that PR.
5. Persona builders and reviewers iterate autonomously. Persistent objections
   or human decisions produce `ai-needs-human` with a convergence report.
6. Apply `ai-implement` only after the plan and test plan are approved.
   Implementation uses a test-first commit and independent code/test review.
7. A human reviews and merges through the protected default branch.

Comments never start work. Command labels are consumed when accepted, so
reapplying one requests another pass. Applying several commands simultaneously
performs no transition and requests an unambiguous human choice.

The complete behavioral contract—including assignment, unassignment, closure,
reopening, cancellation, backwards transitions, failure recovery, personas,
and terminal states—is in
[AI_ENGINEER_STATE_MACHINE.md](AI_ENGINEER_STATE_MACHINE.md).

Legacy `openhands/issue-N` PRs remain recognizable. Apply `ai-plan` to move one
into the new artifact/state format before requesting implementation, or close
it and reassign the issue for a clean attempt.

Planning jobs may run for at most 2 hours. Implementation and revision jobs may
run for at most 10 hours. OpenHands also retains its high default 500-iteration
emergency guard.

## Live status

While a stage runs, the active issue or PR has `ai-running` and one
bot-authored **AI engineer status** comment. Read it for:

- current stage, persona, and autonomous review round;
- current activity;
- controller heartbeat, its five-minute validity deadline, and the last
  observed OpenHands event;
- stage deadline; and
- a direct link to the Actions run.

The controller updates that comment in place every 60 seconds. Green means the
controller and agent activity are recent. Yellow means the controller monitor
is alive but no new OpenHands event has appeared for 15 minutes; this is a
warning, not an automatic cancellation. Waiting, blocked, cancelled, and
completed outcomes remain visible after compute stops.

`AI engineer watchdog` runs every five minutes on the Mac Mini and reconciles
stale status with the GitHub Actions run. A single self-hosted runner cannot
execute the watchdog concurrently with the engineer job. Consequently, an
offline Mini is shown by a frozen heartbeat, and automatic red-status
reconciliation happens once the runner is available again. Move the watchdog
to a GitHub-hosted or second runner later for fully independent detection.
Before the Mini starts a newly queued job, it cannot create the first status
comment; check the Actions run for that initial queued state.

## Persona prompts

Persona system instructions live in `.github/ai-engineer/personas/`. The
controller loads them from the protected default branch, never from a bot PR.
OpenHands personas receive public-web research tools but no GitHub credential.

## Failure recovery

Failures apply `ai-needs-human` and post either a convergence report or a
technical blocker. Address it, comment with the decision, and reapply exactly
one appropriate command. No `ai-*` label grants merge permission.
