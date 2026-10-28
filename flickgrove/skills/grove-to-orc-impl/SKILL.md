---
name: grove-to-orc-impl
description: Turn an agreed discussion into a self-reviewed spec, then coordinate category-owned implementation and one PR.
---

Run only after product decisions are settled; do not restart discovery.

1. Read `grove-to-spec` completely, create the FlickNote spec, and run `grove-spec-self-review` to readiness. Record documentation and agent guidance acceptance in the spec.
2. Read existing tickets when present. Create tickets through `grove-to-tickets` only when the user explicitly requests them. A spec without tickets is a complete assignment.
3. Read `grove-orc-impl` completely. Follow its category ownership: Orc implements frontend UI, schema/migrations, one-off ops scripts and prompts/agent instructions; one Worker implements other work. Each owner handles its tests and fixes. Use one branch and one PR per repository, serially coordinating mixed work.

For multiple repositories use one spec and PR per repository, with at most one Worker when its category is needed. Link cross-repository contracts in each spec and finish blocking contracts before dependent acceptance. No implementation delegation through native agents. Model and reasoning configuration belongs to Grove.
