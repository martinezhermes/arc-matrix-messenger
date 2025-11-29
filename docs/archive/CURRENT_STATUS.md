# ARC Matrix Messenger – Current Status (2025-11-28)

This document reflects the current TypeScript/Node.js Matrix bridge in this repo (no Go/WhatsApp runtime). It summarizes how the service runs today, what’s stored/published, and the immediate work we should pick up.

## Executive Summary
- Matrix client runs with E2EE (Olm/Megolm), SAS verification, and optional SSSS recovery-key import.
- Ingress publishes on `arc.loop.ingress` with routing key `ingress.messenger`; messages always publish, reactions publish by default (`PUBLISH_REACTIONS`), receipts publish when `PUBLISH_RECEIPTS=true`.
- Storage is Canonical Messenger Events in MongoDB `events`; contacts are still upserted. Legacy `messages/acknowledgements/reactions` collections are no longer written.
- Egress consumes `egress.messenger.#` (plus per-user messenger binding) and executes the full Matrix command set (`message`, `reply`, `react`, `edit`, `seen`, `typing`, `redact`, `fetch_messages`).
- Bootstrap backfill is effectively stubbed unless `CME_ENABLED=true`, where a basic Matrix scrollback writer populates CME only (no ingress publishing).
- Config validation now runs on startup; logging remains gated and suppresses noisy Olm wait lines.

## Architecture & Entry Points
- Runtime: `src/index.ts` (service), `src/bootstrap.ts` (bootstrap), `src/debug_fetch.ts` (targeted fetch).
- Core lifecycle + crypto + handlers: `src/matrix-app.ts` (Matrix client creation, SAS, key management, MQ wiring, startup/shutdown).
- Event ingress: `src/handlers/matrix-events.ts` (translate, CME insert, ingress publish).
- Egress commands: `src/handlers/matrix-actions.ts` (send/edit/reply/react/seen/typing/redact/fetch).
- Messaging: `src/messaging/egress.ts` (consumer), `src/messaging/publisher.ts`, `src/messaging/subscriber.ts`.
- Persistence: `src/handlers/database.ts` (Mongo + CME indexes, backfill checkpoints), `src/handlers/matrix-mongo-store.ts` (Matrix credentials), `src/store/persistent-store.ts` (sync token).
- Config + validation: `src/config.ts`, `src/config_validate.ts`.

## Configuration (current defaults)
- Core: `ARC_MESSAGE_BROKER_URL`, `ARC_DATABASE_URI`, `DB_NAME`, `ARC_USER`, `ARC_USER_ID`, `APP_SERVER_URL`.
- Matrix: `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, (`MATRIX_USER_PASSWORD` *or* `MATRIX_ACCESS_TOKEN` + `MATRIX_DEVICE_ID`), `MATRIX_CLIENT_DEVICE_NAME`, `MATRIX_CLIENT_SYNC_LIMIT` (default 250).
- Crypto/SSSS: optional `MATRIX_USER_RECOVERY_KEY_B64` (base64 32-byte or Element-style string).
- Logging: `LOG_LEVEL` (default `info`), `MATRIX_SDK_LOG_LEVEL` (default `error`).
- Phase 2 flags: `CME_ENABLED` (default false; gates bootstrap backfill), `PUBLISH_REACTIONS` (default true), `PUBLISH_RECEIPTS` (default false).
- Validation: enforced at startup (`config_validate.ts`) for broker/db/homeserver/user/credential inputs.

## Data Model & Persistence
- Canonical Messenger Events (`events` collection) are written for messages, reactions, and receipts. Unique indexes are ensured at startup; receipts have a dedicated unique index. TTL indexes are available (off by default).
- Contacts are upserted as Matrix IDs appear.
- Synthetic “received” receipts are stored for incoming messages (CME only) to mirror prior ACK semantics.
- Legacy `messages/acknowledgements/reactions` collections are not touched by the current handlers.

## Ingress: Matrix → ARC
- Handler: `src/handlers/matrix-events.ts`
- Flow: decrypt if possible → translate to legacy-like enriched message → insert CME → publish `ArcEvent` to `arc.loop.ingress` / `ingress.messenger`.
- Messages: always published; encrypted messages emit placeholders and are updated post-decryption (CME plus publish update when decrypted and sent by us).
- Reactions: stored as CME; published when `PUBLISH_REACTIONS=true` (default). Targets are enriched via in-room lookup and optional decrypt.
- Receipts: stored as CME; published only if `PUBLISH_RECEIPTS=true` (default is off). Synthetic “received” CME is written for inbound messages.
- IDs remain canonical Matrix IDs; DM recipient inference uses room membership/aliases.

## Egress: ARC → Matrix
- Consumer: `src/messaging/egress.ts`
- Bindings: `egress.messenger.#` plus per-user `egress.messenger.<matrixUserId with ':'→'.'>` to queue `messenger.egress.<safeWid>`. No `matrix`/`whatsapp` compat bindings remain.
- Commands (`matrix-actions.ts`): `message`, `reply`, `react`, `edit`, `seen`, `typing`, `redact`, `fetch_messages`; DMs are auto-created when targeting a user ID.

## E2EE, SAS, and Key Handling
- Crypto init with `@matrix-org/olm`; device display name is set where supported.
- SAS: accept inbound requests, bind once to SDK verifier, drive with `verify()` only; CLI confirmation via `y`. Matches `docs/MATRIX_SAS_VERIFICATION.md`.
- SSSS: service-mode no-op unless `MATRIX_USER_RECOVERY_KEY_B64` is provided, in which case secrets/backup restore are attempted.
- Key hygiene: proactive key requests on encrypted/failed events, periodic scans for undecryptables, periodic `ensureOlmSessionsForUsers`, one-time-key uploads, withheld-key logging.

## Modes
- Service (`npm start`): full MQ + Matrix sync.
- Bootstrap (`npm run bootstrap`): stub unless `CME_ENABLED=true`, where a simple scrollback writer populates CME and backfill checkpoints (no ingress publishing).
- Debug fetch (`src/debug_fetch.ts`): prints recent events from rooms containing a target user.

## Logging & Ops
- CLI logging gates via `LOG_LEVEL`; Matrix SDK logging via `MATRIX_SDK_LOG_LEVEL` plus suppression of “Waiting for Olm session” noise.
- Startup/shutdown close Matrix client, RabbitMQ publisher/subscriber, MongoDB client, and Mongoose credential store.

## Known Gaps / What To Do Next
1) **Testing is broken/outdated:** `tests/suites/mapping.test.ts` imports nonexistent exports and does not use the provided runner API. Replace with runnable tests that cover CME mapping, ingress publishing toggles, and egress command handlers; wire into `tests/run-tests.ts`.
2) **Bootstrap/backfill completeness:** Decide whether to enable the current CME-only scrollback (`CME_ENABLED=true`) and harden it (room selection, pagination controls, error/reporting). Otherwise, keep it off and note it explicitly.
3) **Ingress event shape clarity:** ArcEvents currently omit `origin/signature` that older docs mention; align the spec (docs + downstream expectations) or add the fields if still required.
4) **Config defaults review:** `PUBLISH_REACTIONS` now defaults true—confirm this is desired for downstreams; set explicit values in deployment manifests.
5) **Optional:** add runtime health/metrics (ingested/published counters, key-request counts) to aid ops once backfill/publishing behavior is tuned.

## Quick Start
- Install: `npm ci`
- Configure: copy `.env.template` → `.env`; set required vars.
- Run service: `npm start`
- Run bootstrap (CME backfill stub/gated): `npm run bootstrap`
- Run debug fetch: edit target in `src/debug_fetch.ts` then `npx vite-node src/debug_fetch.ts`

## Troubleshooting
- Too chatty logs: set `LOG_LEVEL=warn` and `MATRIX_SDK_LOG_LEVEL=error`.
- SAS stalls/cancels: follow the verifier-binding pattern and confirm with `y` when emojis appear; avoid creating local verifiers.
- Encryption gaps: provide `MATRIX_USER_RECOVERY_KEY_B64`, allow key gossip time; check withheld-key logs.
- Connectivity: verify Mongo/Rabbit envs; startup validation will fail fast when required config is missing.
