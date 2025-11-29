# Phase 2 Plan — ARC Messenger (Matrix)

Status: Planned
Date: 2025-09-01

This plan consolidates priorities for Phase 2. It incorporates the canonical event model from `docs/event_object_proposal.md`, the next steps identified in `docs/CURRENT_STATUS.md`, and removes legacy WhatsApp/Go artifacts. It also unifies ingress/egress naming to “messenger” (topics and queues) to be transport-agnostic.

## Objectives

- Adopt a unified Canonical Messenger Event (CME) storage model in `arcRecursiveCore.events` (Matrix first), with optional projections.
- Standardize ingress/egress routing keys and queues to `messenger` (no `whatsapp`/`matrix` terms in comms).
- Remove legacy WhatsApp code paths and archive Go/WhatsApp documentation.
- Finalize remaining operational items from Current Status (bootstrap backfill, optional publishing for reactions/receipts, config validation, testing).

## Scope & Workstreams

1) Canonical Event Model (CME) — Storage
- Add CME types: `src/types/messenger-event.ts` (as in `docs/event_object_proposal.md`).
- Writer: map Matrix SDK events to CME in `src/handlers/matrix-events.ts` via `toCanonicalEvent(...)` and insert into `arcRecursiveCore.events`.
- Indexes: create per proposal (unique per `{source,arcUserId,eventId}`; room/time; relations; receipts partial unique, etc.).
- Projections (optional, gated by `EVENTS_ENABLE_PROJECTIONS`): `message_state`, `reaction_index`, `read_index` driven by a simple change-stream projector.
- Keep existing ArcEvent ingress publishing unchanged (wire format remains), but storage migrates to CME (no dual-write to legacy `messages/acknowledgements/reactions`).

2) Ingress/Egress Naming — Unify to “messenger”
- Ingress publish: change routing key from `ingress.matrix` → `ingress.messenger`.
- Egress consumption: default binding set to `egress.messenger.#` only. Remove legacy compat bindings (`egress.matrix.#`, `egress.whatsapp.#`).
- Queue naming: ensure durable queues use `messenger` naming (e.g., `messenger.egress.<safeWid>`).
- Update logs/docs/config examples to reflect the unified naming.

3) Remove Legacy WhatsApp Code & Docs
- Remove obsolete modules from the codebase:
  - `src/app.ts`
  - `src/handlers/events.ts`
  - `src/handlers/actions.ts`
  - `src/handlers/mongo_store.ts`
  - Any lingering imports/usages of `whatsapp-web.js`
- Archive docs (Go/WhatsApp): move `docs/INSTALL.md` and `docs/README.md` into `docs/archive/`.
- Ensure TypeScript build and runtime contain no references to WhatsApp classes/types.

4) Bootstrap Backfill (Matrix)
- Implement real historical fetch:
  - For each joined room: paginate back with Matrix SDK, write as CME (handle encryption/decryption and key requests).
  - Rate-limited, resumable checkpoints; configurable scope (rooms, depth, per-room limits).
  - Align with CME storage and projections.

5) Optional Publishing for Reactions/Receipts
- Add `PUBLISH_REACTIONS=true|false` and `PUBLISH_RECEIPTS=true|false` (default false).
- If enabled, publish standardized ArcEvents for reactions/receipts in addition to CME storage.

6) Config Validation & Logging polish
- Add runtime config validation with clear errors for required vars (database, RabbitMQ, Matrix credentials).
- Keep SDK logs at `error` by default; maintain Olm wait-line suppression.

7) Testing & Observability
- Unit tests for `toCanonicalEvent` and egress action handlers.
- Integration tests (Matrix test room): message/reaction/receipt mapping, encrypted events, edit, redact.
- Observability: basic counters (events ingested per type); projector errors/lag.

## Deliverables

- CME types and writer path; indexes created.
- Ingress routing key uses `ingress.messenger`; egress binds `egress.messenger.#` only.
- Legacy WhatsApp code removed; docs archived under `docs/archive/`.
- Bootstrap backfill (Matrix) implemented and resumable.
- Optional reaction/receipt publishing flags.
- Config validation; docs updated.

## Migration & Rollout

1. Land CME types and writer (disabled behind `CME_ENABLED` if cautious), create indexes.
2. Flip service to write CME (and stop writing legacy collections). Keep ingress ArcEvent publishing unchanged.
3. Change bindings/keys to `messenger` and deploy consumers with updated bindings.
4. Remove WhatsApp code; archive Go/WhatsApp docs.
5. Enable/backfill in non-prod; validate counts and projections; then deploy to prod.

## Acceptance Criteria

- All incoming events stored as CME in `arcRecursiveCore.events`.
- Ingress publishes on `ingress.messenger` and egress consumes `egress.messenger.#`.
- No runtime/build references to WhatsApp types/APIs.
- Bootstrap fetch populates history as CME; decrypts where possible and queues key requests.
- Optional publishing for reactions/receipts works when enabled.

## Risks

- Encrypted backfill completeness (key availability): mitigate with periodic key requests and recovery key support.
- Consumer impact from routing key change: coordinate consumer bindings ahead of deployment.
- Projection correctness: validate with replay/synthetic test windows.

