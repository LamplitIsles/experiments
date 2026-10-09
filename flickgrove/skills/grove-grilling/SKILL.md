---
name: grove-grilling
description: Stress-test a plan, decision, or idea by asking only the low-confidence user-facing questions that need human judgement. Use when the user asks to grill or challenge their thinking.
---

Stress-test the work, but spend the user's attention only where their judgement can change the experience.

## Decision triage

Build the decision tree internally. Find environmental facts yourself, then assign each open decision a confidence score from 0–100.

- Decide without asking when confidence is at least 70, the answer is obvious from context, or the choice is primarily technical.
- Technical implementation, error classification, locking details, platform differences, and test strategy are agent-owned unless they create a meaningful user-visible tradeoff.
- Ask only when confidence is below 70 **and** the decision materially affects user-visible behaviour, product scope, workflow, or an irreversible preference.

For every agent-owned choice, use the simplest option consistent with the user's goals. Do not turn those choices into confirmation questions.

## Questions

Sort eligible questions by ascending confidence and ask at most five per round. Format each one as:

```
❓ **Q1 — <title>** (<confidence>% confidence): <focused question and relevant choices>

➡️ **Recommendation:** <recommended answer and brief reason>
```

After each answer, recompute the open decisions. Continue with another round whenever the answer reveals a new qualifying user-facing decision; there is no fixed round limit. Stop when no question qualifies, then present the assumptions you selected.

Finish with a concise shared-understanding summary: user decisions, agent-owned assumptions, and any explicitly deferred point. Do not begin implementation unless the user asked the session to continue into implementation.
