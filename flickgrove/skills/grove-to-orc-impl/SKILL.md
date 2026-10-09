---
name: grove-to-orc-impl
description: Turn an agreed discussion into a self-reviewed spec, then delegate the whole repository scope to one Grove Worker and publish one PR.
---

Run only after product decisions are settled; do not restart discovery.

1. Read `grove-to-spec` completely, create the FlickNote spec, and run `grove-spec-self-review` to readiness. Record documentation and agent guidance acceptance in the spec.
2. Read existing tickets when present. Create tickets through `grove-to-tickets` only when the user explicitly requests them. A spec without tickets is a complete assignment.
3. Read `grove-orc-impl` completely. Dispatch one Worker for the whole spec in the registered checkout, including documentation, all verification and deterministic review repairs; one branch and one PR per repository.

For multiple repositories use one spec/Worker/PR per repository. Link cross-repository contracts in each spec and finish blocking contracts before dependent acceptance. No implementation delegation through native agents. Model and reasoning configuration belongs to Grove.
