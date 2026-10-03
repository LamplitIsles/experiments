# ADR 0001: Fixed Hub and host-owned execution

Status: accepted for spec #3133; implemented in the same PR as tickets #3134–#3139.

## Context

Desktop and mobile users need one persistent NUC entry for multiple Orc/Worker trees. Each execution host already owns durable threads, local project registration, provider credentials, delivery IDs and collaboration authorization. Replication or automatic takeover would add ownership ambiguity and mutation replay hazards.

## Decision

The existing backend has two explicit startup responsibilities. Default mode is an authenticated execution service with local per-agent MCP. `--hub` additionally serves frontend/PWA/browser APIs, persists the shared verified host directory and desired new-session defaults, and includes its own execution workspace. The NUC is the fixed Hub. There is no discovery election, SSH orchestration or Kepos provisioning.

Stable generated host identity plus host-local agent ID define aggregate identity. Worker owner references and routing use that pair. A complete tree, its MCP collaboration and provider credentials stay on one execution host. The Hub forwards a mutation once to that owner, preserving delivery/request/question IDs. Private instance and peer credentials live in mode-0600 host-local state, separate from browser preferences; agent credentials never cross the public boundary. Browser Host/Origin checks and peer bearer authorization serve different callers. Local MCP origin stays loopback even when browser/service origins are advertised through an existing proxy.

The Hub polls peers with bounded requests and keeps snapshots/viewed details only as an in-memory display cache. An outage retains last-known display data and freshness, disables owner mutations and leaves other hosts available. Reconnect verifies identity and refreshes authoritative state without mutation replay. The execution owner serializes answers, reconciles uncertain delivery and checks Stop against the observed turn. Hub loss does not stop independent execution or local collaboration.

Hub defaults are desired shared state, synchronized to connected peers and after reconnect. Capability validation gates new creation; failed/pending synchronization is visible. Existing agents retain captured model/effort/tier. Disconnected hosts may create tree-local Workers using their last synchronized defaults. Browser filters, selected detail, list scroll/expansion, cached quota and drafts remain access-device preferences; messages and answers are owner state.

Stop interrupts only the observed current Orc turn through official SDK interruption; authoritative completion determines its outcome. Close occurs only on explicit submission and retains existing unresolved-work guards. Weekly remaining uses one canonical account quota window of 10080 minutes at the selected tree's host, or Hub; host/model percentages are not added.

## Consequences

The Hub is an intentional unified-access availability dependency, with no automatic replacement. Remote conversations are not durable replicas on Hub. Operators configure origins/listeners and register authenticated service identities over already established HTTP reachability. Unknown mutation acceptance requires inspection and owner-side reconciliation, never retry-on-reconnect. Mobile presents a list and full conversation while desktop keeps XYFlow. Deployment is separate from this implementation and is not performed by the PR.
