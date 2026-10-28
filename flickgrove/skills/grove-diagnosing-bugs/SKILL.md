---
name: grove-diagnosing-bugs
description: Diagnose bugs and performance regressions through a symptom-matching red loop, ranked hypotheses, causal repair and independent Grove review.
---

# Diagnose and repair

Use all six phases in order. Record an evidence-based justification for any skipped phase. Completing one phase means continuing to the next authorized step, not declaring the assignment complete.

## Prepare the Grove assignment

Orc establishes the user's exact symptom, expected result, repository/runtime and known good/bad states with the minimum necessary questions. Read repository/host instructions, `CONTEXT.md` and relevant ADRs; inspect environment facts read-only within authorization. Resolve the registered project alias, pin starting HEAD and preserve pre-existing/concurrent edits.

Read `grove-to-orc-impl` and `grove-orc-impl` completely and reuse their spec/self-review, dispatch, delivery recovery, review and approval lifecycle. A self-reviewed diagnostic spec is ready with **root cause unknown** when symptom, scope and these evidence gates are clear; it need not prescribe a guessed patch. Orc first investigates and makes the decisions available from current evidence. Assign irreducible unknowns to the appropriate category owner as bounded questions with goals, evidence and limits. When Worker work is needed, carry this skill's content and diagnostic acceptance into its bootstrap. Orc owns frontend UI, schema/migrations, one-off ops scripts and prompts/agent instructions; Worker owns other implementation. Each owner builds and runs its relevant loops, tests, probes and fixes. Mixed work is serial on one branch and PR; preserve each other's work.

Common lifecycle stays in those workflows. Diagnosis adds the ordered gates below before implementation conclusions, and the no-change outcome below overrides their usual PR requirement. Use actual Grove MCP schemas discovered on the execution host; model/effort are application configuration. Only owning Orc manages agents. Inspect unknown admissions with list/read before deciding recovery, without automatic replay; questions route through Orc with explicit question IDs. Native collaboration is not an alternative.

## Evidence and authorization

Redact secrets **before** publishing commands, outputs, reports or artifacts: replace them with `<REDACTED>`. Keep credentials in environment variables rather than displayed invocations. Captures may contain auth headers: publish only sanitized signal-bearing lines. If redaction removes necessary evidence, ask through Orc for a safe artifact or access path.

Every test/harness uses test-owned temporary homes/config/state, fixtures, fakes or injected paths. Cleanup removes only its own artifacts. Tests never touch real CLI homes, credentials, installed executables or production services. Existing authorization defines read-only live investigation; Diagnose alone does not authorize production writes, restart, instrumentation, deployment or paid-provider calls. A required authorization gates that action while independent work continues.

## Phase 1 — Build a tight feedback loop

Spend disproportionate effort constructing a fast, precise pass/fail signal for **this symptom**. Read source/environment facts to locate the actual path; defer root-cause attribution until Phase 2 is complete. Try these loop seams in roughly this order:

1. Failing unit/integration/e2e test reaching the real caller pattern.
2. HTTP script against an owned dev fixture.
3. CLI fixture invocation with exact stdout/error comparison.
4. Browser script asserting DOM/console/network symptom.
5. Sanitized captured request/payload/event trace replay through the actual path.
6. Throwaway minimal harness with isolated dependencies.
7. Property/fuzz/stress loop for intermittent failures.
8. Bisection harness across known good/bad commits, datasets or versions.
9. Differential loop with the same input across two states/configurations.
10. Structured human-assisted loop when automation cannot exercise the trigger.

Tighten setup/runtime, assert the exact symptom rather than absence of crashes, pin time/random seeds and isolate filesystem/network. For nondeterministic bugs, repeat triggers, add controlled stress/timing injection and measure reproduction rate; raise it until useful, preserving seeds and trial counts.

**Structured HITL fallback:** The relevant owner prepares an owned harness and routes through Orc a numbered protocol: safe setup, exact trigger steps, expected versus actual symptom, timestamps/trial ID, and explicit pass/fail/unknown fields. Human performs only the necessary interaction and returns sanitized observations, never credentials or raw secret-bearing captures. The owner records observations in the owned fixture/report and re-runs the protocol with the same verdict rule. State the human dependency and measured rate; this inline protocol requires no external helper. Await only the required observation, not acknowledgment of a progress report.

**Gate:** name one red-capable command already executed at least once and show sanitized invocation/output. It reaches the actual bug path and asserts the user's exact symptom, runs in seconds where practical, is deterministic or has a measured useful reproduction rate, and is agent-runnable except the explicit structured HITL dependency. A passing synthetic fixture alone does not establish reproduction.

If no such loop is possible, stop hypothesis/fix progression. Report attempted approaches and precisely missing redacted artifact/access/observation through Orc. Ask only for that dependency; continue independent evidence work. Never manufacture green evidence or a PR.

## Phase 2 — Reproduce and minimize

Run the loop and observe **symptom-matching red** on repeated runs, or record the measured intermittent rate. Capture exact error, output or timing and tie it to the user's scenario. A separately reproduced nearby defect remains a separate finding; synthetic resemblance does not prove the user's live cause. Repair it only within authorization and document that causal boundary.

Remove inputs, callers, configuration, data and steps one variable at a time, re-running after each cut. Keep load-bearing elements only. Record any irreducible environment dependency.

**Gate:** observed red matches the reported failure, repeatability/rate is recorded, and every remaining repro element is load-bearing (removing it loses red). Only then proceed to root-cause hypotheses and repair.

## Phase 3 — Rank falsifiable hypotheses

Before probing, produce 3–5 ranked candidate causes. Each includes evidence for/against, grounded confidence and a prediction: “If X causes this, changing Y removes the symptom / changing Z worsens it.” Sharpen or discard candidates without a falsifiable prediction. Use measured probabilities only when data supports them; otherwise use qualitative confidence and ranking.

The owner reports the ranking and verification directions before probing, then immediately continues authorized testing. Worker reports through `worker_report`; Orc publishes the causes, evidence/confidence and directions as a progress update without waiting for acknowledgment. Async corrections steer ongoing work. Missing necessary evidence, a material scope/product decision or required authorization gates only dependent work; a candidate list is not a handoff gate.

**Gate:** ranked list and predictions are reported before the first probe; no routine “shall I continue?” pause.

## Phase 4 — Probe predictions

Map every probe to one prediction and change one variable at a time. Prefer debugger/REPL inspection, then targeted logs at discriminating boundaries. Give temporary logs one unique `[DEBUG-...]` prefix for cleanup. Record result, contradicted/supported hypotheses and next direction; revise the ranking as evidence changes.

For performance regressions, establish baseline timing/profiler/query-plan measurements first, then bisect with the same harness. Measure before fixing. Optional independent research requires reading `grove-research` completely and its 2–4 genuinely independent decision-relevant questions; Researchers gather evidence, not loop code or replacement review.

**Gate:** discriminating evidence supports a causal explanation, with alternatives addressed and uncertainty explicit. Otherwise continue probes or request the concrete missing dependency.

## Phase 5 — Regression before repair

Use a seam that reproduces the actual call-site pattern: multiple callers or a triggering chain require that same pattern, not a shallow single-caller unit approximation. Turn the minimized repro into a regression **before** the fix, observe red, apply the smallest causal fix, observe green, then re-run Phase 1 on the original unminimized scenario.

If no correct seam exists, document that architectural finding and the available original-loop evidence instead of claiming a shallow test locks down the defect. Repair still requires causal evidence and original-scenario verification.

**Gate:** regression red→green at the correct seam (or documented seam absence), and original symptom no longer reproduces with comparable conditions/trial counts. State the limits of any inference about a live environment.

## Phase 6 — Cleanup and delivery

Re-run the original loop; confirm regression success or documented seam absence. Remove tagged debug instrumentation (search its prefix) and delete throwaway prototypes or retain them only in a clearly marked local debug location. Explain the proven cause and causal boundary in the commit/PR. Record concrete architectural prevention observations in `.scratch/defered/` after repair; execute only the authorized fix scope.

For a code repair, follow `grove-orc-impl` delivery: verify the whole assignment and commit/push one PR with exact sanitized red/green evidence. A Worker reports `IMPL_COMPLETE` with current HEAD, PR URL and absolute report path for its assignment. Orc substantively self-reviews the complete diff, spec and evidence before `grove-code-review` independent whole-PR Standards + Spec (`high_risk_spec` by actual risk); Reviewers inspect code/spec/existing evidence only. Missing verification and deterministic repairs go to the category owner on the same PR. Read `grove-review-again` completely for original-reviewer re-review bound to explicit new HEAD. Merge approval remains governed; deployment is separately scoped.

For environment-only/no-code-change findings, report the actionable cause, evidence, limitations and authorized next step without inventing a commit/PR or code-repair `IMPL_COMPLETE`. A Worker reports through `worker_report`; Orc resolves the outcome and owns lifecycle closure after evidence/questions settle. A blocked Worker reports `IMPL_BLOCKED` with missing evidence/decision and attempted approaches.

**Gate:** original outcome verified, evidence sanitized, cleanup complete, causal finding and limitations recorded, and either the verified code-repair handoff or explicit actionable no-change outcome delivered. Instruction review assesses this workflow's semantics; it is not executed proof of model compliance.
