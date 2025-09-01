# ARC Matrix Messenger – Current Status (2025-09-01)

This document captures the current, implemented state of ARC Matrix Messenger, covering runtime behavior, data flows, integrations, and known gaps. It reflects the present TypeScript/Node.js implementation (matrix-js-sdk), not the legacy Go or WhatsApp code path.


## Executive Summary

- Matrix client is live with E2EE support (Olm/Megolm), SAS verification, and optional SSSS-based secret import.
- Ingress pipeline (Matrix → ARC): messages are translated, persisted in MongoDB, and published to RabbitMQ (`arc.loop.ingress`, routing key `ingress.matrix`).
- Reactions and receipts are translated and persisted; publishing for those is disabled (by design) unless required downstream.
- Egress pipeline (ARC → Matrix): comprehensive command set executed against Matrix (`message`, `reply`, `react`, `edit`, `seen`, `typing`, `redact`, `fetch_messages`), with multiple compatibility bindings (`egress.messenger.#`, `egress.matrix.#`, `egress.whatsapp.#`, and per-user patterns).
- Bootstrap mode exists but Matrix backfill is intentionally stubbed for now (no historical fetch); Debug mode inspects targeted rooms/users.
- Logging is gated and tunable, with sdk noise suppression for common Olm wait logs.
- Legacy WhatsApp code remains in-tree for reference; the live entry points use the Matrix app.


## Architecture

- Matrix SDK client: crypto, sync, device verification, and to-device key traffic
  - Initialization, crypto, SAS verification, key backup import: `src/matrix-app.ts` (see: 244–486, 756–915)
- Event pipeline: Matrix events → enrichment → MongoDB upserts → RabbitMQ ingress publish
  - Matrix → ARC translation and upserts: `src/handlers/matrix-events.ts`
  - Publish ingress topic: `ingress.matrix` via `arc.loop.ingress`
- Command pipeline: RabbitMQ egress consume → Matrix actions
  - Egress consumer and bindings: `src/messaging/egress.ts`
  - Matrix actions: `src/handlers/matrix-actions.ts`
- Data access: `src/handlers/database.ts` (MongoDB driver); Matrix credential/sync persistence: `src/handlers/matrix-mongo-store.ts`
- Modes: Regular (`src/index.ts`), Bootstrap (`src/bootstrap.ts`), Debug fetch (`src/debug_fetch.ts`)


## Entry Points & Modes

- Regular service: `src/index.ts:1`
  - Starts MatrixMessengerApp; connects DB + Rabbit; starts Matrix sync.
- Bootstrap mode: `src/bootstrap.ts:1`
  - Uses MatrixMessengerApp in bootstrap mode; Matrix backfill is currently a stub (see below).
- Debug fetch: `src/debug_fetch.ts:1`
  - Looks up rooms containing a target user and prints the last few messages from the live timeline.


## Configuration

Environment via `.env` → `src/config.ts:1`:
- Core
  - `APP_MESSAGE_BROKER_URL`, `APP_DATABASE_URI`, `DB_NAME`, `APP_USER`, `APP_ID`
  - Optional compat/signature knobs: `WID`, `COLLECTION_NAME_PREFIX`, `PRIMARY_DB_MESSAGES`, `PRIMARY_DB_ACKS`, `AUTH_DB`, `MONGO_CLUSTER`
- Matrix
  - `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_PASSWORD` (first login) or `MATRIX_ACCESS_TOKEN` + `MATRIX_DEVICE_ID`
  - `MATRIX_DEVICE_NAME` (display name for device)
  - `MATRIX_RECOVERY_KEY_B64` (optional 32-byte base64 or Element-style recovery key string for SSSS import)
  - `MATRIX_INITIAL_SYNC_LIMIT` (default 250)
- Logging
  - `LOG_LEVEL` gates app CLI logs: `silent|error|warn|info|debug`
  - `MATRIX_SDK_LOG_LEVEL` gates SDK logs: `silent|error|warn|info|debug`

Notes:
- SDK logger noise filter suppresses repetitive Olm wait logs. See `src/matrix-app.ts:1`.
- Persistent stores:
  - Crypto store: LocalStorage-backed at `.matrix-crypto`
  - Sync token store: `src/store/persistent-store.ts` with LocalStorage `.matrix-store` (token-only persistence)
  - Matrix credentials (accessToken/deviceId) stored in MongoDB: `src/handlers/matrix-mongo-store.ts`


## Logging

- App CLI: `src/cli/ui.ts:1`
  - `print` (info), `printLog` (debug), `printError` (error), `printWarning` (warn)
  - Controlled by `LOG_LEVEL` (default `info`)
- Matrix SDK: `MATRIX_SDK_LOG_LEVEL` (default `error`) and an additional filter to drop “Waiting for Olm session” chatter.
- Recommended presets in `docs/LOGGING.md:1`.


## Data Model & Persistence

- Collections (MongoDB): `messages`, `contacts`, `acknowledgements`, `reactions`
  - Shapes align with legacy WhatsApp collections, with canonical Matrix IDs (no synthetic JID transforms)
- Database adapter: `src/handlers/database.ts:1`
  - Upserts for messages, contacts, reactions, acknowledgements using the Node.js `mongodb` driver
  - Structured logging of upserts, minimal when no changes occur
- Matrix credentials/sync (service-only metadata): `src/handlers/matrix-mongo-store.ts:1`
  - Stores accessToken+deviceId (for future sessions)
  - Lightweight sync-state support (not currently wired to resuming SDK state beyond token persistence)


## Ingress: Matrix → ARC

- Handlers: `src/handlers/matrix-events.ts:1`
  - Messages
    - Timeline (cleartext) → translate → upsert `messages` → publish `ArcEvent` to ingress
    - Encrypted events: requests keys, defers until decrypted when possible, then upsert/publish decrypted update
  - Reactions (`m.reaction`)
    - Translate and upsert `reactions`, enrich target message in `messages`
    - Publishing of reactions is disabled by default (commented intent present)
  - Receipts (`m.receipt`/`m.read`)
    - Translate to ACK_READ upserts in `acknowledgements` and optionally upsert the related message (body must not be placeholder)
    - Publishing receipts is disabled

- Translation rules
  - IDs: canonical Matrix IDs are stored as-is (e.g., `@user:server`, `!room:server`) – no legacy JID conversion
  - Message type mapping: `m.text → chat`, `m.image → image`, `m.video → video`, etc.
  - DM recipient: for 1:1 rooms, `to` becomes the other user (WhatsApp-like shape); for groups, `to` is the room id

- Publishing: `src/handlers/matrix-events.ts:83`
  - Exchange: `arc.loop.ingress`
  - Routing key: `ingress.matrix`
  - ArcEvent fields:
    - `origin`: `messenger@<sender>`
    - `source`: `messenger`
    - `signature`: `mongo://<cluster>/<db>#messages:<sessionId>?authDb=<authDb>` (or `reactions`)
    - `sender`, `author`, `recipient`, `content`, `appId`, `timestamp`, `topic:"_"`, `v:1`, `ackPolicy:"at-least-once"`, `ttlMs:600000`

  Note: `origin/source` intentionally use “messenger” to keep a generic label; routing for ingress still uses `ingress.matrix`.


## Egress: ARC → Matrix

- Consumer: `src/messaging/egress.ts:1`
  - Primary binding: `egress.messenger.#`
  - Compatibility bindings: `egress.matrix.#`, `egress.whatsapp.#`
  - Per-user bindings: `egress.<matrixUserId with ':' replaced by '.'>` and `egress.messenger.<...>`
  - Queue: durable per-instance queue named `messenger.egress.<safeWid>`
  - Message shape: expects `{ action: { action_type, ... } }` and maps to internal command

- Supported commands: `src/handlers/matrix-actions.ts:1`
  - `message`: send text to `!room` or ensure/join/create DM with `@user`
  - `reply`: reply to an event by id
  - `react`: `m.reaction` annotation on event id
  - `edit`: `m.replace` edit for author-self events
  - `seen`: send read receipt to latest event in the room
  - `typing`: send typing on/off for a room
  - `redact`: redact by event id (optional `reason`)
  - `fetch_messages`: scrollback for room or DM


## E2EE & SAS Verification

- Crypto initialization and device configuration: `src/matrix-app.ts:420`
  - Sets device display name where supported, initializes crypto, uploads one-time/device keys
- SAS verification (stable pattern): `src/matrix-app.ts:756`
  - Accept inbound requests once; bind exactly once to SDK-provided verifier
  - Drive progression with `verifier.verify()` only
  - Handles `show_sas`, `done`, `cancel`, and correlates to-device `start` using request `transaction_id`
  - CLI confirms via stdin by typing `y` (supports early queued confirm)
  - Mirrors the pattern described in `docs/MATRIX_SAS_VERIFICATION.md`
- Secret storage (SSSS) policy: `src/matrix-app.ts:328`
  - Default service mode: no SSSS keys provided → avoids secret prompts and post-SAS flips
  - Optional import: set `MATRIX_RECOVERY_KEY_B64` (32-byte base64 or Element-style string) → SDK imports cross-signing/backup secrets
- Key management hardening:
  - Proactive requests for missing Megolm sessions on encrypted/undecryptable events
  - Periodic scans of live timelines for undecryptable events (minute cadence)
  - Periodic ensure Olm sessions for joined users + self; periodic one-time-key uploads
  - Logs withheld key events (`m.room_key.withheld`) for visibility


## Bootstrap & Debug Fetch

- Bootstrap mode: `src/bootstrap.ts:1`, `src/matrix-app.ts:492`
  - Matrix backfill is stubbed (no-op). It logs a message and returns progress with zeros
  - Rationale: staged approach; backfill to be implemented in a future phase with Matrix-specific APIs
- Debug fetch: `src/debug_fetch.ts:1`, `src/matrix-app.ts:174`
  - Locates rooms containing a given `@user` and prints recent messages from the first matched room


## Operational Notes

- Startup lifecycle: `src/index.ts:1`
  - Initializes DB (MongoDB driver for primary ARC DB + Mongoose for Matrix credential store), connects Rabbit, creates Matrix client, attaches handlers, starts sync
- Shutdown: `src/index.ts:11` + `src/matrix-app.ts:981`
  - Stops client, closes Rabbit (publisher/subscriber), disconnects ARC DB and Mongoose
- Networking/IO
  - RabbitMQ: `src/messaging/publisher.ts`, `src/messaging/subscriber.ts`
  - MongoDB: `src/handlers/database.ts` (primary ARC DB) and `src/handlers/matrix-mongo-store.ts` (credentials/sync)


## Compatibility & Legacy

- Legacy WhatsApp components remain in-tree for reference:
  - Core app: `src/app.ts`
  - Event handler: `src/handlers/events.ts`
  - Actions: `src/handlers/actions.ts`
  - Session store: `src/handlers/mongo_store.ts`
  - Fetcher: `src/handlers/fetcher.ts` (Matrix build keeps a stub to satisfy types)
- Install doc `docs/INSTALL.md` describes a Go path and legacy workflows; for the current Node.js Matrix implementation, use `npm` scripts and entries described in this doc, not the Go build.


## Current Behavior Summary

- Published ingress events (messages only):
  - Exchange: `arc.loop.ingress`
  - Routing key: `ingress.matrix`
  - ArcEvent fields include `origin/messenger@…`, `source/messenger`, `signature` for messages, `appId` based on `WID` or `APP_ID`
- Persisted (MongoDB):
  - `messages`: all Matrix messages (incoming and our own), with post-decryption updates when available
  - `contacts`: on-demand upserts as users appear in events
  - `acknowledgements`: read receipts mapped to ACK_READ
  - `reactions`: stored with target message enrichment
- Not published by default: reactions and acknowledgements
- Egress commands: full matrix action coverage with compatibility bindings


## Known Gaps / Next Steps

- Historical backfill (bootstrap): Matrix-specific backfill is not yet implemented; the current bootstrap mode is a no-op stub.
- Optional publishing:
  - Enable configurable publishing for reactions and acknowledgements if downstreams require them
- Typings and adapters:
  - Tighten types and unify legacy interfaces where comments still reference WhatsApp types
- Config validation:
  - Add runtime validation to fail-fast on missing/invalid envs
- Testing:
  - Add unit/integration tests focused on Matrix translations, key handling, and egress command execution

---

## Phase 2 Direction (Planned)

Phase 2 consolidates storage and unifies communications naming. See `docs/PHASE2_PLAN.md` for full details. Highlights:

- Canonical Event Model (CME): write all messenger activity to `arcRecursiveCore.events` (Matrix first), with optional projections (`message_state`, `reaction_index`, `read_index`). Ingress ArcEvent publishing remains.
- Unify topics/queues to “messenger”: change ingress rk to `ingress.messenger`; egress consumes `egress.messenger.#` (remove `matrix`/`whatsapp` compat bindings).
- Remove legacy WhatsApp code and archive Go/WhatsApp docs.
- Implement real Matrix backfill in bootstrap mode; add config-gated publishing for reactions/receipts; add runtime config validation and tests.

Documentation updates:
- Legacy Go/WhatsApp docs have been archived to `docs/archive/`. Use this document and `docs/PHASE2_PLAN.md` moving forward.


## Quick Start (current Node/TypeScript app)

- Install: `npm ci`
- Configure: set `.env` (see repo `.env.template` for fields)
- Run service: `npm start`
- Run bootstrap (Matrix stub): `npm run bootstrap`
- Run debug fetch: edit `src/debug_fetch.ts:6`, then `npx vite-node src/debug_fetch.ts`


## Troubleshooting

- Excessive logs: set `LOG_LEVEL=warn` and `MATRIX_SDK_LOG_LEVEL=error` (see `docs/LOGGING.md:1`)
- SAS cancels early: ensure the app is the acceptor only, don’t create local verifiers, and confirm via CLI when emojis appear (see `docs/MATRIX_SAS_VERIFICATION.md:1`)
- Encryption issues: provide `MATRIX_RECOVERY_KEY_B64` to allow SSSS import; allow time for key gossip; app periodically scans and re-requests keys
- Mongo/Rabbit connectivity: verify URIs and credentials in `.env`


## License

MIT (see `package.json`).
