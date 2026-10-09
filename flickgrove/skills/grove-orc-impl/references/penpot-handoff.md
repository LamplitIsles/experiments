# Penpot design handoff

Use this branch when the implementation changes a rendered UI surface with a corresponding Penpot design identified by the user, spec, PR or verified project context. The Orc owns design interpretation, the handoff and final acceptance. The worker owns implementation and comparison evidence.

## Orc preparation — before dispatch

1. Resolve the exact file/page/board IDs. Map every in-scope screen and state to its board, including loading, empty, success, failure and expanded states when designed. Use existing authoritative captures where available; query only missing information. Read the current Penpot tool overview once and verify unfamiliar API signatures before use.
2. Capture a local reference bundle under `.scratch/<feature>/design/` (untracked):
   - Official board render and its viewport/theme. If image export fails, an official SVG rendered locally is acceptable; record the method and any fidelity limits.
   - Generated HTML and CSS for each relevant board or component, obtained through the current official MCP. Where supported, `penpot.generateMarkup([shape], {type: 'html'})` and `penpot.generateStyle([shape], {type: 'css', includeChildren: true})` provide references. Verify these signatures with the current API documentation, then batch independent reads/exports as appropriate.
   - Used SVG/image assets and available token/style values with their source identifiers. Capture only resources needed for this implementation.
3. Inspect the renders and generated output yourself. Write a concrete screen/state brief: content and hierarchy, layout/spacing, typography/colors, icons/assets, controls and intended navigation. Name the existing application components and behavior to preserve. Generated HTML/CSS is a visual reference, not automatically production-quality semantic or responsive code; source-shape structure may need adaptation.
4. Reconcile the board with subsequent user decisions. List each intentional deviation and its source. Latest approved requirements govern; keep real dynamic data and domain behavior distinct from illustrative design values.
5. Record the design mapping, brief, artifact paths and limitations in the FlickNote spec through MCP, and make corresponding acceptance criteria checkable. Keep large exports local; the spec references them rather than embedding them all. Complete this step when every in-scope designed state has a brief and evidence, or an explicit missing-evidence entry with a bounded retrieval plan.

An unreadable applicable design does not become permission to invent a replacement or claim adherence. Report the exact gap. If HTML/CSS generation is unavailable but renders and measured metadata suffice, record the fallback; continue bounded authorized implementation without claiming unsupported exporter fidelity.

## Worker handoff and implementation

Supply the whole spec/ticket set plus the prepared bundle and brief. Require the worker to:

- Implement in the existing framework/component system, using the exported styles/structure/assets to reduce guesswork. HTML/CSS references do not imply a framework migration, JSX/Svelte conversion, or business-logic generation.
- Use the supplied captures first. A new Penpot query must resolve a named missing detail or concrete mismatch; broad repeated design discovery is outside the worker's task.
- Preserve the specified dynamic data, accessibility, responsive behavior and application state/navigation contracts. Treat design literals as examples where the product uses actual data.
- Render the actual changed screens/states in an isolated preview using synthetic fixtures. Match the reference viewport/theme/state for comparison, then check additional required responsive sizes independently. Tie implementation screenshots to the reported commit.
- Compare design and implementation before callback, fix concrete discrepancies, and provide a concise table: screen/state, board ID, design render, implementation screenshot, match/approved deviation/mismatch/unverified, and the reason for any difference. Cover every mapped state; screenshot count alone is not coverage.

The implementation report references that table and bundle, identifies unsupported or unverified details, and records the checks performed. Use test-owned state; preserve private records, credentials and production services.

## Orc acceptance

After callback, inspect the actual matched screenshot pairs and interaction evidence yourself. Verify that the reported implementation uses the reviewed HEAD and correct states. Resolve discrepancies against the concrete brief and sourced user decisions rather than the implementer's fidelity claim.

Follow `grove-code-review` step 3a and its configured Grove `penpot` Reviewer for independent conditional design review; the skill owns reviewer routing, evidence requirements and finding format. Standards, Spec and Penpot remain separate axes. Reviewers only read Worker evidence and never execute browser verification. Reading nodes, successful exports, generated code or passing functional tests cannot alone pass Penpot fidelity.

Send bounded fixes to the same implementation worker. After a fix or new user-approved design requirement, refresh only the affected brief/captures/screenshots and reopen only the stale review conclusions through `grove-review-again`. Keep unaffected evidence and reviewer conclusions.

Accept this branch when every in-scope designed state has comparison evidence, approved deviations are sourced, and no material design mismatch or unresolved evidence gap remains. Report any user-authorized limitation explicitly rather than silently treating it as a pass.
