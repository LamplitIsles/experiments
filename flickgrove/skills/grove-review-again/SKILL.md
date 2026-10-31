---
name: grove-review-again
description: Choose the smallest review surface needed after a completed review, reusing its reviewers and prior conclusions.
---

# Review again

Act as a cost-aware re-review gate. Preserve conclusions that remain supported and reopen only the reasoning made stale by later changes.

## Establish review state

Identify:

- the last reviewed HEAD;
- the current HEAD and exact delta since that review;
- the original Standards and Spec reviewer targets and relevant visual evidence;
- the findings or conclusions affected by the delta.

Use a recorded commit or reliable turn history for the reviewed HEAD. For a task primarily changing frontend user experience, wait for the user to explicitly request the initial review or a new review after further UX iteration before starting this workflow or dispatching independent Reviewers. If no completed review exists, route to an initial `$grove-code-review`. If the prior reviewer targets are unavailable, retain the reviewed HEAD and replace only the missing reviewer when review work is actually needed.

This step is complete when the post-review delta and every prior conclusion it could affect are named.

## Choose the review surface

Use the smallest surface that can disprove the affected conclusion:

- **Stop** when no code, agent/machine-consumed contract, or applicable design evidence/user-approved deviation changed.
- **Focused review** when changed hunks, their directly affected callers/contracts, and the originating findings bound the stale reasoning. A local user-facing wording or contract correction can remain focused when authorization, control flow, and downstream assumptions are unchanged.
- **Full re-review** only when the delta cannot be bounded without reconsidering the integrated branch: for example, it replaces the approach, crosses several coupled modules, changes a security or transaction boundary, or makes the recorded baseline unreliable.

Scope, method, evidence, and risk changes are signals to inspect, not automatic reasons for a full pass. For mixed changes, expand only the affected axis or surface; do not promote the entire branch merely because one local change has a different category.

This step is complete when every stale conclusion has a proportionate review surface and unaffected conclusions remain closed.

## Run the selected review

- For focused review, send with reviewer_send to only the affected original Reviewer with the reviewed-HEAD-to-current-HEAD delta, the originating finding or requirement, and relevant verification evidence. Ask it to confirm or reject only that bounded change.
- For full re-review, send with reviewer_send to the original Standards and Spec Reviewers with the current complete diff and updated sources. Their retained axis context is useful evidence; a new reviewer is a fallback only when the original cannot be resumed.
- Obtain the smallest relevant checks from the category owner: Orc runs its own checks and assigns Worker-owned checks to the original Worker. Read their current-head evidence. Reviewers do not run tests, builds or browsers.

Reviewers remain separated by axis. A replacement reviewer receives only its axis evidence and the prior review state.

This step is complete when each reopened conclusion is resolved and the current HEAD is recorded as reviewed.

## Output

Report `stop`, `focused review`, or `full re-review`; the reviewed HEAD and current HEAD; reused or replaced reviewer targets; reopened conclusions; checks run; and remaining blockers.

Use explicit spec/fixedPoint/reviewedHead in reviewer_send. List/read after uncertain admission, never automatically replay. Keep original profile/prompt snapshots, targets and axes; report current HEAD with Reviewer IDs. End turn after confirmed dispatch and await asynchronous reports. For PR-related Reviewers, request reviewer_close after conclusions settle and the PR is confirmed merged, unless the user explicitly requests earlier closure. For non-PR review, close after conclusions settle; retain existing lifecycle guards.

Orc owns frontend UI, database schema and migrations, one-off ops scripts, and prompts/agent instructions; Worker owns other implementation. Each owner handles its tests and fixes. Independent target-bound review belongs to Reviewer; bounded evidence investigation belongs to Researcher under `grove-research`. Researchers do not replace review axes or implement fixes. Use Grove collaboration tools; native collaboration is disabled in managed sessions.
