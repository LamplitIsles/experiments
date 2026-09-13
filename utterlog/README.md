# utterlog

utterlog is a small Bun/TypeScript CLI for rereading named local Codex sessions. Run it in a project directory, choose a session in the built-in list, and read the selected conversation in a native OpenTUI Core terminal reader. The reader is read-only and follows the selected log while it changes.

## Install from source

You need [Bun](https://bun.sh/docs/installation) 1.3 or newer, Git, a terminal supported by OpenTUI, and local Codex session logs. This private package is installed from a checkout and is not published to npm. No Node.js installation or build step is needed.

Clone the repository and install the command:

```sh
git clone http://forgejo.localhost:17480/LamplitIsles/experiments.git
cd experiments/utterlog
bun install --frozen-lockfile
bun add --global "$PWD"
export PATH="$(bun pm bin -g):$PATH"
utterlog --help
```

The clone URL above is this repository's local Forgejo address. If you are installing on another machine, use the clone URL reachable from that machine. If you already have a checkout, start at `cd experiments/utterlog` using its actual location.

The PATH export applies to the current shell. For Bash or Zsh, add the same line to `~/.bashrc` or `~/.zshrc` so new terminals can find `utterlog` (Bun must already be on PATH):

```sh
export PATH="$(bun pm bin -g):$PATH"
```

Now change to the directory whose Codex sessions you want to read:

```sh
cd /path/to/your/project
utterlog
```

The current directory is matched exactly. Select a session with `j/k` or the arrow keys, then press `Enter` to read it. `b` or `Esc` returns to the list; `q` exits.

The global command links to the source checkout and runs with Bun. Keep that checkout and its dependencies in place; moving or deleting them breaks the command. After moving the checkout, register it again with `bun add --global "$PWD"` from its `utterlog` directory.

### Run without global installation

After cloning and running `bun install --frozen-lockfile` in the package directory, invoke the source entry point from the directory you want to browse:

```sh
cd /path/to/your/project
bun /absolute/path/to/experiments/utterlog/src/cli.ts
```

### Update a source installation

From the same checkout, pull the latest source and refresh its dependencies:

```sh
cd /absolute/path/to/experiments
git pull --ff-only
cd utterlog
bun install --frozen-lockfile
utterlog --help
```

Restart `utterlog` to use the updated source. Reinstalling the global command is unnecessary while the checkout stays at the same path.

## Selection and scope

The picker receives named sessions whose normalized absolute `session_meta.payload.cwd` exactly equals the directory where utterlog was started. A parent, child, or sibling directory is not included. Only current top-level human sessions (`source: cli` or `exec`, `thread_source: user`) in `CODEX_HOME/sessions` are considered; archived and spawned-agent sessions are outside this first version.

Names come from `session_index.jsonl`, joined by `session_meta.payload.id` (which currently agrees with `session_id`). The latest valid name entry is used. Unnamed sessions are omitted and reported; utterlog never invents a name from a prompt.

Discovery filters by directory before validating candidate logs, so unrelated historical formats do not produce warnings. Headers are read with bounded concurrency; sorting reads backwards from each candidate log’s tail instead of loading its full conversation. The full log is read only after selection.

Rows are ordered by the timestamp on the last complete record in each session log, newest first. Each row shows local activity time, session name, and a unique short session ID. Selection uses the full session identity, so duplicate names remain separate entries.

Use `j/k` or arrows to select, `gg/G` for the first/last row, and `Enter` to open. Press `/` to enter a literal, case-insensitive name filter, `Enter` to apply, or `Esc` to cancel editing. Applying an empty filter shows all sessions. A filter with no matches keeps the list open so you can change it. `q`, `Esc` outside editing, or `Ctrl-C` exits.

The list and reader share one terminal renderer. Returning with `b` reloads the list and preserves the filter and selected session when it still exists. The command requires interactive stdin/stdout.

## Reader

The reader starts at the newest content with follow enabled. Each user-facing message has a separate role/time boundary, and its body is lightly rendered as local Markdown. Headings, lists, emphasis, code blocks, links, Chinese text, and ordinary line wrapping remain readable. Tool calls/output, reasoning, mirrored activity, injected context, shell activity, images, and inter-agent messages stay excluded. Message bodies are not summarized or truncated. Times are local `YYYY-MM-DD HH:mm`; the header states the local IANA timezone once. Missing or invalid source timestamps display as `unknown time`.

Drag to select text with the mouse; releasing copies the selected text through the terminal’s OSC 52 clipboard support. The status reports that the copy was sent, or that clipboard support is unavailable. This requires a terminal that permits OSC 52 writes.

Controls:

| Key | Action |
| --- | --- |
| `j` / `k`, `↑` / `↓` | Scroll one display line |
| `Ctrl-d` / `Ctrl-u` | Scroll half a viewport |
| `gg` / `G` | Go to the beginning / end |
| `/` | Start a literal, case-insensitive conversation search |
| `Enter` / `Esc` | Apply search / leave editing without quitting |
| `n` / `N` | Next / previous search occurrence, wrapping |
| `r` | Explicitly refresh the selected log |
| `q` / `Ctrl-C` | Quit utterlog |
| `b` / `Esc` | Return to a freshly loaded picker (`Esc` first cancels active search editing) |

Search covers message bodies and headers (message number, role, and local time), in display order. For example, `/message 620` locates that message's header. Search pauses follow and reports the current match position/count. An empty search clears the query; no matches are shown explicitly. Matches inside long messages are positioned in the viewport, not only at a message header.

The reader watches only the selected log. Appends are coalesced and reads are serialized. At the bottom, follow moves to a new visible message automatically. While browsing or searching, the current position remains stable and a new-content notice appears; `G` returns to the latest content and resumes follow. In-progress partial JSONL records and read/parse failures keep the last good view and show a concise status. A later valid refresh or `r` recovers it. Replaced or truncated logs are re-anchored or clamped with a change notice.

The Codex session index and logs are never written. Watchers, timers, input listeners, and in-flight refresh ownership end when leaving the reader. The shared terminal renderer is destroyed when utterlog exits. A cancelled picker exits without opening a reader.

## Supported storage and failures

The supported input is the current local Codex sessions tree and `session_index.jsonl` schema observed by this tool. There is no app-server connection, network service, archive browser, resume operation, old-schema compatibility layer, cross-session search, or external editor path.

Missing storage or names, an unsupported/corrupt selected log, an empty transcript, and a noninteractive terminal produce an explanatory result. An unfinished final record from an active writer is ignored; a malformed complete JSONL record is reported and does not replace the last good reader view.

## Development

From this directory:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The tests use isolated fake Codex homes, test-owned temporary logs, native OpenTUI in-memory frames, and a real terminal fixture. They do not read or modify real Codex state, credentials, installed executables, or services. Keep `.scratch/` planning material out of Git.

See [GLOSSARY.md](GLOSSARY.md) for the reader’s terms.
