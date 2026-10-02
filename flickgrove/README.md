# FlickGrove

A local desktop workspace for Codex agents. Each tree has an Orchestrator (Orc) and its Workers. The Bun backend owns execution; closing the browser or a detail panel leaves agents running.

From the repository root:

```sh
bun install
bun run --cwd flickgrove build
bun run --cwd flickgrove start
```

Open **http://127.0.0.1:4318**. The machine needs an authenticated `codex` executable and the `og` project registry. Choose an active registered project to create a session. The application runs trusted local agents with full filesystem access and no approval prompts, matching this repository's local Codex policy. It binds only to loopback and validates browser origins. Per-agent MCP credentials remain in the backend and child process environment; browser snapshots omit them. User Codex configuration is inherited and never rewritten.

For a different port, executable, or isolated state directory:

```sh
bun run --cwd flickgrove start --port 4319 --codex /path/to/codex --state /path/to/flickgrove-state
```

State defaults to `~/.local/share/flickgrove/workspace.sqlite`. Stop the backend with Ctrl+C. On restart, previously active sessions appear interrupted; the next message resumes their durable thread. Confirmed messages, questions, answers, ownership and captured model settings survive restart. A delivery whose acceptance is unknown is never replayed automatically: check its conversation and explicitly confirm whether it arrived before retrying or closing.

Use Settings to choose the model and reasoning effort independently for new Orcs and Workers. Each role also has a Fast switch when its selected model advertises the priority service tier. Fast requests faster responses with increased usage. The selected tier is captured when an agent is created and sent explicitly on thread start/resume and new turns. Existing agents retain their captured settings. Session titles are generated from the first message with the same isolated lightweight-model strategy as ZenCodex.

Send ordinary instructions to Orc. Type `$` to select an enabled project skill; completion inserts the skill without sending. For example, ask Orc to delegate `$to-orc-impl` with one repository, one spec and one intended PR. Models and reasoning effort are application settings and do not belong in skill arguments. This application does not create, merge, or deploy PRs itself.

Workers are read-only in the browser. Orc can start, list, read, instruct and close only its own Workers through the `flickgrove` MCP server. Workers can report only to their parent. Native multi-agent spawning is disabled for these sessions. Worker async questions route to Orc; contextual replies resolve only the explicit question IDs.

Questions appear complete while execution can continue. Drafts survive refresh; selecting an option does not submit it. Left/right moves between questions only when their navigation group has focus. Send answer confirms one answer and moves to the next unanswered question. The ordinary composer remains available.

`/close` consumes an application command. Ask Orc to close its idle Workers first. A tree cannot close while work, unresolved questions, reports or unconfirmed delivery remain. Closed records stay in SQLite and the tree disappears from the canvas.

Canvas shortcuts: arrows focus nodes, Enter opens detail, E expands/collapses Workers, N creates a session, F fits the canvas, Escape closes the top dialog/detail, and ? shows help. Text editing, IME composition and completion take precedence. Node positions and question/composer drafts are browser-local.

Chrome notification permission is requested at the first pointer interaction. Notifications cover idle transitions, errors and new questions while the page is open, suppress replay after reconnect, and open the corresponding Orc. Install the PWA through Chrome or the progressive install action when available. Its service worker caches the built app shell and fonts, never API/SSE responses. Offline reload restores cached conversations and drafts with sending disabled.

For development, run the backend and `bun run --cwd flickgrove dev` in separate terminals. The Vite API proxy targets port 4318. Development does not install a service worker.

```sh
bun run --cwd flickgrove typecheck
bun run --cwd flickgrove test
bun run --cwd flickgrove build
bun run --cwd flickgrove test:browser
```

Browser checks use installed Google Chrome with an isolated Playwright profile. All test state belongs to temporary directories; tests do not use real Codex credentials or mutate the project registry. SDK tests adapt the existing ZenCodex fake app-server at the wire boundary, and MCP checks use a real stdio client against an isolated backend. A fake process verifies protocol integration, not a live model run.

Implementation record: FlickNote spec **#3109**, tickets **#3110–#3113**. Design follows the refined desktop canvas/detail reference, with FlickGrove naming and the subsequent compact skill and multiple-question decisions. English UI messages use Paraglide; Markdown is rendered as Svelte tokens with raw HTML rejected and safe links.
