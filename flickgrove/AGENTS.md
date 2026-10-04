# FlickGrove implementation rules

## Product interface

- Show information that helps the user make a decision or complete a task. Keep low-value implementation and background-maintenance details out of ordinary product flows unless the user explicitly requests them.
- Weekly quota displays the latest successfully retrieved value. Refresh requests a new value; if it fails, retain the previous value. Show unknown only when no value has been obtained. Do not add cached/stale badges, freshness timestamps, or background-refresh status copy.
- Apply the same restraint to model-list caching. Preserve available choices across refresh failures without adding cache-state labels. Keep errors actionable when they prevent the user's requested operation.
- Keep Peer connectivity and message delivery status visible where they affect available actions or require the user's attention.
- Read [DESIGN.md](DESIGN.md) before changing rendered UI or interaction behavior.
