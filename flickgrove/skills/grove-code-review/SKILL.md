---
name: grove-code-review
description: Review a branch or work-in-progress diff against the repository's default branch, or an explicit fixed point, along separate Standards and Spec axes, plus Penpot fidelity when the changed UI has a Penpot design; then assess how far it is from merge.
---

Review the diff between `HEAD` and the repository's default branch, unless the user supplies another fixed point:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / spec?

On the initial review, Standards and Spec run as **independent Grove Reviewers** so they don't pollute each other's context. When the changed UI has a corresponding Penpot design, add an independent **Penpot** axis. Later rounds resume only reviewers whose conclusions became stale.

Implementation specs live in FlickNote. Use MCP for note lookup and full content; a forge issue or note summary is not the spec.

## Process

If this branch already has a completed review with a recorded reviewed HEAD and reviewer targets, read and follow the `grove-review-again` skill before continuing. It decides whether to stop, run a focused review, or rerun the full review. The process below describes the initial review; the later-round rules in step 4 override its fresh-agent and evidence scope instructions.

### 1. Pin the fixed point

Use a fixed point the user explicitly supplied. Otherwise review against the repository's default branch.

Resolve the default branch from the current branch's remote (falling back to `origin`) and its remote `HEAD`:

```sh
remote=$(git config --get "branch.$(git branch --show-current).remote" || printf '%s\n' origin)
git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD"
```

The result, such as `origin/main`, is the fixed point. If that local symbolic ref is absent, query the remote with `git ls-remote --symref "$remote" HEAD`, fetch the reported branch, and use `<remote>/<branch>`. If the repository has no remote, use local `main` or `master` when one exists; ask the user only when no default can be discovered.

Resolve reviewedHead to the full current commit ID, never the mutable word HEAD; record the resolved fixed-point commit as well as its ref. Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside two independent Grove Reviewers.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. A FlickNote note ID the user passed. Read its full stored `content` with MCP `note_get`.
2. A spec note ID in the PR description, branch context, or conversation. Read the full content with `note_get`.
3. Search FlickNote with `note_find` using the repository and feature, then read the matching candidate with `note_get`. If multiple candidates remain, ask for the ID. If no spec exists, the **Spec** Reviewer will skip and report "no spec available".

Pass the fetched FlickNote spec content to the Spec reviewer; a note ID alone may not be readable in its context. If MCP cannot read an identified note, report the blocker rather than silently skipping the Spec axis.

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 3a. Establish the conditional Penpot surface

Enable the Penpot axis only when the diff changes a rendered UI surface and the user, spec, PR, or verified project context identifies a corresponding Penpot design. A backend-only change, a generic Penpot mention, or an unrelated design file does not trigger it. Record why the axis applies, or why it is skipped.

The parent owns the design brief before dispatch. Resolve the exact file/page/board IDs and map each changed screen or state to its board. Summarize the required hierarchy, content, layout, colors, typography, icons, controls, and navigation. Include later user-approved deviations with their source; those take precedence over older boards. Send this concrete brief, not merely “follow Penpot.” If the applicable design cannot be located or read, report the missing evidence and keep that surface unverified.

Prepare design renders and actual implementation screenshots for the same viewport, theme, state and representative synthetic data, tied to the reviewed HEAD. Reuse already captured authoritative design evidence; query Penpot only for a specific missing board or unresolved detail. An official SVG rendered locally is acceptable when image export fails; state the method. Node dumps, source inspection and passing tests alone do not establish visual fidelity. Use isolated preview/test state; real user data and production mutations are outside review.

### 4. Start or continue independent Grove Reviewers

Discover current reviewer_start/list/read/send/close and reviewer_report schemas. Never use native spawn_agent or an implementation Worker as a Reviewer. An Orc owns each Reviewer; the Reviewer cannot create/close others. Reviewer profile configuration belongs to the execution Peer, not this skill.

Route normal changes to profiles `standards` and `spec`; high-risk changes to `standards` and `high_risk_spec`. High risk includes authentication/authorization, owner isolation, money, persistence, concurrency, delivery guarantees, state machines and cross-runtime execution contracts. Diff size alone is not risk. Conditional matched Penpot designs add the independent `penpot` profile.

Start fresh contexts per initial axis, in parallel when possible, passing registered project, title, profile, spec reference, fixedPoint, reviewedHead and the complete axis-specific task/evidence below. Keep axes independent. Each task includes the exact fixed diff command, commit list and current HEAD. Reviewer reports carry their actual Reviewer ID and complete review target; an old PASS never covers a newer HEAD.

Reviewers are read-only: they read actual code, diff, full FlickNote spec, standards and existing logs/screenshots; they do not run tests, builds, browsers or other verification. Worker supplies head-bound evidence; if missing, Orc delegates evidence collection to the same Worker before acceptance. Prompt behavior is not a permission guarantee.

For later rounds follow `grove-review-again`: use reviewer_send to the original axis Reviewer with explicit fixedPoint/spec/reviewedHead, bounded delta, finding and evidence. Restore the same Reviewer with its saved profile/prompt snapshot. Replace only an unavailable axis. Use questionIds only for explicit delegated answers. List/read after uncertain start/send before deciding recovery; never blindly repeat admissions. Reports are asynchronous, so end the Orc turn after confirmed dispatch and await reports rather than polling. Keep Reviewers open until review is settled, then request reviewer_close; respect report/question/delivery guards and interrupted/unknown outcome inspection.

Give every reviewer this **evidence and proportionality discipline**:

- Separate verified repository/deployment facts from assumptions. Label every consequential unverified premise `Assumption — needs confirmation`; never turn it into a blocker, implementation requirement, or something to propagate back into specs, tickets, or docs.
- Investigate compatibility premises before asking the user. Search the repository, forge history, published-package or API evidence, and documented deployment state that are available in scope. Distinguish verified external usage or deployment from internal callers, development data, and hypothetical consumers.
- Mark a finding `Judgement call — user decision required` when the smallest correct fix depends on unresolved external usage, prior deployment, retained data, public-contract, cutover, or product-behaviour facts. State the evidence checked, the exact unanswered question, your recommendation, and which compatibility or migration work becomes unnecessary if the user confirms the simpler case.
- Self-check each finding's expected value and likelihood against implementation and operational effort. Drop high-effort, low-value or low-probability recommendations. If a heavy option may still be worthwhile, present it only as approval-gated with its evidence and a smaller alternative; do not recommend doing it before the user agrees. Provisioning an entire environment solely for an integration test is one such heavy option.
- Development-data migrations, legacy compatibility, dual-running, cutover staging, expand–migrate–contract, and “start new before removing old” require verified deployment history **and explicit user approval**. For a confirmed first deployment, do not recommend them.
- For every retained finding, state the smallest proportionate fix and estimate its changed LOC as a rough range (additions plus deletions, excluding generated files and lockfiles). LOC is not an effort proxy; separately mention material environment or operational work.

**Standards Reviewer task** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the Reviewer has no other access to it.
- The brief: "Apply the evidence and proportionality discipline above. Report — per file/hunk where relevant — (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. For every retained finding include the smallest fix and estimated changed LOC. Under 500 words."

**Spec Reviewer task** — include:

- The diff command and commit list.
- The full fetched contents and ID of the FlickNote spec.
- The brief: "Apply the evidence and proportionality discipline above. Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. For every retained finding include the smallest fix and estimated changed LOC. Under 500 words."

If the spec is missing, skip the Spec Reviewer and note this in the final report.

**Penpot Reviewer task** — include:

- Reviewed HEAD, fixed point, diff command and changed UI surface.
- The parent's concrete design brief, exact file/page/board IDs, and sourced user-approved deviations.
- Matched design/implementation screenshot pairs and the reproduction steps or isolated preview location; identify missing pairs explicitly.
- The brief: "Review only Penpot fidelity. Visually compare every changed screen/state against its mapped design at matching viewports. Check hierarchy, spacing/alignment, typography, colors, assets/icons, controls, and designed navigation/interactions. Read the Worker's isolated observable interaction evidence; never operate a browser. Report a coverage table (board, actual screenshot/state, pass/deviation/mismatch/unverified), then concrete mismatches with both evidence references, smallest proportionate fix and changed-LOC estimate. Separate approved deviations from defects; mark unavailable evidence unverified rather than passing it. Apply the shared evidence/proportionality discipline. Keep findings under 500 words; the coverage table may be separate. Do not invent a redesign or repeat general Standards/Spec review."

The parent inspects the comparison evidence and validates reported discrepancies before aggregation. Successful design API calls or an implementer's claim of fidelity are not acceptance evidence.

**Focused adjudication** — do not add ensemble reviewers or duplicate an existing axis with another full review. When a potential merge blocker remains materially uncertain, first use deterministic evidence when available. If model judgement is still required, resume the original reviewer for that axis and send only the finding, its cited hunk, the governing requirement, and relevant test evidence. Replace it with the named reviewer for that axis only when the original target cannot be resumed. Keep the result under the finding's original axis; adjudication confirms or rejects evidence and never reranks Standards against Spec.

### 5. Aggregate

Before presenting findings, run the evidence and proportionality discipline yourself. Remove findings whose premise is contradicted or whose cost is disproportionate to expected value. Downgrade unresolved hypothetical risks to labelled assumptions requiring confirmation; do not let them expand scope. Any approval-gated migration, compatibility, cutover, dual-running, heavy environment, or similar mechanism must remain unimplemented unless the user explicitly agrees.

Present the surviving reports under `## Standards` and `## Spec` headings, plus `## Penpot` when triggered, lightly cleaned as needed. Include Penpot coverage and any unverified surfaces; do not declare design fidelity for surfaces without comparison evidence. Keep the axes separate so neither masks the other. Every finding must include its smallest proportionate fix and rough changed-LOC range; also state non-code setup effort when material.

When any judgement call remains, add `## Decisions required` before merge readiness. For each decision, separate verified facts from the unresolved premise, ask one focused question, recommend the simplest supported choice, and quantify the compatibility or migration code that choice adds or removes. Findings with no unresolved human choice stay in their original axis and are safe for an implementation workflow to fix automatically.

Then add `## Merge readiness` and answer: **How far is this version from merge?** Use the user's language and this structure:

```text
My assessment

- Merge blockers: <count and concise severity/behaviour summary, or none>
- Recommended reinforcement: <valuable non-blocking work, especially representative tests, or none>
- Estimated effort: <one focused iteration / several focused iterations / substantial work>
- Path to merge: <what to fix and the exact repository checks/builds to rerun before PR or merge>

Approximately <range>% complete.
```

Keep blockers separate from recommended reinforcement. Name repository-specific verification commands when they are discoverable, rather than writing a generic “run tests.” Use a narrow percentage range, normally five points, as a directional completion estimate rather than false precision. Calibrate it from remaining risk and work:

- **95–100%** — ready or only final verification remains.
- **85–95%** — a focused iteration of small fixes or representative tests remains.
- **70–85%** — several bounded changes remain.
- **Below 70%** — core behaviour or substantial correctness, security, data, or design work remains.

A judgement-call smell is not automatically a blocker; place it under recommended reinforcement unless it materially affects safe or correct merging.

End with a one-line count of findings per axis and the worst issue within each axis, if any. Record the reviewed HEAD, applicable reviewer target IDs, and Penpot board/render/screenshot references and approved deviations in the review result so a later `$grove-review-again` or `$grove-code-review` can resume them without reconstructing review state.

## Why separate axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

- Correct behavior and clean code with a visually different page → **Penpot fail**, when that axis applies.

Reporting them separately stops one axis from masking the other.

Implementation belongs to Worker, independent target-bound review to Reviewer, and bounded evidence investigation to Researcher under `grove-research`. Researchers do not replace review axes or implement fixes. Use Grove collaboration tools; native collaboration is disabled in managed sessions.
