# Phase 2 Checklist — ARC Messenger

Status: In progress
Owner: ARC Matrix Messenger Team
Updated: 2025-09-01

## Communication Unification
- [x] Switch ingress routing key to `ingress.messenger`
- [x] Restrict egress bindings to `egress.messenger.#`
- [x] Keep per-user binding `egress.messenger.<sanitizedUser>`
- [x] Remove legacy `egress.matrix.#` and `egress.whatsapp.#`

## Canonical Event Model (CME)
- [x] Add CME TypeScript types (`src/types/messenger-event.ts`)
- [x] Add config flags: `CME_ENABLED`, `PUBLISH_REACTIONS`, `PUBLISH_RECEIPTS`
- [x] Add database collection `events` and writer helper
- [x] Map Matrix events → CME (message, reaction, receipt; edit, redact later)
- [x] Gate legacy collection writes behind `!CME_ENABLED`
- [x] Keep ArcEvent publishing (messages) unchanged
- [x] Ensure `events` indexes are created (unique, timelines, relations, receipts)

## Bootstrap Backfill (Matrix)
- [x] Implement backfill pagination per joined room (CME, messages only; no ingress)
- [x] Add resume checkpoints and throttling controls
- [x] Decrypt as available; request missing keys during backfill

## Remove Legacy WhatsApp Code & Docs
- [x] Remove legacy modules: `src/app.ts`, `src/handlers/events.ts`, `src/handlers/actions.ts`, `src/handlers/mongo_store.ts`
- [x] Confirm build has no `whatsapp-web.js` references
- [x] Archive WhatsApp/Go docs under `docs/archive/`

## Optional Publishing (Reactions/Receipts)
- [x] Honor `PUBLISH_REACTIONS=true` to publish reactions
- [x] Honor `PUBLISH_RECEIPTS=true` to publish receipts

## Config & Logging
- [x] Add runtime config validation
- [x] Keep SDK logs at `error` by default; retain Olm wait suppression

## Tests & Observability
- [x] Unit tests for `toCanonicalEvent` mapping
- [ ] Integration tests with Matrix test room
- [ ] Minimal counters/logs for CME write/projector errors
