# ADR 0002: One local instance

Status: accepted for spec #4141; supersedes the fixed-Hub and symmetric-Peer topology in ADR 0001 and FlickNote ADR #3283.

## Decision

Each instance serves its own browser UI and local workspace. Remove remote registration, browser credentials, host selection/aggregation and routing. Browser HTTP/socket/voice/preview creation require the configured address and permitted page origin (or same-origin Fetch Metadata for HTTP reading). A former bearer token cannot grant foreign-origin access. Local MCP retains per-agent token checks and its loopback address boundary. Preview resource capabilities retain their sandbox, lifetime and canonical path boundaries.

Keep the existing stable instance ID in hosts.json and instance-qualified public IDs because durable browser submissions, image drafts, reading caches and owner/report relationships use that namespace. These IDs identify local data; they do not select a remote service. Existing files are not rewritten, and no live state is migrated or wiped. New identity files contain no Peer credential. Browser preferences and caches remain origin-scoped; legacy remote registrations are never read or contacted.

Local Orc, Worker, Reviewer and Researcher lifecycle and authorization stay with the owning workspace. Pending outcomes retain their operation ID and reconcile by lookup. Missing or null receipts do not authorize automatic replay.

## Evidence boundary

Isolated handler/socket regressions demonstrate that a stale supplied Peer token previously rejected same-origin access. They do not establish the cause of the reported intermittent live error. No live reproduction, restart or deployment is part of this change.

## HTTPS termination

For browser HTTP admission, an explicit Origin must exactly match a configured origin and the request Host. Without Origin, `Sec-Fetch-Site: same-origin` and a configured Host are required; the matching configured origin supplies the public scheme. Fetch Metadata that indicates another site is denied even with an allowed Origin. Forwarded headers never grant access. Socket admission still requires explicit Origin. Preview creation returns the admitted public origin; Markdown capability links are relative to the serving origin so TLS termination does not produce HTTP links.

Spec #4143 adds real Bun listener regressions with HTTP backend/public HTTPS Host and absent Origin. Earlier checks covered explicit Origin and direct HTTP, omitting this production request shape. This confirms and repairs that request-shape defect; the user's exact original browser action remains unknown. Tests use owned state and do not establish deployment or a live user outcome.
