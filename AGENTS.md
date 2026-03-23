# Repository Guidelines

## Project Structure & Module Organization
`src/index.ts` is the extension entry point and wires provider registration, commands, lifecycle hooks, and exec bridge refresh behavior. Core logic is split by responsibility: OAuth in `src/cursor-oauth.ts`, model discovery in `src/cursor-models.ts`, chat transport in `src/cursor-provider.ts`, exec bridge behavior in `src/cursor-exec-*.ts`, and pi UI/native tool integration in `src/pi-native-tool-hack*.ts`. `src/cursor-gen/agent_pb.ts` is generated protobuf output; do not hand-edit it. `tests/` mirrors the source modules with Bun test files. `dist/` and `coverage/` are generated artifacts.

## Build, Test, and Development Commands
Use Bun at the repository root.

- `bun run build`: clean `dist/`, bundle `src/index.ts`, and emit `.d.ts` files.
- `bun run check`: run `tsc --noEmit`, `knip --production`, `biome check --write .`, and `AGENT=1 bun test --coverage`.
- `bun run check:ci`: run typecheck, knip, `biome ci .`, tests with LCOV coverage output, then build.
- `bun run lint`: apply Biome formatting and lint fixes.
- `bun run lint:ci`: run Biome in CI mode without writing files.
- `bun run typecheck`: run `tsc --noEmit`.
- `bun run knip`: detect unused files and exports.

Run `bun run check` after every change before handing work back. Use `bun run check:ci` when you need to match GitHub Actions behavior locally.

## Coding Style & Naming Conventions
This repository uses TypeScript ESM and Biome. The formatter uses tabs for indentation. Follow existing naming patterns: `camelCase` for values and functions, `PascalCase` for types, and kebab-case filenames such as `cursor-provider.ts`. Keep modules focused and preserve the current split between auth, models, provider transport, exec bridge, and pi native-tool integration.

## Testing Guidelines
Automated tests already exist under `tests/` and run with Bun. For every feature or bug fix, add or update tests first and keep coverage intact. `bun run check` is the minimum verification bar, and `bun run check:ci` is the closest local match to CI. When behavior is user-visible, document the manual flows you exercised, such as `/login cursor`, `/cursor-sync-models`, `/cursor-reset-conversation`, or exec bridge commands, and capture expected error output instead of ignoring it.

## Commit & Pull Request Guidelines
Git history follows Conventional Commit style, for example `feat: integrate cursor exec message handling into extension` and `chore: update readme`. Keep commits small and scoped. PRs should include a short behavior summary, linked issue when applicable, the commands you ran, and screenshots or terminal snippets for auth, widget, or other UX-visible changes.

## Security & Configuration Tips
Do not commit Cursor credentials, tokens, or machine-specific paths. Use `CURSOR_ACCESS_TOKEN` for local authentication when you are not using `/login cursor`.
