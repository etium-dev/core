# Why the reviewer contract looks the way it does

`templates/review.md` encodes a set of convergence mechanisms for the
builder/reviewer loop. This file is the evidence behind each rule —
external research, tools in the same vein, and production code-review
products — so that when you edit the templates (they are yours), you
know which lines are load-bearing and what breaks without them.

## The pathology

An LLM reviewer asked to review will find something, every round,
indefinitely — not because the findings are fake, but because
finding-nothing is not an outcome the setup offers it. Measurements:

- On solutions known to be **correct**, LLM self-critique hallucinated
  errors at 79.6–97.1% across reasoning domains
  ([Stechly et al.](https://arxiv.org/abs/2402.08115)).
- Of one production reviewer's raw comments, **79% were nits**, 19%
  useful ([Greptile](https://www.greptile.com/blog/make-llms-shut-up)).
- OpenAI's trained critic treats nitpick-and-hallucination rate as a
  first-class metric and needs an explicit inference-time knob (forced
  critique length) to pick a point on the comprehensiveness↔nitpick
  curve ([CriticGPT](https://arxiv.org/abs/2407.00215)).
- Models are no better at judging quality than producing it — the
  precondition for a self-terminating critique loop is absent
  ([Self-[In]Correct](https://arxiv.org/abs/2404.04298)); judges are not
  even score-stable across refinement rounds
  ([CALM, refinement-aware bias](https://arxiv.org/abs/2410.02736)).
- Intrinsic critique-until-satisfied loops plateau or **degrade** the
  work (GPT-4, GSM8K: 95.5 → 89.0 over two "improvement" rounds); every
  published self-correction success stopped the loop on an oracle or
  external signal, never on the critic's satisfaction
  ([Huang et al.](https://arxiv.org/abs/2310.01798),
  [Kamoi et al.](https://arxiv.org/abs/2406.01297)).

Conclusion the whole field converged on: **the critic must never be the
stopping authority.** Convergence is imposed by loop structure.

## What the field does

**Small hard caps on model-critic rounds.** Aider: 3 reflections
(hard-coded). OpenHands critic: 3 iterations, 0.6 score threshold.
GPT-Pilot: 3 coding attempts, then accepts unconditionally. MetaGPT:
reviewer k=2 (LGTM/LBTM). ChatDev: review cycleNum 3, chat turn cap 10.
SWE-agent: 3 requeries. The research supports 2–3: improvement
front-loads (most of [Self-Refine](https://arxiv.org/abs/2303.17651)'s
gain is iteration 1; debate accuracy saturates at round 2 —
[ReConcile](https://arxiv.org/abs/2309.13007); with a sound oracle,
rounds 0–2 capture 76–95% of achievable improvement). The loop's
`rounds` default of 2 sits on this consensus.

**Oracles converge; model critics don't.** AlphaCodium replaced
subjective review with test gates and per-stage counters
([paper](https://arxiv.org/abs/2401.08500)); aider's real reviewer is
lint/test exit codes; Reflexion's code loop stops on unit tests. With an
execution oracle, repair converges monotonically. The `implement` stage
has `check` for exactly this. Document stages (debug/design/plan) have
no exit code — they get the mechanisms below instead.

**Severity tiers: only blockers gate.** CodeRabbit hides nitpicks by
default; auto-approval ignores lower-priority feedback. Qodo posts only
"Action Required" inline. Copilot labels High/Medium/Low and is
comment-only by design. All descend from Google's reviewer canon:
"reviewers should favor approving a CL once it definitely improves the
overall code health, even if it isn't perfect," with `Nit:` prefixes and
LGTM-with-comments
([eng-practices](https://google.github.io/eng-practices/review/reviewer/standard.html)).
Hence review.md's blocker/note split: the verdict turns on blockers
only; notes ride under an approve. Withholding approval stops being the
reviewer's only way to speak.

**Delta-scoped re-review + resolved tracking.** CodeRabbit reviews only
new commits; Cursor BugBot dedupes against previous runs; Qodo
fingerprints inline comments and never re-posts one; GitHub's resolved
conversations are the platform primitive. Copilot re-reviews whole PRs
and its docs admit the consequence: repeated comments despite
resolution. Hence review.md's `Resolved since last review:` accounting
line, and the raised bar on late findings: a blocker first raised in a
later round must say what changed to expose it — otherwise it's a note.

**Escalate to a human at the bound.** At the cap, tools either accept
silently (GPT-Pilot, gpt-engineer — objections vanish), error out
(OpenHands headless), or escalate with context (aider warns and stops;
Cursor checkpoints; AutoGen's `human_input_mode="TERMINATE"` hands the
human the decision and resets the counter on input). The `<stage>-stuck`
gate is the third kind: `keep-going` (another block of rounds, your note
injected into the next builder prompt), `accept` (overrule the
reviewer); ending is `/et stop`, from anywhere — and the gate arrives
with a reason and the reviewer's blockers leading the shown files.

**Measure the reviewer by resolution, not findings.** Production
north-star everywhere: Cursor drove resolution 52% → ~80%; Greptile
19% → 55%+; Copilot reports 71% actionable and stays silent in the
other 29% ([60M reviews](https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/)).
Silence is a product decision, not a model behavior.

## Deliberately not adopted

- **Numeric self-scored severity thresholds** ("rate 1–10, drop <7") —
  Greptile tried it: "the LLM's judgment of its own output was nearly
  random." Categorical tiers with a defined bar work; self-assigned
  numbers don't.
- **Exhortations to be less picky** — self-assessment is the broken
  instrument; the fix is what the reviewer may *say* (approve with
  notes) and what late objections must *carry* (why now).
- **More debate/more rounds** — forced continuation measurably hurts
  ([MAD](https://arxiv.org/abs/2305.19118): best score at iteration 1;
  [Smit et al.](https://arxiv.org/abs/2311.17371): debate doesn't
  reliably beat self-consistency).
- **Stagnation auto-stop** (ChatDev ends review after two unchanged
  modifications) — sound, but with `rounds=2` the stuck gate fires
  almost as fast and keeps the human in the decision.

## Sources

Research: [Self-Refine](https://arxiv.org/abs/2303.17651) ·
[Reflexion](https://arxiv.org/abs/2303.11366) ·
[CriticGPT](https://arxiv.org/abs/2407.00215)
([blog](https://openai.com/index/finding-gpt4s-mistakes-with-gpt-4/)) ·
[Multiagent debate](https://arxiv.org/abs/2305.14325) ·
[ReConcile](https://arxiv.org/abs/2309.13007) ·
[MAD/Degeneration-of-Thought](https://arxiv.org/abs/2305.19118) ·
[Should we be going MAD?](https://arxiv.org/abs/2311.17371) ·
[MAD, what is the question?](https://arxiv.org/abs/2502.08788) ·
[LLMs cannot self-correct reasoning yet](https://arxiv.org/abs/2310.01798) ·
[Self-verification limitations](https://arxiv.org/abs/2402.08115) ·
[Is self-repair a silver bullet?](https://arxiv.org/abs/2306.09896) ·
[When can LLMs actually correct?](https://arxiv.org/abs/2406.01297) ·
[Self-[In]Correct](https://arxiv.org/abs/2404.04298) ·
[MT-Bench judge biases](https://arxiv.org/abs/2306.05685) ·
[LLMs are not fair evaluators](https://arxiv.org/abs/2305.17926) ·
[CALM bias quantification](https://arxiv.org/abs/2410.02736) ·
[G-Eval](https://arxiv.org/abs/2303.16634) ·
[Prometheus](https://arxiv.org/abs/2310.08491) ·
[Trust or Escalate](https://arxiv.org/abs/2407.18370) ·
[CriticBench](https://arxiv.org/abs/2402.14809) ·
[CriticEval](https://arxiv.org/abs/2402.13764) ·
[MetaCritique](https://arxiv.org/abs/2401.04518) ·
[RealCritic](https://arxiv.org/abs/2501.14492).
Tools: [aider architect/editor](https://aider.chat/2024/09/26/architect.html)
· [aider lint/test loops](https://aider.chat/docs/usage/lint-test.html)
· [OpenHands critic](https://docs.openhands.dev/sdk/guides/critic) ·
[OpenHands stuck detector](https://docs.openhands.dev/sdk/guides/agent-stuck-detector)
· [SWE-agent reviewer/retry](https://swe-agent.com/latest/reference/agent_config/)
· [AlphaCodium](https://github.com/Codium-ai/AlphaCodium) ·
[Anthropic: building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
· [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
· [GPT-Pilot](https://github.com/Pythagora-io/gpt-pilot) ·
[AutoGen termination](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)
· [LangGraph reflection](https://www.langchain.com/blog/reflection-agents)
· [ChatDev](https://arxiv.org/abs/2307.07924) ·
[MetaGPT](https://github.com/geekan/MetaGPT) ·
[CAMEL](https://arxiv.org/abs/2303.17760).
Products: [CodeRabbit config](https://docs.coderabbit.ai/reference/configuration)
· [Greptile: make LLMs shut up](https://www.greptile.com/blog/make-llms-shut-up)
· [Cursor BugBot](https://cursor.com/blog/building-bugbot)
([learned rules](https://cursor.com/blog/bugbot-learning)) ·
[Copilot code review](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/copilot-code-review)
· [Qodo PR-Agent](https://docs.qodo.ai/code-review/comment-anatomy) ·
[Google eng-practices](https://google.github.io/eng-practices/review/reviewer/standard.html).
