# ARC Event Specification (v1)

## Overview

The `ArcEvent` interface defines a unified, messenger-centric event envelope for the ARC (Arc Recursive Core) system, specifically designed to align with `MessengerEventBase` for chat applications. This structure facilitates the ingestion, storage, publishing, and processing of events from various platforms (e.g., Matrix, WhatsApp) into a consistent format. It emphasizes core chat metadata (e.g., roomId, senderId, timestamp in milliseconds) while incorporating optional tracing, encryption details, and delivery guarantees for robustness in distributed systems.

Key design principles:
- **Messenger-Centric**: Prioritizes fields like `roomId`, `senderId`, and `relatesTo` for threading/reactions, making it suitable for real-time messaging.
- **Backwards Compatibility**: Includes legacy fields in `content` (e.g., `serialId`, `event_ts` in seconds) to support existing WhatsApp-like integrations without breaking changes.
- **Extensibility**: Uses `unknown` for `content` with typed subtypes (e.g., `MessageBody`), and optional tracing fields for observability.
- **Platform Agnostic**: Derives `platform` from `source` (e.g., "matrix" from source="messenger"), with `raw` for SDK-specific data.
- **Persistence-Ready**: `signature` references database locations via `SigRef` for efficient querying/updates.
- **E2EE Support**: Flags via `encrypted` and details in `crypto`.
- **Delivery Semantics**: `ackPolicy` and `ttlMs` ensure reliable processing in RabbitMQ-based publishing.

This spec is for version `v=1`, with `timestamp` in ms epoch for precision (vs. legacy seconds). Events are published to RabbitMQ exchange "arc.loop.ingress" with routing key "ingress.messenger".

## Interface Definition

The core `ArcEvent` interface and supporting types are defined in `src/types/arc-event.ts`:

```typescript
export type SigRef =
  | string // "mongo://cluster/primaryDb#collection:sessionId?authDb=remoteAuth"
  | {
      scheme: "mongo";
      cluster?: string; // e.g. "arcRecursiveCore"
      database: string; // "ach9WhatsappHistory" | "ach9WhatsappSession"
      collection: string; // "messages" | "reactions" | "acks"
      sessionId: string; // "33781234567@c.us"
      authDatabase?: string; // "remoteAuth"
    };

export interface EventRelation {
  eventId?: string;
  roomId?: string;
  relationType?: string; // annotation | replace | redaction | reference
}

export interface MessageBody {
  text?: string;
  html?: string;
  formatted?: boolean;
}

export interface MediaInfo {
  url?: string;
  mime?: string;
  size?: number;
  name?: string;
}

export interface CryptoInfo {
  algorithm?: string;
  sessionId?: string;
  senderKey?: string;
}

export interface ArcEvent {
  // Messenger-focused core (like MessengerEventBase)
  source: string; // REQUIRED: e.g., "matrix" or "whatsapp"
  arcUserId: string; // Stable app/host ID (e.g., "@ach9:endurance.network")
  eventId?: string | null; // Unique event ID (e.g., Matrix $event:server)
  roomId?: string; // Chat/room ID (e.g., "!room:server" for Matrix, group@g.us for WA)
  senderId?: string; // Sender ID (e.g., "@user:server" for Matrix; aligns with sender)
  timestamp: number; // ms epoch (higher precision)
  type: string; // e.g., "message" | "reaction" | "receipt"
  encrypted?: boolean; // E2EE flag
  crypto?: CryptoInfo; // E2EE details
  relatesTo?: EventRelation; // Threading/relations (e.g., for reactions)
  content: unknown; // Payload (typed in subtypes)
  delivery?: any; // Delivery status (e.g., ack/read)
  raw?: any; // Raw SDK event for debugging
  ingestedAt?: number; // Ingestion timestamp (ms)
  updatedAt?: number; // Last update timestamp (ms)

  origin?: string; // e.g., "matrix:@user:server" (derive from source + senderId if missing)
  signature?: SigRef; // DB reference (optional; required for persistence)

  // Tracing/Envelope (merged)
  v?: 1; // Schema version
  traceId?: string;
  causationId?: string;
  correlationId?: string;
  ackPolicy?: "at-least-once"; // Delivery guarantee
  ttlMs?: number; // Time-to-live (ms)
  platform?: string; // e.g., "matrix" (derive from source)
}
```

## Field Explanations

| Field          | Type                  | Required | Description                                                                 | Example Value                                                                 |
|----------------|-----------------------|----------|-----------------------------------------------------------------------------|-------------------------------------------------------------------------------|
| source        | string                | Yes     | Origin platform/system (e.g., "messenger" for unified chat events).         | "messenger"                                                                   |
| arcUserId     | string                | Yes     | Stable identifier for the app/host user (e.g., Matrix user ID). Replaces earlier `appId` for clarity. | "@ach9:endurance.network"                                                     |
| eventId       | string \| null        | No      | Unique event identifier (e.g., Matrix event ID starting with "$").          | "$d_jo-9t21KVR6CqnTJayWSJTMCA3dBXDdxN6d1JVxQA:endurance.network"              |
| roomId        | string                | No      | Chat or room identifier (always the actual room ID, e.g., "!room:server" for Matrix DMs/groups). For DMs, use `recipientId` in legacy contexts if needed. | "!cPNqTYRMXIruSgiTwe:endurance.network"                                       |
| senderId      | string                | No      | Sender's user identifier.                                                   | "@hermes:endurance.network"                                                   |
| timestamp     | number                | Yes     | Event timestamp in milliseconds (Unix epoch) for high precision.            | 1757161324682                                                                 |
| type          | string                | Yes     | Event type (e.g., "message", "reaction", "receipt").                        | "message"                                                                     |
| encrypted     | boolean               | No      | Flag indicating if the event is end-to-end encrypted.                       | true (if m.room.encrypted or decryption failed)                                |
| crypto        | CryptoInfo            | No      | Encryption details (e.g., algorithm used).                                  | { algorithm: "m.megolm.v1.aes-sha2", sessionId: "session123" }                |
| relatesTo     | EventRelation         | No      | Relation to another event (e.g., for reactions: eventId of target message). | { eventId: "$target:server", relationType: "annotation" }                     |
| content       | unknown (typed)       | Yes     | Event payload. Typed based on `type` (see Subtypes section). Includes back-compat fields like `event_id`, `event_ts` (seconds). | { body: "new?", event_id: "$event:server", event_ts: 1757161324, id: { id: "$event:server", _serialized: "$event:server" }, serialId: "$event:server" } |
| delivery      | any                   | No      | Delivery status (e.g., for receipts: ack type).                             | { ack: "read" }                                                               |
| raw           | any                   | No      | Raw original event from SDK for debugging/rehydration.                      | Full MatrixEvent object                                                       |
| ingestedAt    | number                | No      | Timestamp (ms) when the event was ingested into the system.                 | 1757161325000                                                                 |
| updatedAt     | number                | No      | Timestamp (ms) of last update (e.g., after decryption).                     | 1757161326000                                                                 |
| origin        | string                | No      | Derived origin (e.g., "matrix:@user:server"). Auto-derived from source + senderId. | "matrix:@hermes:endurance.network"                                            |
| signature     | SigRef                | No      | Database reference for persistence (string URI or object). Required for upsert operations. | "mongo://arcRecursiveCore/ach9MatrixHistory#events:@ach9:endurance.network?authDb=remoteAuth" |
| v             | number                | No      | Schema version (always 1 for current).                                      | 1                                                                             |
| traceId       | string                | No      | Unique trace identifier for observability.                                  | "trace-abc123"                                                                |
| causationId   | string                | No      | ID of the causing event (for causality tracking).                           | "$causing-event:server"                                                       |
| correlationId | string                | No      | Correlation ID for request-response pairs.                                  | "corr-xyz789"                                                                 |
| ackPolicy     | string                | No      | Delivery acknowledgment policy (default "at-least-once").                   | "at-least-once"                                                               |
| ttlMs         | number                | No      | Time-to-live in milliseconds (default 600000 = 10 min).                     | 600000                                                                        |
| platform      | string                | No      | Platform source (derived from `source`, e.g., "matrix" for Matrix events).  | "matrix"                                                                      |

## Example Metadata

The provided example is a Matrix message event in a DM room, published via RabbitMQ. It demonstrates core fields, with `roomId` correctly set to the actual room ID (not user ID for DMs), `arcUserId` as the host user, and `content` including legacy back-compat:

```json
{
  "source": "messenger",
  "arcUserId": "@ach9:endurance.network",
  "eventId": "$d_jo-9t21KVR6CqnTJayWSJTMCA3dBXDdxN6d1JVxQA",
  "roomId": "!cPNqTYRMXIruSgiTwe:endurance.network",
  "senderId": "@hermes:endurance.network",
  "timestamp": 1757161324682,
  "type": "message",
  "content": {
    "body": "new?",
    "event_id": "$d_jo-9t21KVR6CqnTJayWSJTMCA3dBXDdxN6d1JVxQA",
    "event_ts": 1757161324,
    "id": {
      "id": "$d_jo-9t21KVR6CqnTJayWSJTMCA3dBXDdxN6d1JVxQA",
      "_serialized": "$d_jo-9t21KVR6CqnTJayWSJTMCA3dBXDdxN6d1JVxQA"
    },
    "serialId": "$d_jo-9t21KVR6CqnTJayWSJTMCA3dBXDdxN6d1JVxQA"
  },
  "platform": "matrix",
  "v": 1,
  "ackPolicy": "at-least-once",
  "ttlMs": 600000
}
```

**Annotations**:
- `source` and `platform`: Unified as "messenger"/"matrix" for Matrix integration.
- `arcUserId`: Host's Matrix user ID.
- `roomId`: Actual DM room ID (`!cPNq...`), not user ID (fixed from legacy override).
- `timestamp`: ms (1757161324682), with `event_ts` in seconds for legacy.
- `content`: Simple text body; includes back-compat `id`/`serialId` for WhatsApp-like serials.
- Missing optionals: No encryption (`encrypted=false` implied), no relations, no tracing (can be added for production).

## Subtypes and Payloads

`content` is `unknown` but typed based on `type`. Common subtypes:

- **Message (`type: "message"`)**: Uses `MessageBody` + media if applicable.
  ```typescript
  content: {
    body: MessageBody; // { text: "Hello", html: "<p>Hello</p>", formatted: true }
    msgtype?: string; // "m.text", "m.image"
    media?: MediaInfo; // { url: "mxc://server/mediaid", mime: "image/jpeg", size: 1024, name: "photo.jpg" }
    // Legacy back-compat
    event_id: string;
    event_ts: number; // seconds
    id: { id: string; _serialized: string };
    serialId: string;
  }
  ```

- **Reaction (`type: "reaction"`)**: Targets a message.
  ```typescript
  content: {
    body: string; // emoji or reaction text
    emoji: string; // e.g., "👍"
    targetMessageId: string;
    event_id: string;
    event_ts: number;
  }
  relatesTo: { eventId: string; relationType: "annotation" }
  ```

- **Receipt (`type: "receipt"`)**: Acknowledgment.
  ```typescript
  content: {
    ack: string; // "read" | "received"
    targetMessageId: string;
  }
  relatesTo: { eventId: string }
  ```

For media messages, include `media` in `content`; for encrypted, set `encrypted: true` and populate `crypto`.

## Usage in Matrix Handler

In `src/handlers/matrix-events.ts`, `ArcEvent` is built from Matrix SDK events via functions like `buildMessageEvent(EnrichedMessage)`:
- Maps `event.getId()` → `eventId`/`serialId`.
- `room.roomId` → `roomId` (always actual room ID, even for DMs).
- `event.getSender()` → `senderId`.
- `event.getTs()` → `timestamp` (ms).
- Content: Extracts `body` from decrypted event, adds legacy `event_id`/`event_ts`.
- Publishes via `publishEvent(arcEvent)` to RabbitMQ (exchange: "arc.loop.ingress", rk: "ingress.messenger").
- For DMs: `recipientId` in `EnrichedMessage` holds other user ID, but `roomId` remains room ID.
- Decryption: Handles `m.room.encrypted` with `decryptEventIfNeeded`, updates on "Event.decrypted".

Example flow: Incoming Matrix message → `translateMatrixEvent` (enrich) → `buildMessageEvent` (ArcEvent) → insert to MongoDB → publish.

## Differences from Legacy

- **No Top-Level Legacy Fields**: Removed `sender`/`author`/`recipient` (use `senderId`/`roomId`); legacy in `content` only.
- **Timestamps**: Always ms (`timestamp`); legacy `event_ts` seconds in `content`.
- **arcUserId vs. appId**: Clarified as host user ID (e.g., Matrix `@user:server`).
- **roomId**: Strictly room ID (e.g., `!room:server` for DMs/groups); no override to user ID.
- **Tracing Added**: Optional `traceId` etc., for better observability vs. flat legacy events.
- **E2EE Explicit**: `encrypted` flag + `crypto` details; legacy implied via raw content.
- **Relations**: Structured `relatesTo` for reactions/threads vs. ad-hoc legacy.

This ensures forward compatibility while supporting migration from WhatsApp legacy.

## Validation and Best Practices

- **Schema Enforcement**: Use `v: 1` to version; validate required fields (source, arcUserId, timestamp, type, content) before publishing. Throw on missing `timestamp`.
- **Derivations**: Auto-set `platform` from `source` (e.g., "matrix" if source="messenger" and Matrix context); derive `origin` as `${platform}:${senderId}`.
- **Error Handling**: In handlers, catch decryption failures (set `encrypted: true`, `body: "[encrypted]"`); log with `cli.printLog` for "Event complete metadata".
- **Persistence**: Always set `signature` for MongoDB upserts (use `signatureFor(db, collection)`); query by `eventId` + `roomId`.
- **Publishing**: Use "at-least-once" policy; set `ttlMs=600000` for short-lived events. Monitor RabbitMQ for dead-lettering.
- **Testing**: Unit tests in `tests/suites/mapping.test.ts` verify mappings (e.g., `expect(event.roomId).to.equal('!testRoom:server')`).
- **Security**: Sanitize `content.body` for HTML; validate `crypto.algorithm` against supported (e.g., "m.megolm.v1.aes-sha2").
- **Performance**: Avoid deep cloning `raw`; use ms timestamps to prevent precision loss in JSON serialization.

For updates, increment `v` and document in CHANGELOG. Contact maintainers for schema changes.



And finally this is the document as upserted raw event:
{
  "_id": {
    "$oid": "68bc300b6bfea0771a9c08aa"
  },
  "arcUserId": "@ach9:endurance.network",
  "eventId": "$md4klxO5TgHsCbuNe-EsIkwYW24BzdUlfpaT2cyhxU8",
  "source": "matrix",
  "content": {
    "body": {
      "text": "this is a test message"
    },
    "msgtype": "m.text"
  },
  "encrypted": false,
  "ingestedAt": 1757163531584,
  "ingestedAtDate": {
    "$date": "2025-09-06T12:58:51.584Z"
  },
  "roomId": "!cPNqTYRMXIruSgiTwe:endurance.network",
  "senderId": "@hermes:endurance.network",
  "timestamp": 1757163531499,
  "type": "message",
  "updatedAt": 1757163531584
}


I neeed you to update the canonical event handling for the expected type now.
◇  → Publish ingress: ex=arc.loop.ingress rk=ingress.messenger type=message arcUserId=@ach9:endurance.network origin=undefined signature=undefined

notice we don't send origin nor signature anymore