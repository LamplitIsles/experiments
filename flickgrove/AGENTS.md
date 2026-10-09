# FlickGrove implementation rules

## Product interface

- Show information that helps the user make a decision or complete a task. Keep low-value implementation and background-maintenance details out of ordinary product flows unless the user explicitly requests them.
- Weekly quota displays the latest successfully retrieved value. Refresh requests a new value; if it fails, retain the previous value. Show unknown only when no value has been obtained. Do not add cached/stale badges, freshness timestamps, or background-refresh status copy.
- Apply the same restraint to model-list caching. Preserve available choices across refresh failures without adding cache-state labels. Keep errors actionable when they prevent the user's requested operation.
- Keep Peer connectivity and message delivery status visible where they affect available actions or require the user's attention.
- Read [DESIGN.md](DESIGN.md) before changing rendered UI or interaction behavior.

## Managed collaboration

- Orc coordinates, investigates and discusses; all code development and repairs go to its implementation Worker, without a small-fix exception. Reviewer reads code/spec/existing evidence and does not edit reviewed files or run tests, builds or browsers. Missing verification is Worker work.
- Use the shipped `grove-` workflows and Grove Reviewer lifecycle. Keep original reviewers and target-bound conclusions for focused re-review. Model/effort and axis prompt defaults live in execution Peer configuration; global skill/config files stay untouched.
- Reviewer runtime, native discovery and browser checks must use test-owned configuration, homes and state. Do not use credentials or paid turns to validate discovery, roles or UI.
