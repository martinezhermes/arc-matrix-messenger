# ARC Matrix Messenger

ARC Matrix Messenger is a Node.js/TypeScript service that bridges a Matrix account to the ARC event loop using RabbitMQ and MongoDB. It ingests Matrix events (messages, reactions, receipts), persists/enriches them in MongoDB, and publishes standardized ARC ingress events to RabbitMQ. It also consumes ARC egress commands and executes them against Matrix (send, reply, react, edit, read receipts, fetch, typing, redact).

The project is the in-place successor to ARC’s original WhatsApp Web bridge: same architecture, topics, and database collections, now powered by Matrix. Phase 1 of the migration (core client replacement) is complete.


**Origin & Purpose**
- **Legacy origin:** A headless WhatsApp Web service that ran Puppeteer, upserted data to MongoDB, and published/consumed RabbitMQ topics. See `docs/README.md:1` for the prior architecture overview.
- **Migration goal:** Replace WhatsApp with Matrix as a drop-in, preserving data shape, messaging patterns, entry points, and operational modes. See `docs/MATRIX_MIGRATION_PROPOSAL.md:1`.
- **Current purpose:** Provide a production Matrix-based messenger with:
  - Ingress event publishing to `arc.loop.ingress` (rk `ingress.matrix`)
  - Egress command consumption from `arc.loop.egress` (rk `egress.matrix.#`, plus WhatsApp-compat bindings)
  - MongoDB upserts for `messages`, `contacts`, `acknowledgements`, `reactions`
  - E2EE support (Olm/Megolm), SAS device verification workflow, and optional SSSS recovery-key import


**Architecture**
- **Matrix SDK client:** Handles sync, crypto, device verification, and event stream.
- **Event pipeline:** Matrix events → enrichment → MongoDB upsert → RabbitMQ ingress publish.
- **Command pipeline:** RabbitMQ egress consume → action dispatch → Matrix client operations.
- **Modes:** Regular (service), Bootstrap (historical fetch stub for Matrix), Debug fetch (targeted inspection).

Key flows:
- **Ingress (Matrix → ARC):** Message arrives → translated to standardized `ArcEvent` → published to `arc.loop.ingress` with `ingress.matrix` routing key.
- **Egress (ARC → Matrix):** Command on `arc.loop.egress` with `egress.matrix.#` (and compat `egress.whatsapp.#`) → executed via Matrix actions.


**What’s Implemented Now**
- Matrix client initialization with crypto and device naming, using `matrix-js-sdk` and `@matrix-org/olm`.
- Stored credentials and lightweight sync state backed by MongoDB.
- Event handlers for messages, reactions, and read receipts (receipts/reactions persisted; publishing disabled for those by default).
- Egress consumer that supports message, reply, react, edit, seen, typing, redact, and fetch_messages.
- Logging gates: app logs via `LOG_LEVEL`, SDK logs via `MATRIX_SDK_LOG_LEVEL`.
- Optional SSSS recovery key import (`MATRIX_RECOVERY_KEY_B64`) to restore cross-signing/backup secrets non-interactively.


**Repo Structure (key files)**
- `src/matrix-app.ts:108`: Core app lifecycle (DB/RabbitMQ, Matrix client, crypto, handlers, SAS verification, startup/shutdown).
- `src/index.ts:1`: Regular mode entry (service).
- `src/bootstrap.ts:1`: Bootstrap entry (historical fetch mode; Matrix path stubs full backfill).
- `src/debug_fetch.ts:1`: Debug fetch entry (targeted user/room inspection).
- `src/handlers/matrix-events.ts:1`: Event translation, Mongo upserts, and ingress publishing.
- `src/handlers/matrix-actions.ts:1`: Egress actions (send, reply, react, edit, read receipts, typing, redact, fetch).
- `src/messaging/egress.ts:1`: Egress consumer bindings and dispatch.
- `src/handlers/database.ts:1`: Mongo client, collections, and upsert helpers.
- `src/config.ts:1`: Configuration surface and env mapping.
- `docs/LOGGING.md:1`: Logging model and recommended verbosity.
- `docs/MATRIX_SAS_VERIFICATION.md:1`: Stable SAS verification pattern and recovery-key notes.
- `docs/PHASE1_COMPLETION.md:1`: Phase 1 status (complete) and file map.


**Data Model & Compatibility**
- Collections: `messages`, `contacts`, `acknowledgements`, `reactions` (same names as before).
- Message documents keep the prior shape: `id.id` is the Matrix event ID; `from`, `to`, `author`, `timestamp`, `type`, `body`, and `serialId` are populated from Matrix.
- Contact documents use canonical Matrix IDs (e.g., `@user:server`), not synthetic WhatsApp JIDs.
- Ingress `ArcEvent` format is retained; `source`/`origin` values reflect Matrix.


**RabbitMQ Topics**
- Ingress publish: exchange `arc.loop.ingress`, rk `ingress.matrix`.
- Egress consume: exchange `arc.loop.egress`, rk `egress.matrix.#`.
- Compatibility consumes are also bound:
  - `egress.whatsapp.#` (legacy producers keep working)
  - `egress.<matrixUserId with ':' replaced by '.'>` for per-user routing


**Getting Started**
- Prerequisites:
  - Node.js 18+
  - MongoDB (URI reachable by the app)
  - RabbitMQ (reachable AMQP URL)
  - A Matrix account (user ID and password or access token + device ID)
- Install:
  - `npm ci`
- Configure:
  - Copy `.env.template` to `.env` and set required values (see below).
- Run (regular mode):
  - `npm start`
- Run (bootstrap mode):
  - `npm run bootstrap`
- Run (debug fetch):
  - Edit `src/debug_fetch.ts:6` target user, then `npx vite-node src/debug_fetch.ts`
- Docker (optional):
  - Use `docker-compose.yml` with an image built to include your `.env` setup.

Note: `docs/INSTALL.md` contains a legacy Go build path; the current implementation is Node.js/TypeScript and runs via the scripts above.


**Configuration**
Set via environment or `.env`:
- Core:
  - `APP_MESSAGE_BROKER_URL`: AMQP URL for RabbitMQ
  - `APP_DATABASE_URI`: MongoDB connection string (including DB name)
  - `DB_NAME`: Logical DB name used by the app
  - `APP_USER`: Friendly username (used in prefixes/signatures)
  - `APP_ID`: Stable instance identifier
- Matrix:
  - `MATRIX_HOMESERVER`: e.g., `https://matrix.org`
  - `MATRIX_USER_ID`: full Matrix ID, e.g., `@user:server`
  - `MATRIX_PASSWORD`: for first login; or use `MATRIX_ACCESS_TOKEN` + `MATRIX_DEVICE_ID`
  - `MATRIX_DEVICE_NAME`: display name for this device
  - `MATRIX_RECOVERY_KEY_B64` (optional): 32-byte base64 or Element-style recovery key string to enable SSSS import
  - `MATRIX_INITIAL_SYNC_LIMIT` (optional): cap initial sync events (default 250)
- Logging:
  - `LOG_LEVEL`: app logs `silent|error|warn|info|debug` (default `info`)
  - `MATRIX_SDK_LOG_LEVEL`: SDK logs `silent|error|warn|info|debug` (default `error`)
- Signatures/compat (optional):
  - `WID`, `COLLECTION_NAME_PREFIX`, `PRIMARY_DB_MESSAGES`, `PRIMARY_DB_ACKS`, `AUTH_DB`, `MONGO_CLUSTER`


**E2EE & SAS Verification**
- The app supports encrypted rooms with Olm/Megolm. On first secure use, you may need to verify the device via SAS.
- Stable pattern: do not create local verifiers; accept inbound requests, bind to the SDK-provided verifier, and drive via `verifier.verify()`.
  - See `docs/MATRIX_SAS_VERIFICATION.md:1` for the full incident write-up and the verified binding sequence.
- CLI: when emojis/decimals appear, type `y` then Enter to confirm; the app queues an early confirm if you type `y` before SAS is shown.
- Optional: set `MATRIX_RECOVERY_KEY_B64` to allow automatic import of cross-signing/backup secrets after verification.
- The app periodically scans for undecryptable events and requests missing keys; see `src/matrix-app.ts:520`.


**Logging**
- App logs (green/yellow/red/blue markers) are gated by `LOG_LEVEL`.
- Matrix SDK logs (HTTP/Crypto/Backup) are gated by `MATRIX_SDK_LOG_LEVEL`. The app additionally suppresses chatty Olm session wait lines.
- Recommended presets are in `docs/LOGGING.md:1`.


**Status & Roadmap**
- Phase 1 (core Matrix client replacement): complete. See `docs/PHASE1_COMPLETION.md:1`.
- Validation checklist and remaining polish items are tracked in `docs/PHASE1_VALIDATION_CHECKLIST.md:1`.
- Next focus areas:
  - Tighten TypeScript typings and adapters where legacy interfaces differ
  - Expand historical backfill for Matrix (bootstrap mode)
  - Optional publishing for ACKs/reactions if downstreams require it


**Troubleshooting**
- Excessive logs or missing entries: tune `LOG_LEVEL` and `MATRIX_SDK_LOG_LEVEL` (see `docs/LOGGING.md:1`).
- SAS cancels before emojis: follow the stable verifier binding pattern (`docs/MATRIX_SAS_VERIFICATION.md:1`).
- Mongo/Rabbit connectivity: verify URIs and credentials in `.env`.
- Encryption issues: provide a recovery key; ensure only one Element client competes in verification; let the app finish `verify()`.


**License**
MIT. See `package.json:1`.
