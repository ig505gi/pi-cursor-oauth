# Repository Guidelines

## Project Structure & Module Organization
`src/index.ts` is the extension entry point and wires provider registration, commands, and exec UI hooks. Core logic is split by responsibility: OAuth in `src/cursor-oauth.ts`, model discovery in `src/cursor-models.ts`, chat transport in `src/cursor-provider.ts`, and exec bridge/UI code in the `src/cursor-exec-*.ts` files. `src/cursor-gen/agent_pb.ts` is generated protobuf output; do not hand-edit it. `dist/` contains build artifacts. `pi-cursor-provider/` is a separate package snapshot with its own `package.json`, README, and image assets.

## Build, Test, and Development Commands
Use Bun at the repository root.

- `bun run build`: clean `dist/`, bundle `src/index.ts`, and emit `.d.ts` files.
- `bun run check`: run lint, typecheck, and `knip`; this is the pre-push gate.
- `bun run lint`: apply Biome formatting and lint fixes.
- `bun run lint:ci`: run Biome in CI mode without writing files.
- `bun run typecheck`: run `tsc --noEmit`.
- `bun run knip`: detect unused files and exports.

After making code changes, always run `bun run check` before committing or opening a PR.

If you work inside `pi-cursor-provider/`, use its local tooling: `npx biome check` and `npx tsc --noEmit`.

## Coding Style & Naming Conventions
This repository uses TypeScript ESM and Biome. The root formatter uses tabs for indentation. Follow existing naming patterns: `camelCase` for values and functions, `PascalCase` for types, and kebab-case filenames such as `cursor-provider.ts`. Keep modules focused and preserve the current split between auth, models, provider transport, and exec bridge concerns.

## Testing Guidelines
There is no committed automated test suite yet. For every feature or bug fix, add tests first and include them in the same change; do not reduce coverage to get a green build. Until a test runner is added, `bun run check` is the minimum required verification. In your PR, list the manual flows you exercised, such as `/login cursor`, `/cursor-sync-models`, or exec bridge commands, and capture expected error output instead of ignoring it.

## Commit & Pull Request Guidelines
Git history follows Conventional Commit style, for example `feat: integrate cursor exec message handling into extension` and `chore: update readme`. Keep commits small and scoped. PRs should include a short behavior summary, linked issue when applicable, the commands you ran, and screenshots or terminal snippets for auth, widget, or other UX-visible changes.

## Security & Configuration Tips
Do not commit Cursor credentials or local paths. Use environment variables such as `CURSOR_ACCESS_TOKEN`, `CURSOR_API_KEY`, `CURSOR_AGENT_PATH`, and `AGENT_PATH` for local configuration.
