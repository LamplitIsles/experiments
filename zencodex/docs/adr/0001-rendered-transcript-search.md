# Search the rendered transcript, not Markdown source

Transcript search is indexed from the complete laid-out transcript rows and decorates its row-and-column ranges as the final reader frame step. Raw Markdown offsets and per-node text-buffer highlights are rejected because they diverge from visible text across formatting, wrapping, and later Markdown redraws.

## Consequences

The search corpus includes rendered message headings and bodies, but excludes reader chrome and overlays. Whitespace is normalized for literal matching, and a logical match may span several physical rows. Normal matches receive background plus underline; the current match also receives bold and inverse. Tests assert the final frame's visible text, match ranges, navigation position, and visual attributes rather than Markdown-renderer internals.

## Documentation review

`zencodex/README.md` states the user-facing rendered-search guarantee. The root
README remains a package index, so its contract is unaffected. Repository
guidance was inspected and has no rendered-reader contract to update.
