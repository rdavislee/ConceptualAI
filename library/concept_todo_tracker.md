# Concept Library Todo Tracker

Created: 2026-02-10

Purpose: Keep a running checklist for each concept, focused on:
- lifecycle cleanup methods (especially delete by user / delete by item / delete by target)
- places the current code can be made faster
- other correctness or maintenance concerns

Status note: unchecked (`[ ]`) items are still doable now in this codebase; checked (`[x]`) items are either completed or triaged as deferred/not currently doable (reason included).

## Global Optional Patterns

Note: Concepts are treated as modular. Cross-concept normalization is expected to happen in syncs, not by forcing uniform concept APIs.

- [x] Add an explicit index migration/bootstrapping strategy across all concepts (not just ad hoc indexes). (platform-level concern; move to sync/engine backlog)
- [x] Add pagination/limit options to broad list queries to avoid unbounded reads. (cross-concept/API concern; move to sync/engine backlog)
- [x] Replace `countDocuments` existence checks with `findOne` projection checks where only existence is needed. (global rule is out of scope; apply only case-by-case per concept)
- [x] Review multi-document write paths (`Promise.all` on separate collections/docs) and add transactions where consistency matters. (system architecture concern; track at sync/engine level)
- [x] Stabilize concept test harness: Mongo/TLS resources intermittently trip Deno leak checks; standardize cleanup strategy or explicit test sanitization policy. (test infrastructure concern)

---

## Section 1 (Agent 1)

Assigned concepts: `Accessing`, `Archiving`, `Authenticating`, `Blocking`, `Commenting`, `Connecting`
Background refs: [Concept Design Overview](../design/background/concept-design-overview.md), [Concept Specifications](../design/background/concept-specifications.md), [Implementing Concepts](../design/background/implementing-concepts.md), [Testing Concepts](../design/background/testing-concepts.md), [Concept State Details](../design/background/detailed/concept-state.md), [Concept Rubric](../design/background/detailed/concept-rubric.md)

## Accessing

- [x] [Delete lifecycle] Add `deleteBySubject(subject)` cleanup.
- [x] [Delete lifecycle] Add `deleteByTarget(target)` cleanup.
- [x] [Speed] Add indexes for lifecycle and query paths: `{ subject: 1 }`, `{ target: 1 }`, `{ subject: 1, target: 1 }`.
- [x] [Other] No additional correctness concern identified in current implementation.

## Archiving

- [x] [Delete lifecycle] Add `deleteByTarget(target)` for hard target deletion.
- [x] [Speed] Add `{ archivedAt: -1 }` index for `_allArchived()` sorting.
- [x] [Other] Remove `findOne` + `insertOne` race in `archive`; replace with a single upsert/guarded write.

## Authenticating

- [x] [Delete lifecycle] Base lifecycle exists via `deleteAuthentication(email)`.
- [x] [Delete lifecycle] Add `deleteAuthenticationByUser(user)` for account deletion flows that only have user ID.
- [x] [Speed] In `register`, avoid `findOne` pre-check + insert; rely on unique index and duplicate key handling in one write path.
- [x] [Other] Replace unsalted SHA-256 password hashing with Argon2/bcrypt/scrypt. (implemented via salted scrypt with legacy-hash compatibility + opportunistic rehash)

## Blocking

- [x] [Delete lifecycle] Add `deleteByBlocker(blocker)` cleanup.
- [x] [Delete lifecycle] Add `deleteByBlocked(blocked)` cleanup.
- [x] [Speed] Add indexes `{ blocker: 1 }` and `{ blocker: 1, blocked: 1 }` (plus optional reverse index for symmetric lookups).
- [x] [Other] Enforce uniqueness for `(blocker, blocked)` to prevent duplicate blocks under race.

## Commenting

- [x] [Delete lifecycle] Add `deleteByAuthor(author)` cleanup.
- [x] [Delete lifecycle] Add `deleteByItem(item)` cleanup.
- [x] [Speed] Add indexes `{ item: 1, createdAt: 1 }`, `{ item: 1 }`, and `{ author: 1 }`.
- [x] [Other] Decide whether hard delete is acceptable or if moderation/audit needs soft-delete metadata. (deferred: design/product decision)

## Connecting

- [x] [Delete lifecycle] Add `deleteByRequester(requester)` cleanup.
- [x] [Delete lifecycle] Add `deleteByResponder(responder)` cleanup.
- [x] [Speed] Add indexes `{ responder: 1, status: 1 }` and `{ requester: 1, status: 1 }`.
- [x] [Other] ID normalization (`getId`) is good; no additional correctness issue identified.

## Section 2 (Agent 2)

Assigned concepts: `DownloadAnalyzing`, `Events`, `Expiring`, `Following`, `Identifying`, `Joining`
Background refs: [Concept Design Overview](../design/background/concept-design-overview.md), [Concept Specifications](../design/background/concept-specifications.md), [Implementing Concepts](../design/background/implementing-concepts.md), [Testing Concepts](../design/background/testing-concepts.md), [Concept State Details](../design/background/detailed/concept-state.md), [Concept Rubric](../design/background/detailed/concept-rubric.md)

## DownloadAnalyzing

- [x] [Delete lifecycle] Add `deleteByItem(item)` cleanup.
- [x] [Delete lifecycle] Add `deleteByUser(user)` cleanup.
- [x] [Speed] Avoid loading full `downloads` arrays for counts; switch to an event collection + aggregation query path. (deferred: would require schema change to event collection + aggregation)
- [x] [Other] `record` returns success when `item` is missing, which can hide upstream caller errors.

## Events

- [x] [Delete lifecycle] Add `deleteByOwner(owner)` cleanup.
- [x] [Speed] Add index `{ owner: 1, startTime: 1, endTime: 1 }` for overlap queries.
- [x] [Other] `updateEvent` and `deleteEvent` take only `eventId`; add owner/actor checks to prevent unauthorized mutation.

## Expiring

- [x] [Delete lifecycle] Add `deleteByItem(item)` explicit cleanup for item deletion events.
- [x] [Speed] Add indexes `{ item: 1 }` and `{ expiresAt: 1 }`.
- [x] [Speed] Add TTL or scheduled cleanup strategy for expired records.
- [x] [Other] Expired entries remain unless explicitly removed; define retention policy. (deferred: policy decision)

## Following

- [x] [Delete lifecycle] Add `deleteByFollower(follower)` cleanup.
- [x] [Delete lifecycle] Add `deleteByFollowed(followed)` cleanup.
- [x] [Speed] Replace `countDocuments` checks with `findOne` existence checks.
- [x] [Speed] Revisit embedded arrays (`followers`/`following`) for high-cardinality accounts. (deferred: structural redesign)
- [x] [Other] `Promise.all` + `$push` on two docs is non-transactional and race-prone (possible drift/duplicates). (deferred: would need transaction support)

## Identifying

- [x] [Delete lifecycle] Covered by `removeRole(user)`.
- [x] [Speed] Current API shape is already efficient for key-based lookups.
- [x] [Other] Confirm whether one role per user is sufficient; current model cannot represent multi-role identities. (deferred: design confirmation)

## Joining

- [x] [Delete lifecycle] Add `deleteByMember(member)` cleanup.
- [x] [Delete lifecycle] Add `deleteByTarget(target)` cleanup.
- [x] [Speed] Add indexes `{ member: 1 }` and `{ target: 1 }` for list queries.
- [x] [Other] `join` uses check-then-insert and can race; enforce uniqueness with atomic write strategy.

## Section 3 (Agent 3)

Assigned concepts: `Liking`, `MediaHosting`, `Messaging`, `Notifying`, `Organizing`, `Posting`
Background refs: [Concept Design Overview](../design/background/concept-design-overview.md), [Concept Specifications](../design/background/concept-specifications.md), [Implementing Concepts](../design/background/implementing-concepts.md), [Testing Concepts](../design/background/testing-concepts.md), [Concept State Details](../design/background/detailed/concept-state.md), [Concept Rubric](../design/background/detailed/concept-rubric.md)

## Liking

- [x] [Delete lifecycle] Add `deleteByUser(user)` cleanup.
- [x] [Delete lifecycle] Add `deleteByItem(item)` cleanup.
- [x] [Speed] Replace `countDocuments` checks with `findOne` for existence.
- [x] [Speed] Add indexes for `users.likes.item` and `items.likes.user` access patterns.
- [x] [Other] Non-atomic dual updates + embedded arrays can drift and grow without bound (design limitation; would require separate Likes collection). (deferred: larger model refactor)

## MediaHosting

- [x] [Delete lifecycle] Add `deleteByUploader(uploader)` cleanup for account deletion.
- [x] [Speed] Add index `{ uploader: 1, createdAt: -1 }` for `_getMediaByUser`.
- [x] [Other] Evaluate moving large binary payloads out of primary documents (GridFS/object storage) (deferred: storage architecture decision).

## Messaging

- [x] [Delete lifecycle] Add `deleteBySender(sender)` cleanup.
- [x] [Delete lifecycle] Add `deleteByRecipient(recipient)` cleanup.
- [x] [Speed] Add indexes for conversation retrieval:
  - `{ sender: 1, recipient: 1, createdAt: 1 }`
  - `{ recipient: 1, createdAt: -1 }`
  - `{ sender: 1, createdAt: -1 }`
- [x] [Speed] Add pagination to message list queries.
- [x] [Other] `edits` array can grow unbounded; consider cap or archive strategy (deferred: API-breaking change).

## Notifying

- [x] [Delete lifecycle] Add `deleteByRecipient(recipient)` cleanup.
- [x] [Delete lifecycle] Add `deleteByTrigger(trigger)` cleanup.
- [x] [Speed] Add indexes `{ recipient: 1, createdAt: -1 }` and `{ recipient: 1, status: 1 }`.
- [x] [Other] `_allNotifications()` should be admin-only and paginated (authz is synchronization-layer concern; concept keeps raw query capability).
- [x] [Other] `markAsRead` includes `$setOnInsert` without upsert; remove dead logic or refactor update path.

## Organizing

- [x] [Delete lifecycle] Add `deleteByLeader(leader)` cleanup for leader removal/account deletion.
- [x] [Delete lifecycle] Add `deleteUnit(unit)` with explicit item cascade behavior.
- [x] [Speed] Add indexes `{ unit: 1, active: 1 }` and `{ leader: 1 }`.
- [x] [Other] Prevent orphaned items when units are removed or merged (addressed by deleteUnit cascade).

## Posting

- [x] [Delete lifecycle] Add `deleteByAuthor(author)` cleanup.
- [x] [Speed] Add indexes `{ author: 1, createdAt: -1 }`, `{ type: 1, createdAt: -1 }`, and `{ createdAt: -1 }`.
- [x] [Speed] Add pagination to `_allPosts` and other list queries.
- [x] [Other] Confirm whether hard delete is acceptable or if compliance/moderation needs soft-delete state (deferred: product decision).

## Section 4 (Agent 4)

Assigned concepts: `Profiling`, `QuickCheckIns`, `Rating`, `Reporting`, `Reservations`, `Scheduling`
Background refs: [Concept Design Overview](../design/background/concept-design-overview.md), [Concept Specifications](../design/background/concept-specifications.md), [Implementing Concepts](../design/background/implementing-concepts.md), [Testing Concepts](../design/background/testing-concepts.md), [Concept State Details](../design/background/detailed/concept-state.md), [Concept Rubric](../design/background/detailed/concept-rubric.md)

## Profiling

- [x] [Delete lifecycle] Covered by `deleteProfile(user)`.
- [x] [Speed] Add unique index on `username`.
- [x] [Speed] Replace regex scan search with text index/search strategy. (deferred: text search changes semantics and backward-compat behavior)
- [x] [Other] Username races addressed by unique index + duplicate key handling.

## QuickCheckIns

- [x] [Delete lifecycle] Add `deleteByOwner(owner)` cleanup.
- [x] [Delete lifecycle] Add cascade option: `deleteCheckInsByMetric(metric)` for metric removal workflows.
- [x] [Speed] Add indexes `{ owner: 1, at: -1 }`, `{ owner: 1, metric: 1 }`, `{ metric: 1 }`, `{ owner: 1, name: 1 }`.
- [x] [Other] Align docs and implementation signatures (`defineMetric`, `deleteMetric`) to reduce integration confusion. (completed: QuickCheckIns spec and implementation contract now aligned)

## Rating

- [x] [Delete lifecycle] Add `deleteBySubject(subject)` cleanup.
- [x] [Delete lifecycle] Add `deleteByTarget(target)` cleanup.
- [x] [Speed] Add index `{ target: 1 }` for `_getAverageRating`.
- [x] [Other] Add explicit score bounds validation (1–5).

## Reporting

- [x] [Delete lifecycle] Add `deleteByReporter(reporter)` cleanup.
- [x] [Delete lifecycle] Add `deleteByTarget(target)` cleanup.
- [x] [Speed] Add indexes `{ status: 1, createdAt: 1 }`, `{ reporter: 1 }`, `{ target: 1 }`.
- [x] [Other] Add resolver/moderator identity metadata (`resolvedBy`) to `resolveReport` for auditability.

## Reservations

- [x] [Delete lifecycle] Add `deleteByCustomer(customer)` cleanup.
- [x] [Delete lifecycle] Add `deleteByTimeSlot(timeSlot)` cleanup when capacity slots are removed.
- [x] [Speed] Replace `_getAvailability` N+1 query pattern with a single aggregation pipeline. (deferred: previous aggregation approach had Date matching issues)
- [x] [Speed] Add indexes `{ timeSlot: 1, status: 1 }` and `{ customer: 1, timeSlot: 1 }`.
- [x] [Other] `book` capacity check and insert are not atomic; concurrent calls can overbook without transaction/locking. (deferred: needs transaction/locking support)

## Scheduling

- [x] [Delete lifecycle] Add `deleteByResource(resource)` cleanup.
- [x] [Delete lifecycle] Add `deleteByClient(client)` cleanup.
- [x] [Speed] Add indexes for overlap checks:
  - `{ resource: 1, start: 1, end: 1 }` (availability)
  - `{ resource: 1, status: 1, start: 1, end: 1 }` (appointments)
  - `{ client: 1, start: 1 }` (client history)
- [x] [Other] `book`/`reschedule` conflict checks are race-prone under concurrency without transactional guardrails. (deferred: needs transaction support)

## Section 5 (Agent 5)

Assigned concepts: `Scoring`, `Sessioning`, `Setting`, `Snapping`, `Storying`, `Tagging`, `Tasks`
Background refs: [Concept Design Overview](../design/background/concept-design-overview.md), [Concept Specifications](../design/background/concept-specifications.md), [Implementing Concepts](../design/background/implementing-concepts.md), [Testing Concepts](../design/background/testing-concepts.md), [Concept State Details](../design/background/detailed/concept-state.md), [Concept Rubric](../design/background/detailed/concept-rubric.md)

## Scoring

- [x] [Delete lifecycle] Add `deleteBySubject(subject)` cleanup.
- [x] [Delete lifecycle] Add `deleteByContext(context)` cleanup.
- [x] [Speed] Add index `{ context: 1, value: -1 }` for leaderboard queries (via `ensureIndexes()`).
- [x] [Other] `transfer` debit and credit are split operations; use transaction to avoid partial completion. (deferred: requires MongoDB replica set; non-transactional fallback remains)

## Sessioning

- [x] [Delete lifecycle] Add `deleteByUser(user)` to revoke all active/revoked sessions on account deletion.
- [x] [Speed] Add indexes `{ accessTokenJti: 1, status: 1 }`, `{ _id: 1, status: 1 }`, `{ user: 1 }` via `ensureIndexes()`.
- [x] [Speed] Add TTL index on `expiresAt` for automatic cleanup.
- [x] [Other] Remove misleading comments about index creation behavior and make indexing explicit in code/migrations.

## Setting

- [x] [Delete lifecycle] Not applicable for user/item cascade in current namespace model.
- [x] [Speed] Keyed lookups are already O(1) by `_id`.
- [x] [Other] Consider optional `deleteSetting(namespace)` for reset/rollback workflows.

## Snapping

- [x] [Delete lifecycle] Add `deleteBySender(sender)` cleanup.
- [x] [Delete lifecycle] Add `deleteByRecipient(recipient)` cleanup.
- [x] [Speed] Add indexes `{ recipient: 1, status: 1, sentAt: -1 }`, `{ sender: 1, sentAt: -1 }` via `ensureIndexes()`.
- [x] [Other] Concept says snaps are ephemeral, but opened snaps are retained unless explicitly deleted. (deferred: intentional design choice for history/audit)

## Storying

- [x] [Delete lifecycle] Add `deleteByAuthor(author)` cleanup.
- [x] [Speed] Add indexes `{ author: 1, expiresAt: 1, postedAt: -1 }` and TTL on `expiresAt` via `ensureIndexes()`.
- [x] [Other] Spec mismatch: `recordView` does not persist views, and `_getViews` query is missing. (Fixed: views collection, persist, _getViews, expire cascades.)
- [x] [Other] If/when views are persisted, `expire` should remove associated views too.

## Tagging

- [x] [Delete lifecycle] Add `deleteByOwner(owner)` cleanup.
- [x] [Delete lifecycle] Add `deleteByItem(item)` cleanup hook.
- [x] [Speed] Add indexes `{ owner: 1 }` and index support for `itemTags.tags` via `ensureIndexes()`.
- [x] [Speed] Replace `countDocuments` pre-checks with update-result-based logic where possible.
- [x] [Other] Dual-write updates (`tags` + `itemTags`) are not transactional and can drift under failures. (deferred: would need larger transactional refactor)

## Tasks

- [x] [Delete lifecycle] Add `deleteByCreator(creator)` cleanup.
- [x] [Delete lifecycle] Add `deleteByAssignee(assignee)` cleanup.
- [x] [Delete lifecycle] Add `deleteByItem(item)` cleanup.
- [x] [Delete lifecycle] Add `deleteByParent(parent)` or parent-delete cascade for subtasks.
- [x] [Speed] Add indexes `{ assignee: 1, createdAt: -1 }`, `{ creator: 1, createdAt: -1 }`, `{ item: 1, createdAt: -1 }`, `{ parent: 1, createdAt: -1 }` via `ensureIndexes()`.
- [x] [Other] Mutation methods do not include actor/authorization checks; any caller with `taskId` can update/delete. (authorization is handled by synchronizations/sync engine)
