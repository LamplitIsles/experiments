# Utterlog glossary

These terms describe the small local reader consistently.

Session — one continuous user/Codex exchange, and the unit chosen in the picker.

Session name — the name Codex stores for a session. It is the primary identifier shown to the user; utterlog does not generate a replacement name.

Session log — the complete local record left by a session, including conversation and tool activity. It is not the same thing as a transcript.

Transcript — the read-only conversation extracted for viewing: user-authored text and user-facing assistant messages in their original order, with other activity excluded.

Message boundary — the role, source time, and ordinal marker separating one transcript message from the next without changing the message body.

Source timestamp — the timestamp stored on the source log record. It is displayed in local `YYYY-MM-DD HH:mm` form; a missing or invalid value is `unknown time`, not an export timestamp.
