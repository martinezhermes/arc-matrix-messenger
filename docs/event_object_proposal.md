# ARC Messenger Event Object & Storage Proposal

Status: Proposed

Authors: ARC Matrix Messenger Team (Riddles & Illusions)

Updated: 2025-09-01


## Executive Summary

We propose a unified, canonical event model and storage topology for messenger data (Matrix first, extensible to other messengers). The design consolidates all chat activity into a single append-only `events` collection inside `arcRecursiveCore`, with optional projections for hot queries (message state, reactions, reads). This replaces direct writes into separate `messages`, `acknowledgements`, `reactions` collections and resolves the current fragmentation while improving compatibility and downstream consumption across the ARC ecosystem.

Core ideas:
- Canonical event stream: one normalized `events` collection (in `arcRecursiveCore`) for all messenger events.
- Projections: derived collections for hot paths (message_state, reaction_index, read_index), built from change streams or in-process projectors.
- Keep everything in `arcRecursiveCore` to simplify alpha operations; revisit DB separation only if scale requires it later.


## Motivation & Current State

Current ingestion for Matrix persists to separate collections: `messages`, `acknowledgements`, `reactions`, plus a dormant `events`. Meanwhile, `arcRecursiveCore` holds system configuration, hosts, contacts, and a rich `requests` model used across ARC. A single MongoDB client serves multiple databases, with `arcRecursiveCore` as the hub for cross-ecosystem data. We will consolidate into a single `events` collection within `arcRecursiveCore`.

Issues with the current approach:
- Fragmented writes: downstream consumers must join across `messages`, `acknowledgements`, `reactions` to reconstruct a conversational timeline or a message’s final state.
- Tight coupling: collection shapes mirror legacy WhatsApp bridge assumptions and create friction for additional messengers and features (edits, redactions, membership changes).
- Operational pressure: chat event volume and retention compete with `arcRecursiveCore` responsibilities and indexes.

Goals of this proposal:
- Unify all messenger activity into a single canonical event model that’s messenger-agnostic.
- Preserve legacy compatibility while enabling richer features (edits, redactions, membership, typing, calls).
- Isolate high-volume chat storage for independent retention, index, and scaling policies.
- Provide projections that support hot queries with minimal recomputation.
- Keep contacts centralized in `arcRecursiveCore` as a cross-client source of truth.

Non-goals (for this phase):
- Rewriting downstream consumers immediately; migration will support dual-write and gradual adoption.
- Implementing full historical backfill within this document (we specify a plan and mapping, not full code).


## High-Level Design

1) Write all Matrix events to a canonical `events` collection in `arcRecursiveCore`.

2) Maintain optional projections (materialized views) per operational needs:
- `message_state`: one document per message with aggregated reactions, latest edit, redaction state, reader set/count.
- `reaction_index`: per message, per reaction key aggregation (emoji → count, userIds).
- `read_index`: per message, per user read timestamp.

3) Keep `arcRecursiveCore` for:
- `system`, `hosts`, `contacts`, `requests` (existing ARC core schema) and now `events` for messenger data.
- Optional cross-ecosystem `timeline` as a small, derived view for LLM context building (last N events with normalization).

4) No dual-write/migration in alpha:
- Adopt the canonical `events` model immediately.
- Legacy collections can be stopped; optional one-off data import is out-of-scope for alpha.


## Canonical Event Model

Terminology: A “Canonical Messenger Event” (CME) is the normalized representation of any messenger activity. It is designed to be messenger-agnostic and future-proof.

Types: `message | reaction | receipt | edit | redaction | typing | membership | call | unknown`.

Top-level fields:
- source: string — messenger source, e.g., "matrix".
- appId: string — stable messenger identity (from `APP_ID`) for multi-account isolation.
- eventId: string | null — messenger event ID when provided (Matrix message/reaction/redaction/edit have IDs; many receipts do not).
- roomId: string — canonical conversation identifier (Matrix roomId).
- senderId: string — canonical sender identifier (Matrix userId).
- timestamp: number — event timestamp (ms since epoch, from messenger when possible).
- type: string — one of the supported CME types.
- encrypted: boolean — whether payload was encrypted when received.
- crypto?: object — encryption metadata (see below).
- relatesTo?: object — relation to another event (`eventId`, optional `roomId`, `relationType`).
- content: object — type-specific content payload (see per-type sections).
- delivery?: object — legacy delivery metadata for compatibility (e.g., `ackValue`).
- raw?: object — minimal raw hints for troubleshooting (messenger eventType, error code, etc.). Not full payload.
- ingestedAt: number — server ingestion timestamp (ms since epoch).
- updatedAt: number — last updated timestamp (ms since epoch).

Crypto metadata (`crypto`):
- algorithm?: string (e.g., `m.megolm.v1.aes-sha2`).
- sessionId?: string — Megolm session ID when present.
- senderKey?: string — Olm sender key when available.
- verified?: boolean — whether the sending device/user is verified (if known at event time).

Relation (`relatesTo`):
- eventId: string — target event id.
- roomId?: string — target room (explicit when not equal to current event’s roomId).
- relationType: `annotation | replace | reference | redaction`.

Delivery (`delivery`):
- ackType?: `ACK_SENT | ACK_DELIVERED | ACK_READ` (semantic label).
- ackValue?: number — numeric legacy value (0..4), for backward compatibility with ARC.


### Type-specific `content` definitions

Message (type: `message`):
- body: { text: string, html?: string }
- msgtype?: string — Matrix msgtype when present (e.g., `m.text`, `m.notice`).
- media?: { kind: `image|video|audio|file`, mime?: string, size?: number, url?: string, info?: object, file?: object }
- mentions?: string[] — user IDs mentioned when known.
- language?: string — ISO code for text language when known.

Reaction (type: `reaction`):
- key: string — emoji or unicode symbol.
- aggregatable?: boolean — whether this reaction should aggregate.

Receipt (type: `receipt`):
- ack: `read | delivered | seen` — semantic label.
- scope?: `self | system | user` — who acknowledged.

Edit (type: `edit`):
- body: { text: string, html?: string }
- prevEventId: string — original message id (also in `relatesTo`).

Redaction (type: `redaction`):
- reason?: string

Typing (type: `typing`):
- state: boolean — true = typing started; false = typing stopped
- timeoutMs?: number

Membership (type: `membership`):
- membership: `join | leave | invite | ban | knock`
- targetId?: string — user affected when different from `senderId`.

Call (type: `call`):
- action: `invite | answer | hangup | candidates`
- details?: object — protocol details.


### Example Documents (Matrix)

Message:
```
{
  source: "matrix",
  appId: "messenger@ach9:endurance.network",
  eventId: "$NJibtC...",
  roomId: "!cPNqTYRMXIruSgiTwe:endurance.network",
  senderId: "@hermes:endurance.network",
  timestamp: 1756729493690,
  type: "message",
  encrypted: false,
  content: {
    body: { text: "this message will have an emoji reaction in the future" },
    msgtype: "m.text"
  }
}
```

Reaction:
```
{
  source: "matrix",
  appId: "messenger@ach9:endurance.network",
  eventId: "$2CKFyc...",
  roomId: "!cPNqTYRMXIruSgiTwe:endurance.network",
  senderId: "@hermes:endurance.network",
  timestamp: 1756729550642,
  type: "reaction",
  encrypted: false,
  content: { key: "🎉" },
  relatesTo: { eventId: "$NJibtC...", relationType: "annotation" }
}
```

Receipt (read):
```
{
  source: "matrix",
  appId: "messenger@ach9:endurance.network",
  roomId: "!cPNqTYRMXIruSgiTwe:endurance.network",
  senderId: "@hermes:endurance.network",
  timestamp: 1756729550642,
  type: "receipt",
  encrypted: false,
  content: { ack: "read" },
  relatesTo: { eventId: "$NJibtC..." },
  delivery: { ackType: "ACK_READ", ackValue: 4 }
}
```


## Storage Topology

Database:
- `arcRecursiveCore`: platform concerns (system, hosts, contacts, requests) and messenger `events`.

Collections in `arcRecursiveCore`:
- `events`: canonical append-only CME documents (Matrix first).
- Projections (optional):
  - `message_state`: per-message materialized state (latest body, edits, redaction, reactions summary, readers).
  - `reaction_index`: per-message aggregation by reaction key.
  - `read_index`: per-message per-user read timestamps.


## Index Strategy

Events:
- Unique event: `{ source: 1, appId: 1, eventId: 1 }` with `partialFilterExpression: { eventId: { $type: 'string' } }` (Matrix receipts may lack eventId).
- Room timeline: `{ appId: 1, roomId: 1, timestamp: 1, _id: 1 }` (range scans and stable ordering).
- Sender timeline: `{ appId: 1, senderId: 1, timestamp: 1 }`.
- Relations: `{ appId: 1, "relatesTo.eventId": 1, timestamp: 1 }`.
- Type-time: `{ appId: 1, type: 1, timestamp: 1 }` (sampling/ops).
- Receipt de-duplication (no eventId): unique index on `{ source: 1, appId: 1, type: 1, roomId: 1, senderId: 1, "relatesTo.eventId": 1 }` with partial filter `{ type: 'receipt' }`.

Projections:
- `message_state`: `{ appId: 1, roomId: 1, messageId: 1 }` unique.
- `reaction_index`: `{ appId: 1, messageId: 1, key: 1 }` unique.
- `read_index`: `{ appId: 1, messageId: 1, userId: 1 }` unique.

TTL (optional):
- Typing events: TTL 1 day.
- Receipts: TTL by policy (e.g., 90 days) if not needed long-term.


## Configuration

Environment variables (minimal alpha set):
- Uses existing `APP_DATABASE_URI` and `DB_NAME` (`arcRecursiveCore`).
- Optional: `EVENTS_ENABLE_PROJECTIONS` — comma-separated: `message_state,reaction_index,read_index`.
- Optional: `EVENTS_TTL_RECEIPTS_DAYS`, `EVENTS_TTL_TYPING_DAYS`.

No dual-write/storage-mode toggles are required in alpha; the service writes only to `events`.


## Integration Points (Code Changes)

1) Types and Models
- Add `src/types/messenger-event.ts` with the CME TypeScript interfaces.
- Add `src/models/events.ts` (Mongoose schemas for `events` and projections; index creation).

2) Writer
- In `src/handlers/matrix-events.ts`, map Matrix SDK events to CME via a pure function `toCanonicalEvent(...)`.
- Write path: canonical only — insert into `arcRecursiveCore.events` (and projections if enabled).

3) Projections
- Implement a small projector (in-process to start) that listens to `events` change stream and updates:
  - `message_state` on `message`, `edit`, `redaction`, `reaction`, and `receipt`.
  - `reaction_index` and `read_index` accordingly.
- Optionally gate projector by `EVENTS_ENABLE_PROJECTIONS`.

4) Contacts
- Continue upserting contacts into `arcRecursiveCore.contacts` to preserve cross-client identity management.

5) Ingress/Egress
- Ingress publishing (`arc.loop.ingress`) remains unchanged (standardized `ArcEvent`). The CME is a storage model, not a wire replacement.
- Egress consumption remains unchanged.


## Mapping (Matrix → CME)

Event types:
- `m.room.message` → `type: 'message'`, `content.body.text`, `msgtype`.
- `m.reaction` → `type: 'reaction'`, `content.key`, `relatesTo.eventId` from `m.relates_to.event_id`.
- `m.read`/receipts → `type: 'receipt'`, `content.ack='read'`, `delivery.ackType='ACK_READ'`, `ackValue=4`, `relatesTo.eventId` target.
- `m.room.redaction` → `type: 'redaction'`, `relatesTo.eventId` target.
- `m.room.member` → `type: 'membership'`, `content.membership`.
- Edits (`m.replace` relation) → `type: 'edit'`, `relatesTo.eventId` original, latest body in `content.body`.
- Typing (`m.typing` to-device/ephemeral) → `type: 'typing'` with `content.state` and optional `timeoutMs`.

Crypto metadata:
- Populate `encrypted`, `crypto.algorithm`, `crypto.sessionId`, `crypto.senderKey` when available.

Timestamps:
- Prefer Matrix event timestamp; fallback to ingestion time.

IDs:
- `eventId` present for message/reaction/redaction/edit; may be absent for receipts.


## Rollout (Alpha)

- Implement canonical writer and models; write exclusively to `arcRecursiveCore.events`.
- Optionally enable projections (`EVENTS_ENABLE_PROJECTIONS`) after initial validation.
- No dual-write and no migration required for alpha. Any prior test data may be archived or left in place without impact.


## Operational Considerations

Performance & Scale:
- Inserts: ensure write concern aligns with durability needs (e.g., `w:1` or `majority` by environment).
- Index builds: create indexes with background/hidden build strategy before enabling writers.
- Sharding (future): shard by `{ appId, roomId }` or `{ appId, timestamp }` depending on query patterns.

Retention:
- Apply TTL for ephemeral types (typing) and optionally for receipts.
- Messages, edits, redactions retained per policy; consider archival strategies (cold storage) beyond N months.

Backup/Restore:
- Independent backups for `arcMessengerMatrix` allow tighter RPO/RTO without impacting `arcRecursiveCore`.

Observability:
- Emit counters: events ingested per type, projector lag, projection errors, decryption failures.
- Log sampling for high-volume types; structured logs for projector writes.

Security & Privacy:
- Avoid storing full raw encrypted payloads; keep minimal `crypto` metadata and normalized `content` only.
- Respect redactions: on redaction event, update `message_state` to mark content removed; optionally compact historical `content` if required by policy.
- PII: treat user IDs and message bodies under ARC’s data protection policies; restrict access to `arcMessengerMatrix` by role.


## Risks & Mitigations

- Dual-write divergence: mitigate with idempotent mapping functions, unique indexes, periodic consistency checks (compare counts per type/time range).
- Schema drift (new Matrix events): default to `type: 'unknown'` with minimal `raw` fields; add mapping iteratively.
- Receipt de-dup complexity: use compound unique index on `{ source, appId, type, roomId, senderId, relatesTo.eventId }`.
- Projection correctness: validate by replaying a window of events and comparing to legacy views; add invariants (e.g., reaction counts ≥ 0, readers unique).


## Query Recipes

- Room timeline page:
  - Query `events` by `{ appId, roomId }` sorted by `timestamp`, `limit/skip`.

- Message with state:
  - Fetch base message from `events` where `{ type:'message', eventId }`.
  - Join with `message_state` by `{ appId, messageId: eventId }`.

- Reactions for a message:
  - Query `reaction_index` by `{ appId, messageId }` to get counts and user sets.

- Read status:
  - Query `read_index` by `{ appId, messageId }` for reader list and latest ts.


## Testing Strategy

- Unit tests for `toCanonicalEvent` mapping (cover message, reaction, receipt, edit, redaction, membership, typing; encrypted and unencrypted).
- Integration tests with Matrix test rooms to ensure relations are linked and decryption-recovery does not block ingestion.
- Projector tests: feed synthetic change stream and assert `message_state`, `reaction_index`, `read_index` updates.


## Rollout Plan

1) Land types/models and writer with `dual` default in non-prod.
2) Create indexes in `arcMessengerMatrix` while hidden; validate build.
3) Enable in staging; validate counts, query performance, projections.
4) Flip prod to `dual`; monitor for a week; run backfill for historical data.
5) Switch prod to `canonical`; deprecate legacy collections or repurpose them as projections if still needed.


## Open Questions

- Do we need an explicit `recipientId` for DMs, or is `roomId` sufficient across all messengers?
- Should we add message threading (Matrix `m.thread`) now or in a later phase? Proposed: represent as `relatesTo.relationType='reference'` with a `threadRootId` in `content`.
- What is the long-term retention for receipts and typing events in production?
- Should we store rich `msgtype`-specific fields (e.g., `m.location`, `m.poll`) now or lift them into a generic `attachments[]` structure?


## Appendix A: TypeScript Types (CME)

```ts
export type RelationType = 'annotation' | 'replace' | 'reference' | 'redaction';
export type EventType =
  | 'message'
  | 'reaction'
  | 'receipt'
  | 'edit'
  | 'redaction'
  | 'typing'
  | 'membership'
  | 'call'
  | 'unknown';

export interface EventRelation {
  eventId: string;
  roomId?: string;
  relationType: RelationType;
}

export interface CryptoMeta {
  algorithm?: string;
  sessionId?: string;
  senderKey?: string;
  verified?: boolean;
}

export interface DeliveryMeta {
  ackType?: 'ACK_SENT' | 'ACK_DELIVERED' | 'ACK_READ';
  ackValue?: number; // 0..4 legacy
}

export interface MessageBody { text: string; html?: string }

export interface MediaInfo {
  kind: 'image' | 'video' | 'audio' | 'file';
  mime?: string;
  size?: number;
  url?: string;
  info?: Record<string, unknown>;
  file?: Record<string, unknown>; // encrypted file info if applicable
}

export interface MessengerEventBase {
  source: string; // 'matrix'
  appId: string;
  eventId?: string | null;
  roomId: string;
  senderId: string;
  timestamp: number;
  type: EventType;
  encrypted: boolean;
  crypto?: CryptoMeta;
  relatesTo?: EventRelation;
  delivery?: DeliveryMeta;
  raw?: Record<string, unknown>;
  ingestedAt: number;
  updatedAt: number;
}

export interface MessageEvent extends MessengerEventBase {
  type: 'message';
  content: {
    body: MessageBody;
    msgtype?: string;
    media?: MediaInfo;
    mentions?: string[];
    language?: string;
  };
}

export interface ReactionEvent extends MessengerEventBase {
  type: 'reaction';
  content: { key: string; aggregatable?: boolean };
  relatesTo: EventRelation; // annotation → target message
}

export interface ReceiptEvent extends MessengerEventBase {
  type: 'receipt';
  content: { ack: 'read' | 'delivered' | 'seen'; scope?: 'self' | 'system' | 'user' };
  relatesTo: EventRelation;
}

export interface EditEvent extends MessengerEventBase {
  type: 'edit';
  content: { body: MessageBody; prevEventId: string };
  relatesTo: EventRelation; // replace → original message
}

export interface RedactionEvent extends MessengerEventBase {
  type: 'redaction';
  content: { reason?: string };
  relatesTo: EventRelation; // redaction → target event
}

export interface TypingEvent extends MessengerEventBase {
  type: 'typing';
  content: { state: boolean; timeoutMs?: number };
}

export interface MembershipEvent extends MessengerEventBase {
  type: 'membership';
  content: { membership: 'join' | 'leave' | 'invite' | 'ban' | 'knock'; targetId?: string };
}

export type MessengerEvent =
  | MessageEvent
  | ReactionEvent
  | ReceiptEvent
  | EditEvent
  | RedactionEvent
  | TypingEvent
  | MembershipEvent
  | MessengerEventBase; // for 'call' and 'unknown' with generic content
```


## Appendix B: Mongoose Models (Sketch)

```ts
// events
const EventsSchema = new Schema(
  {
    source: { type: String, index: true },
    appId: { type: String, index: true },
    eventId: { type: String, index: true, sparse: true },
    roomId: { type: String, index: true },
    senderId: { type: String, index: true },
    timestamp: { type: Number, index: true },
    type: { type: String, index: true },
    encrypted: { type: Boolean },
    crypto: {},
    relatesTo: {
      eventId: { type: String, index: true },
      roomId: String,
      relationType: String,
    },
    content: {},
    delivery: {},
    raw: {},
    ingestedAt: { type: Number, index: true },
    updatedAt: { type: Number, index: true },
  },
  { versionKey: false }
);

EventsSchema.index(
  { source: 1, appId: 1, eventId: 1 },
  { unique: true, partialFilterExpression: { eventId: { $type: 'string' } } }
);
EventsSchema.index({ appId: 1, roomId: 1, timestamp: 1, _id: 1 });
EventsSchema.index({ appId: 1, senderId: 1, timestamp: 1 });
EventsSchema.index({ appId: 1, 'relatesTo.eventId': 1, timestamp: 1 });
EventsSchema.index({ appId: 1, type: 1, timestamp: 1 });
EventsSchema.index(
  { source: 1, appId: 1, type: 1, roomId: 1, senderId: 1, 'relatesTo.eventId': 1 },
  { unique: true, partialFilterExpression: { type: 'receipt' } }
);
```


## Appendix C: Example Mapping (From Current Collections)

- messages → CME.message:
  - `id.id` → `eventId`
  - `to` → `roomId`
  - `author`/`from` → `senderId`
  - `timestamp` → `timestamp`
  - `body` → `content.body.text`
  - `type` → `content.msgtype` when applicable

- reactions → CME.reaction:
  - `id.id` → `eventId`
  - `msgId._serialized` → `relatesTo.eventId`
  - `reaction` → `content.key`
  - `senderId` → `senderId`
  - `timestamp` → `timestamp`

- acknowledgements → CME.receipt:
  - `messageId` → `relatesTo.eventId`
  - `ackValue` → `delivery.ackValue` and map to `content.ack` (4 → read)
  - `senderId` → `senderId`
  - `targetId` → `roomId`
  - `timestamp` → `timestamp`


## Conclusion

This proposal establishes a unified, scalable, and extensible foundation for messenger event storage in ARC. By centralizing all activity in a canonical `events` stream, isolating storage concerns to a dedicated database, and layering optional projections for hot queries, we enable consistent downstream consumption and efficient evolution of features. The dual-write migration ensures safety for existing consumers while we converge on the new model.
