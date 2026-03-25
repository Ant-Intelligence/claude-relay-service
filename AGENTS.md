# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the Node.js relay service: `routes/` exposes HTTP endpoints, `services/` implements provider and account logic, `middleware/` holds request guards, and `utils/` contains shared helpers. Configuration lives in `config/`, CLI entry points in `cli/`, operational scripts in `scripts/`, and model pricing data in `resources/`. Tests are split into `tests/unit/` and `tests/integration/`. The admin UI is a separate Vue 3 app in `web/admin-spa/` with views, components, stores, and Vite config kept locally.

## Build, Test, and Development Commands
Use Node.js 18+.

- `npm run dev`: start the backend with `nodemon`.
- `npm start`: lint, then run `src/app.js`.
- `npm test`: run Jest unit tests.
- `npm run test:integration`: run integration tests under `tests/integration/`.
- `npm run lint:check` and `npm run format:check`: validate backend style.
- `npm run build:web`: build the admin SPA from `web/admin-spa/`.
- `make setup`: copy `config/config.example.js` and `.env.example`, then run setup.
- `make docker-up`: launch the local Docker stack.

## Coding Style & Naming Conventions
Backend code uses CommonJS, 2-space indentation, single quotes, no semicolons, and 100-character lines via Prettier. Run `npm run lint` before submitting; it applies ESLint fixes to `src/`, `cli/`, and `scripts/`. Prefer `camelCase` for variables/functions, `PascalCase` for Vue components, and descriptive service filenames such as `claudeRelayService.js` or `AccountBalanceScriptModal.vue`. Keep route handlers thin and move provider logic into `src/services/`.

## Testing Guidelines
Jest is the backend test framework; `supertest` is available for HTTP coverage. Name tests `*.test.js` and place them under `tests/unit/` or `tests/integration/` by scope. Add or update tests for any routing, billing, scheduling, or account-selection change. Use `npm test -- --coverage` when touching core relay logic or pricing code.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit style, for example `fix: ...`, `feat: ...`, and `revert: ...`. Keep commits focused and describe the user-visible behavior change. PRs should include a short summary, impacted areas, test evidence (`npm test`, `npm run test:integration`, UI build), linked issues/specs when relevant, and screenshots for `web/admin-spa/` changes.

## Security & Configuration Tips
Do not commit live secrets, `.env`, logs, or exported data. Start from `.env.example` and `config/config.example.js`. Review scripts that mutate Redis or API key data before running them in shared environments.
