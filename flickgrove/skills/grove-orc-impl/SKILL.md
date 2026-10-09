---
name: grove-orc-impl
description: Orchestrate a FlickNote spec through a FlickGrove Worker, whole-spec review, PR creation, and approval-gated merge.
---

# Orchestrate implementation

Use one Orc and one Implementation Worker per repository/spec/PR. Orc owns orchestration, review, judgement calls, PR delivery, and merge approval. The Worker owns the complete ticket set and deterministic review fixes. Deployment is outside this workflow unless requested.

Use the execution host's `flickgrove` MCP tools for Worker lifecycle. Discover their current schemas before use. The application supplies Worker model, reasoning effort and service tier; skills do not select them. Implementation delegation uses Grove MCP; independent review uses reviewer_start/list/read/send/close under `grove-code-review`. This workflow requires an Orc session with `worker_start`, `worker_list`, `worker_read`, `worker_send` and `worker_close`. If unavailable, report the missing capability rather than starting a different agent runtime.

## 1. Prepare

1. Read the named FlickNote spec by ID through MCP `note_get`, follow its ticket index, and read every ticket's stored `content`. A spec with no tickets is a valid direct assignment; do not invent tickets unless requested. If an identified note is unreadable, report the blocker. Read repository and host-local instructions.
2. Resolve the repository's registered Organon alias on this execution host. `worker_start` selects a registered project, not an arbitrary cwd or a remote host. Confirm its checkout matches the spec. A different execution host requires an Orc there; do not assume a Hub-visible project is available locally.
3. Inspect tracked and untracked changes. Record pre-existing dirty paths and their initial diff; preserve them. Documentation-only changes, including `CONTEXT.md`, do not block the checkout. Assess other changes for implementation overlap.
4. Build ticket order from numbers, statuses and `Blocked by:` fields, or use the spec's acceptance criteria directly when it has no tickets. Record the starting branch and `HEAD` as the fixed review point.
5. For changed rendered UI with a corresponding Penpot design, read [Penpot design handoff](references/penpot-handoff.md) and complete Orc preparation before dispatch. Record applicable references in the spec. A generic mention or unrelated design does not trigger this branch.

Use the registered checkout by default; the Worker creates the feature branch there. While it runs, Orc keeps repository files unchanged. For overlapping dirty changes, resolve the overlap without discarding user work; request a decision only if it cannot be resolved within scope. FlickGrove has no pane, tab or worktree lifecycle API. If isolation is necessary and authorized, prepare an isolated checkout through the repository's supported tooling and register it on the execution host before dispatch. Record ownership and cleanup responsibility for any checkout created for this run.

FlickNote workflow `Status:` lines are stored Markdown, separate from note lifecycle. Update them with exact `note_modify` before/after edits or `note_write`, then read back. Content edits preserve lifecycle; do not use `note_submit` to mark implementation progress.

## 2. Start and dispatch the Worker

Call `worker_start` once with the canonical `project` alias, a useful `title`, the spec reference in `spec`, and the complete bootstrap in `message`. Startup includes dispatch; no separate prompt is needed. Retain the returned Worker ID and confirmed delivery/state. Inspect `worker_list` and `worker_read` after an error or unknown result before creating or sending anything again; an uncertain response may already have created a Worker or delivered a task. Recover the same Worker when possible.

The bootstrap names the spec and all ticket note IDs and states:

- this is the sole Implementation Worker; it owns the whole spec in dependency order, including documentation and deterministic review fixes;
- it is not alone in the codebase, must preserve others' edits and adapt to concurrent changes;
- the pre-existing dirty paths and which are in scope for commits;
- the registered checkout, branch, fixed starting commit and one-PR boundary;
- live services, deployments, credentials, paid providers and external messages remain untouched unless explicitly in scope;
- it follows repository implementation instructions, keeps `.scratch` untracked, updates ticket workflow statuses through FlickNote MCP, verifies observable behavior, commits scoped Conventional Commits, pushes with `og`, creates/updates the single PR with typed Organon tools, includes the spec ID in its description, and writes `.scratch/<feature>/implementation-report.md`;
- for Penpot, the prepared bundle, concrete screen/state brief, approved deviations, comparison requirements and missing evidence;
- it uses `worker_report` for progress, blockers and completion. Completion starts `IMPL_COMPLETE`, identifies the spec, reviewed commit, PR URL and absolute report path, and is sent only after the whole assignment is implemented and verified. A blocker starts `IMPL_BLOCKED` with evidence and the decision required. It reports to Orc and leaves agent lifecycle to Orc.

`worker_report` routes to the owning Orc without waiting for Orc readiness. A final answer or idle state alone is not the completion handoff. On uncertain report delivery, inspect the retained conversation/delivery evidence before explicitly retrying or reconciling; do not replay mutations blindly.

After confirmed dispatch, end the Orc turn; reports and delegated questions reactivate it. Use `worker_list`/`worker_read` for requested status or specific recovery, not polling while implementation runs. A progress report does not trigger acceptance review.

When requirements change, update the spec and affected tickets through FlickNote MCP first, then send a compact delta with `worker_send` to the same Worker. It steers a busy Worker and starts a new turn when idle. For delegated async questions, include only the explicit `questionIds` being answered; ordinary instructions do not resolve questions. Ask the user only for decisions Orc cannot make from the authorized scope and evidence.

## 3. Review and fixes

After `IMPL_COMPLETE`:

1. Read the report and verify the diff from the fixed starting `HEAD` against every acceptance criterion; confirm the reported commit is current.
2. Run `grove-code-review` against that fixed point with its Grove Reviewers in independent contexts. Implementation stays with the sole Grove Worker. Reviewer models, reasoning and customizable prompts come from the execution Peer runtime configuration; fixed role/owner/report/close rules remain application-owned. Reviewers only read the diff, full spec and existing evidence; they never run tests, builds or browsers. Missing evidence is assigned to the Worker. For Penpot, inspect actual design/implementation comparison evidence before acceptance; missing evidence stays unverified.
3. Consolidate deterministic findings into one `worker_send` to the same Implementation Worker. Require updated evidence, report and `IMPL_COMPLETE` for the fix round.
4. Bring unresolved judgement calls about external consumers, retained data, compatibility, migration, cutover or product behavior to the user with the smallest supported recommendation.
5. Use `grove-review-again` to reopen only stale conclusions until no merge blocker or unresolved judgement remains.

Orc reviews and triages; the Implementation Worker implements all fixes. Retain reviewer IDs and conclusions until review is settled.

## 4. PR, merge, and cleanup

A completed run includes one PR and approval-gated merge unless the user limited scope.

1. Use typed Organon `og` tools to find or create the PR. Its head must be the reviewed commit; its description states final behavior and verification.
2. Submit merge through the current typed `og` operation and follow its returned policy, `next_action` and `completion`. Continue already authorized actions without requesting the same approval again. Pending required approval ends the turn; rejection or terminal failure follows the current policy. Merging does not deploy: run and verify a documented deploy step only when deployment is in the authorized scope.
3. After an executed merge, set the spec's Markdown `Status:` to `implemented` through FlickNote MCP and verify stored content. Close the run-owned Implementation Worker with `worker_close` when no further assignments are needed. Request reviewer_close on run-owned Reviewers only after review is settled; closing=true is accepted asynchronous closure. `closed=true` confirms closure; `closing=true` is an accepted durable request that waits for current work, questions and reports. Continue answering existing questions; do not send new tasks after requesting closure.
4. Recover report/question/delivery guards before cleanup. Use `confirmInterrupted` only after inspecting an interrupted Worker with no observed active turn and explicitly acknowledging its unknown outcome. Preserve useful evidence and any isolated checkout until safe cleanup. Orc tree closure belongs to the user; Worker closure does not establish task completion.

Preserve blocked or failed Workers until evidence is recovered or the user chooses to discard them.

The final report records the starting and reviewed commits, execution host/project and Worker IDs, ticket or acceptance-criterion/commit coverage, verification, review iterations, judgement calls, changed-LOC variance, PR URL, merge and closure status, and remaining blockers.

Implementation belongs to Worker, independent target-bound review to Reviewer, and bounded evidence investigation to Researcher under `grove-research`. Researchers do not replace review axes or implement fixes. Use Grove collaboration tools; native collaboration is disabled in managed sessions.
