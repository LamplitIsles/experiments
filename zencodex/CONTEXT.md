# Zencodex reader

Zencodex is a local terminal reader and editor for Codex conversations. Its reader presents a transcript independently from the source JSONL and app-server protocol.

## Language

**Transcript**:
The ordered, user-visible conversation of message headings and rendered message bodies in the reader scroll region.
_Avoid_: Session log, source Markdown

**Held input**:
A user message accepted by the reader during conversation compaction and waiting
to be submitted to Codex. Its presence in the transcript does not mean Codex has
accepted it.
_Avoid_: Sent message, delivered message

**Compaction**:
Codex's operation that condenses a conversation's context so work can continue.
Completion of compaction is distinct from completion of an assistant answer.

**Capacity wait**:
A waiting period before resuming work after Codex reports that the
selected model is overloaded. It does not promise that capacity will be available
when the waiting period ends.

**Rendered transcript**:
The final visible rows of the transcript after Markdown rendering, layout, wrapping, and terminal styling; it excludes the composer, footer, and overlays.
_Avoid_: Markdown source, message buffer

**Search corpus**:
The normalized visible text projection of the rendered transcript, with terminal control sequences removed and whitespace normalized.
_Avoid_: Raw message body

**Search match**:
One literal occurrence in the search corpus, represented by one or more row-and-column ranges in the rendered transcript.
_Avoid_: Source-text offset, text-buffer highlight

**Current match**:
The selected search match used as the navigation target and given stronger visual treatment than other matches.
_Avoid_: Active message, selected message

**Final-frame decoration**:
The transient background and text attributes applied to match ranges only after
the reader has rendered its frame. Normal matches are underlined; the current
match is additionally bold and inverse.
_Avoid_: Markdown-buffer styling, persisted highlights
