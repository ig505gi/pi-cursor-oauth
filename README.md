# pi-cursor-oauth

[![CI](https://github.com/kenryu42/pi-cursor-oauth/actions/workflows/ci.yml/badge.svg)](https://github.com/kenryu42/pi-cursor-oauth/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/kenryu42/pi-cursor-oauth?label=version&color=blue)](https://github.com/kenryu42/pi-cursor-oauth)
[![License: MIT](https://img.shields.io/badge/License-MIT-red.svg)](https://opensource.org/licenses/MIT)

A pi extension that registers a `cursor` provider, supports Cursor browser OAuth, and forwards chat plus a limited set of Cursor exec calls through pi.

## Features

- Registers a `cursor` provider with the `cursor-chat-api` transport
- Supports `/login cursor` using Cursor's browser OAuth flow
- Uses `CURSOR_ACCESS_TOKEN` as the environment variable fallback
- Ships a fallback model list so the provider is usable before live model sync
- Refreshes usable models from Cursor with `/cursor-sync-models`
- Resets cached Cursor conversation state with `/cursor-reset-conversation`
- Resets session-scoped Cursor state when pi sessions start, switch, or fork

## Install

```bash
pi install npm:pi-cursor-oauth
```

## Authenticate

Inside pi:

```text
/login cursor
```

Or provide a token directly:

```bash
export CURSOR_ACCESS_TOKEN=...
```

## Sync models

The extension starts with a bundled fallback model list and can refresh the currently usable Cursor model list on demand. When Cursor credentials are available, it also attempts a quiet model sync on session start and when the Cursor model is selected.

```text
/cursor-sync-models
```

Then pick a Cursor model with `/model`.

## Commands

- `/cursor-sync-models` - refresh the provider's model list from Cursor
- `/cursor-reset-conversation` - clear cached Cursor conversation state

## Exec bridge

This extension includes a limited Cursor exec bridge.

Supported exec calls:
- `read`
- `ls`
- `grep` with `content`, `files_with_matches`, and `count`
- `write` for text content
- `delete`
- `shell`
- `shellStream`
- `requestContext`

Bridge behavior notes:
- Exec streams are explicitly closed after tool completion so Cursor does not remain stuck on `working...`
- Unsupported interaction queries are answered immediately instead of being left pending
- Cursor exec activity is best-effort mirrored into a small pi TUI widget instead of extra conversation messages
- The pi TUI integration currently relies on a private internal-module/prototype patch into pi internals, so it is inherently brittle and may break across pi versions or internal layout changes

Current limitations:
- Binary `write` via raw bytes is not supported
- Background shell spawning is not supported
- `writeShellStdin` is not supported
- `diagnostics` is not supported
- `fetch` is not supported
- Generic MCP tool calls and MCP resource operations are not supported
- `recordScreen` is not supported
- `computerUse` is not supported

## Development

```bash
bun install
bun run check
bun run build
```