# Zencodex reader

Zencodex is a local terminal reader and editor for Codex conversations. Its reader presents a transcript independently from the source JSONL and app-server protocol.

## Language

**Follow-up job**:
A user instruction intended to begin after the current assistant turn finishes,
not to redirect that turn while it is running.
_Avoid_: Steering input, held input

**Steering input**:
A user instruction intended to influence the assistant's current ongoing turn.
_Avoid_: Follow-up job

**Terminal scrollback search**:
Finding text in the output retained by the terminal host. Its scope is retained
terminal output, not necessarily the complete conversation.
_Avoid_: Conversation-history search

**Conversation-history search**:
Finding saved conversation content independently of what a terminal currently
displays or retains. Its searchable content depends on the history collection.
_Avoid_: Terminal scrollback search

**Transcript**:
The ordered, user-visible conversation of user messages and completed assistant answers.
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

**History replay**:
The redisplay of saved conversation messages when reopening a conversation or
refreshing a changed source projection. Terminal resizing does not trigger replay.
Omission from
replay does not remove a message from saved history or model context.
