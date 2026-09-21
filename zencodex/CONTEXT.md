# Zencodex reader

Zencodex is a local terminal reader and editor for Codex conversations. Its reader presents a transcript independently from the source JSONL and app-server protocol.

## Language

**Transcript**:
The ordered, user-visible conversation of message headings and rendered message bodies in the reader scroll region.
_Avoid_: Session log, source Markdown

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
