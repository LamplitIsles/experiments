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
- the original Standards and Spec reviewer targets, and the Penpot target/design evidence when that axis applied;
- the findings or conclusions affected by the delta.

Use a recorded commit or reliable turn history for the reviewed HEAD. If no completed review exists, route to an initial `$grove-code-review`. If the prior reviewer targets are unavailable, retain the reviewed HEAD and replace only the missing reviewer when review work is actually needed.

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
- For full re-review, send with reviewer_send to the original Standards and Spec Reviewers with the current complete diff and updated sources. Reopen the conditional Penpot reviewer only when changed UI or design requirements invalidate its prior comparisons; supply updated screenshot pairs and the concrete brief required by `grove-code-review` step 3a. Their retained axis context is useful evidence; a new reviewer is a fallback only when the original cannot be resumed.
- Delegate the smallest relevant checks to the original Worker and read their current-head evidence. Reviewers do not run tests, builds or browsers.

Reviewers remain separated by axis. A replacement reviewer receives only its axis evidence and the prior review state.

This step is complete when each reopened conclusion is resolved and the current HEAD is recorded as reviewed.

## Output

Report `stop`, `focused review`, or `full re-review`; the reviewed HEAD and current HEAD; reused or replaced reviewer targets; reopened conclusions; checks run; and remaining blockers.

Use explicit spec/fixedPoint/reviewedHead in reviewer_send. List/read after uncertain admission, never automatically replay. Keep original profile/prompt snapshots, targets and axes; report current HEAD with Reviewer IDs. End turn after confirmed dispatch and await asynchronous reports. Close through reviewer_close only after conclusions are settled.
