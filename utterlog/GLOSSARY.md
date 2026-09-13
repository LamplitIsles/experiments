# Utterlog glossary

These terms describe the local reader consistently.

Session — one continuous user/Codex exchange, and the unit chosen in the picker.

Session name — the name Codex stores for a session. It is the primary identifier shown to the user; utterlog does not generate a replacement name.

Session log — the complete local record left by a session, including conversation and tool activity. It is not the same thing as a transcript.

Transcript — the read-only conversation extracted for viewing: user-authored text and user-facing assistant messages in their original order, with other activity excluded.

Message boundary — the role, source time, and ordinal marker separating one transcript message from the next without changing the message body.

Source timestamp — the timestamp stored on the source log record. It is displayed in local `YYYY-MM-DD HH:mm` form; a missing or invalid value is `unknown time`, not a reader or export timestamp.

Reading position — the visible scroll location in the message list. Browsing and refresh preserve the nearby message and offset when the selected log changes; there is no persisted last-read position.

Follow — the reader state enabled at the bottom of the log. While follow is on, a new visible message moves the viewport to the latest content. Moving upward or starting a search pauses it; `G` or returning to the bottom resumes it.

Refresh — a reread of the selected session log. File notifications are coalesced and serialized; `r` requests one immediately. A partial or failed refresh leaves the last good transcript visible and reports status until a valid refresh succeeds.
