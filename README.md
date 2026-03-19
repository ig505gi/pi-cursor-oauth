# pi-cursor-oauth

A pi extension that adds Cursor OAuth login and a Cursor-backed model provider.

Location:
- `/Users/kenryu/Developer/420024-lab/pi-cursor-oauth`

## What it does

- Registers a `cursor` provider for pi
- Supports `/login cursor` using Cursor's browser OAuth flow
- Uses `CURSOR_ACCESS_TOKEN` as the environment variable fallback
- Ships a fallback Cursor model list
- Adds `/cursor-sync-models` to fetch the current usable model list from Cursor
- Adds `/cursor-reset-conversation` to reset the cached Cursor conversation state

## Exec bridge support

This extension now includes a **minimal Cursor exec bridge**.

Supported exec calls:
- `read`
- `ls`
- `grep` (`content`, `files_with_matches`, `count`)
- `write` for text content
- `delete`
- `shell`
- `shellStream`
- request context

Bridge behavior notes:
- exec streams are now explicitly closed after tool completion so Cursor does not stay stuck on `working...`
- unsupported interaction queries from Cursor are answered immediately instead of being left pending
- Cursor exec activity is mirrored into a small pi TUI widget so tool runs are visible without injecting extra conversation messages

Current limitations:
- binary `write` via raw bytes is not supported yet
- MCP/resource/background-shell/computer-use style exec calls are rejected

## Usage

### 1. Install dependencies

```bash
cd /Users/kenryu/Developer/420024-lab/pi-cursor-oauth
npm install
```

### 2. Load the extension

Temporary:

```bash
pi -e /Users/kenryu/Developer/420024-lab/pi-cursor-oauth
```

Or install as a local package:

```bash
pi install /Users/kenryu/Developer/420024-lab/pi-cursor-oauth
```

### 3. Authenticate

Inside pi:

```text
/login cursor
```

Or provide an environment variable:

```bash
export CURSOR_ACCESS_TOKEN=...
```

### 4. Refresh models

Inside pi:

```text
/cursor-sync-models
```

Then select a Cursor model with `/model`.

## Commands

- `/cursor-sync-models` - refresh the provider's model list from Cursor
- `/cursor-reset-conversation` - clear cached Cursor conversation state

## Files

- `src/index.ts` - extension entry point
- `src/cursor-oauth.ts` - Cursor OAuth login and refresh flow
- `src/cursor-models.ts` - fallback models and live model discovery
- `src/cursor-provider.ts` - Cursor chat transport implementation
- `src/cursor-exec-bridge.ts` - Cursor exec dispatch and result mapping
- `src/cursor-gen/agent_pb.ts` - generated protobuf bindings used by the Cursor API

This project is actively maintained.
It is intended to make Cursor integration with pi straightforward.
