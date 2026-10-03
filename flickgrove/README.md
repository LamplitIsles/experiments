# FlickGrove

A persistent Orc/Worker workspace shared by desktop and mobile browsers. The **fixed NUC Hub** is the single browser entry; each tree and every Worker stay on their execution host. Closing a browser or conversation leaves execution running. The former ZenCodex TUI has been retired; title generation and the isolated fake app-server now belong to FlickGrove.

From the repository root:

```sh
bun install
bun run --cwd flickgrove build
# NUC: explicit Hub, which also owns its local execution workspace
bun run --cwd flickgrove start --hub --name NUC
# Other host: execution service only, no frontend or PWA
bun run --cwd flickgrove start --name "Neil’s Mac"
```

The default address is **http://127.0.0.1:4318**. Only `--hub` serves the frontend. Each execution machine needs an authenticated `codex` executable and its own active `og` project registry. Choose a host before one of that host's registered projects. Creation opens its Orc with the composer focused. Agents run with full filesystem access and no approval prompts, matching this repository's local Codex policy. Codex configuration is inherited, never rewritten.

## Operator configuration and host registration

Loopback is the default listener. Use explicit `--listen` and `--origin` for an existing Kepos HTTP access path; this application does not provision tunnels, launch SSH processes or configure Kepos. The origin must be an HTTP(S) origin without a path, query or embedded credentials. For example, using already established reachability:

```sh
# Hub: browser-facing advertised origin, with a listener reachable by its proxy
bun run --cwd flickgrove start --hub --name NUC \
  --listen 0.0.0.0 --port 4318 --origin https://grove.example.kepos
# Peer: advertised service origin reachable from the Hub
bun run --cwd flickgrove start --name "Neil’s Mac" \
  --listen 0.0.0.0 --port 4318 --origin https://mac.example.kepos
```

Those domains are examples. Configure the existing proxy to preserve the configured Host and browser Origin. Host validation applies to all HTTP requests; browser mutations also require the Hub's exact Origin. Local agent MCP calls use **http://127.0.0.1:PORT**, independently of the advertised origin, and require a separate agent token. Bind to an interface including loopback when using these local MCP calls. The application supplies that local MCP origin and each agent credential only to the local child process.

`--state DIRECTORY` selects isolated durable state; the default is `~/.local/share/flickgrove`. `--codex /path/to/codex` selects the executable. `workspace.sqlite` owns local conversations and captured session settings. Private `hosts.json` contains the generated stable instance identity, its access credential and, on Hub, peer credentials and desired defaults. It is written with mode 0600 in a directory created with mode 0700. Protect this directory; do not publish or copy its contents to a browser. The execution service prints the credential **file path**, never the token. Read the peer's `credential` locally as the operator, then supply it in **Settings → Hosts → Add host** with its name and reachable service origin.

Adding a host authenticates `/execution/identity`, checks the execution role and fetches state before saving. Duplicate/self identities, Hub peers, redirects, non-HTTP(S) URLs and identity swaps on address edits are rejected. The masked access-token field is never populated from stored secrets or saved in browser storage. An edit may leave it blank to retain the existing private token. The verified directory is shared across all access devices; names and URLs do not define execution ownership.

Execution API paths use `/execution/…` with `Authorization: Bearer INSTANCE_CREDENTIAL`; default mode exposes these and local `/api/mcp/…` only. Browser `/api/…`, SSE and frontend assets belong only to Hub. Agent IDs in the Hub API are qualified by stable host ID; equal host-local IDs cannot collide. Agent tokens never appear in public snapshots or conversations.

## Shared sessions, defaults and outages

Settings store one desired Orc model/effort, one Worker model/effort and one global **Fast** switch on Hub. Fast requires priority-tier support for both selected models. Desired defaults publish to connected execution hosts; Hosts shows pending or failed synchronization. Reconnect checks identity, refreshes authoritative state and resynchronizes defaults. Creation validates the current desired defaults at the selected host and refuses unsupported models, effort or Fast; it never silently downgrades. New Orcs and Workers capture these settings. Existing sessions keep their captured model, effort and service tier. During Hub loss, an execution host and its local MCP tools continue using its last synchronized new-session defaults.

A disconnected host retains its last-known trees and viewed conversations with last-seen information. Its create, send, answer, Stop, close and reconciliation actions are unavailable. Other hosts remain usable. Polling is bounded, and reconnection is automatic. A mutation is forwarded once; a lost response produces an unknown outcome. No reconnect queue or automatic mutation replay exists. Inspect the refreshed conversation and explicitly reconcile an uncertain owner-side delivery before retrying. A question answered in another browser appears answered everywhere; concurrent submissions are deduplicated at its execution owner.

The registry, desired defaults, conversations, questions and submitted answers are shared. Host filters, selected conversation, viewport, node positions and unsent drafts belong to each access device, scoped to the Hub origin and host-qualified agent IDs. Mobile uses an Orc list and full-screen conversation, with usable host/settings forms. Hub loss interrupts unified browser access; surviving execution services keep their trees. There is no tree replication, takeover or leader election.

Stop the backend with Ctrl+C. On restart, active local sessions appear interrupted; the next explicit message resumes their durable thread. Confirmed messages, questions, answers, ownership and captured models survive restart. Remote Hub display caches are in memory only, refreshed from their owner after startup.

## Conversation controls and usage

Send ordinary instructions to Orc. `$` opens a separate skill search over the owning host's project. Search matches skill names and full descriptions with Organon-style ranking; Tab or Enter inserts the selected name at the saved cursor position without sending. Escape cancels without changing the message draft. Models and effort are settings, not skill arguments. Session titles are generated from the first message in a separate lightweight-model thread. This application does not create, merge or deploy PRs itself.

Click an Orc title in its detail panel to edit it. Enter or the checkmark saves; Escape or Cancel discards the edit. The owning execution host saves the canonical Codex thread name through `thread/name/set`, then updates its workspace display cache, including remote hosts. Failed saves retain the old title. Backend startup reads Orc names without resuming turns; explicit thread resume refreshes them again. Unreachable Codex reads retain the last cached title. Changing a title sends no model message. Worker titles remain managed by Orc.

Workers are read-only in the browser. Orc can start, list, read, instruct and close only its own Workers through the host-local `flickgrove` MCP server. Workers report only to their parent. Native multi-agent spawning is disabled for these sessions. Worker async questions route to Orc; contextual replies resolve only explicit question IDs.

`worker_close` records a durable closure request. A ready Worker closes immediately; a running Worker completes its current turn without interruption and closes automatically once its reports are delivered and delegated questions are answered. Pending Workers show Closing and a waiting reason and reject new tasks; explicit answers to existing questions remain allowed. Failed terminal turns also permit closure. Restart or disconnection retains the request with an unknown outcome; Orc can inspect it and explicitly use `confirmInterrupted` to acknowledge the interruption, while report and question guards still apply. This does not change the user’s `/close` command.

Incoming Worker reports appear on the left of the conversation timeline as folded cards. Expand a card to read its full Markdown; ordinary user messages remain separate. This uses existing delivery source and reporting Worker IDs and adds no report storage.

Questions appear complete while execution may continue. Selecting an option does not submit it. Left/right changes questions only when the navigation group has focus. **Send answer** confirms one answer and advances to the next unanswered question. Question and composer drafts survive refresh; IME and text editing retain precedence over application shortcuts.

Slash completion offers **exactly `/stop` and `/close`**. Selecting inserts; submitting executes. `/compact` is not an application command. A Working Orc has a prominent Stop button and a composer stop square. Stop calls official SDK interruption for the **observed current Orc turn ID**; it never stops Workers. Stopping stays pending until an authoritative completion arrives. Confirmed user interruption returns Idle and shows feedback; a normally completed turn shows its actual outcome. Unknown acceptance stays unknown, never becomes success on a timer and never stops a later turn through replay. Reports, questions and uncertain deliveries remain available and retain close guards. A report received while Stopping is retained for explicit retry after the turn outcome.

`/close` is an explicit user action. Ask Orc to close its Workers first. Closure requires an idle Orc, no open Workers, no unanswered questions, no undelivered reports and no unconfirmed delivery. Success removes the tree; refusal explains the guard. **Zero Workers is only a current count**; the application does not infer task completion or suggest closing from it.

The upper-right weekly ring shows **remaining account quota**, for the selected tree's host account or Hub's account when nothing is selected. The host catalog reads official account rate limits and chooses the window with `windowDurationMins: 10080`, regardless of primary/secondary position. Remaining is clamped `100 - usedPercent`; missing data is a dash, never invented zero. Hosts and model quota buckets are never summed. Cyan is normal; amber means 20% or less. The popover shows account identity when supplied, source host, supplied reset time and freshness. Selection refreshes value/source together; refresh is available and periodic reads are bounded to one minute. Failures do not interrupt conversation use.

## Browser and development

Shortcuts: arrows focus nodes, Enter opens detail, E expands/collapses Workers, N opens creation with project-search focus, F fits the canvas, I focuses the message input in an Orc detail, Escape closes the top dialog/detail, and ? shows help. Zoom controls include a percentage and Fit all. Text editing, IME, slash/skill completion and question navigation take precedence. Tab completes the current `/` or `$` candidate and never traverses toolbar or Send controls. With no candidate it keeps the current input target. Enter sends from the composer; Shift+Enter inserts a newline. Send remains clickable and Stop has its own control while Orc is working. Tree closure produces a three-second toast.

Chrome notification permission is requested at first pointer interaction. Notifications cover idle transitions, errors and new questions while the page is open, suppress replay after reconnect, and open the corresponding Orc. Install the PWA through Chrome or the progressive install action. Its service worker caches the built shell/fonts, never API/SSE responses. Offline reload restores cached conversations and drafts with sending disabled. Secrets are not browser-cached.

For development, start the backend **with `--hub`**, then run `bun run --cwd flickgrove dev`. The Vite API proxy targets port 4318; development does not install a service worker.

```sh
bun run test
bun run typecheck
bun run format:check
bun run lint
bun run --cwd flickgrove build
bun run --cwd flickgrove test:browser
```

Browser tests use installed Chrome with isolated profiles. All test state, Codex homes, credentials and project paths are temporary or synthetic. No test uses installed user credentials or changes the real project registry. Workspace/FakeRuntime, two-host HTTP, SDK fake wire and real stdio MCP seams verify ownership, answers, defaults, outages, Stop and usage without paid calls. The preview server in `tests/design-serve.ts` exposes fixture controls only in tests, never the production handler. The multi-device browser test captures all 29 mapped states at 1440×900 and 390×844 into `.scratch/flickgrove-multi-device/implementation/`.

Implementation authority: FlickNote **spec #3133**, tickets **#3134–#3139**, building on #3109 and merged ZenCodex removal PR #20. [ADR: fixed Hub and execution ownership](docs/adr/0001-fixed-hub.md). English UI uses Paraglide; Markdown rejects raw HTML and unsafe links. Mobile supplementary management/Stop/weekly controls have no separate pixel board and follow the bounded Owner handoff.

## UI foundation

Desktop session creation uses N; ? opens shortcut help. Hosts management lives in Settings. The full-height detail panel covers right-hand header utilities and puts host, state, model and reasoning metadata above the title. Arrow navigation pans offscreen nodes into view without changing zoom. Mobile retains a New session button.

The frontend uses project-owned shadcn-svelte components (Bits UI), Lucide icons and a compact dark workbench theme. Read [DESIGN.md](DESIGN.md) before changing the component layer. The canvas keeps one restrained navigation marker for shortcut-driven node selection; ordinary buttons do not retain visible focus rings after pointer actions.
