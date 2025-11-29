# Repository Guidelines

## Project Structure & Modules
- Source: `src/` (entries: `src/index.ts` service, `src/bootstrap.ts` bootstrap).
- Core: `src/matrix-app.ts` (lifecycle, Matrix client, crypto, MQ/DB), `src/handlers/*` (events, actions, DB), `src/messaging/*` (RabbitMQ), `src/types/*`.
- Tests: `tests/run-tests.ts` (mini runner) and `tests/suites/*.test.ts`.
- Docs: `docs/` (logging, SAS verification, phase notes). Config lives in `.env` (see `.env.template`).

## Build, Test, and Dev Commands
- Run service: `npm start` (vite-node executes `src/index.ts`).
- Bootstrap mode: `npm run bootstrap` (historical fetch stubs for Matrix).
- Tests: `npm test` (runs vite-node test runner; fails on any failed test).
- Format: `npm run prettier` (Prettier over `src/`).
- Note: No compile step required for local dev; vite-node executes TS directly. Node 18+ required.

## Coding Style & Conventions
- Language: TypeScript (strict). See `tsconfig.json` (`strict`, `noImplicitAny`, `noImplicitReturns`).
- Formatting: Prettier enforced. Tabs with width 4, semicolons, double quotes, `printWidth` 140.
- Files: `kebab-case` (e.g., `matrix-app.ts`, `matrix-events.ts`).
- Naming: `PascalCase` for classes/types; `camelCase` for variables/functions; UPPER_SNAKE_CASE for constants.
- Imports: prefer relative within feature folders; keep public types in `src/types/*`.

## Testing Guidelines
- Framework: lightweight runner via `vite-node`.
- Location: add suites under `tests/suites/*.test.ts`.
- Style: use the provided `test(name, fn)` from `tests/run-tests.ts`; throw on assertion failure.
- Scope: cover new handlers/adapters; keep tests fast and deterministic. Run `npm test` before PRs.

## Commit & Pull Request Guidelines
- Commits: write concise, imperative messages (e.g., "fix: handle reaction relation"). Group related changes; avoid noisy reformat-only commits.
- PRs: include a clear summary, linked issue(s), rationale, and any relevant logs or screenshots. Note config or migration steps if needed. Keep PRs small and focused.

## Security & Configuration Tips
- Secrets: never commit `.env` or credentials. Start from `.env.template`.
- Local stores: `.matrix-crypto/` and `.matrix-store/` contain keys/state; do not commit.
- Logging: tune `LOG_LEVEL` and `MATRIX_SDK_LOG_LEVEL` (see `docs/LOGGING.md`).
- Required services: MongoDB and RabbitMQ reachable via `ARC_DATABASE_URI` and `ARC_MESSAGE_BROKER_URL`.

