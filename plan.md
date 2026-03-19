# Plan: Add a minimal, reliable Cursor exec bridge to pi-cursor-oauth

## Context

The pi-cursor-oauth extension (`/Users/kenryu/Developer/420024-lab/pi-cursor-oauth/`) registers a Cursor provider for pi. Today it is effectively **chat-only**: when a Cursor model is active, `src/index.ts` disables pi tools, and `src/cursor-provider.ts` only answers `requestContextArgs` with an empty tool list.

A full Cursor-style exec bridge is **not** exposed by the public pi extension API, but public pi **does** export built-in tool factories such as:

```ts
import {
  createReadTool,
  createBashTool,
  createWriteTool,
  createGrepTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
```

These return `AgentTool` instances with the public 4-argument execute signature:

```ts
execute(toolCallId, params, signal?, onUpdate?)
```

The extension's generated protobuf bindings in `src/cursor-gen/agent_pb.ts` already contain the exec request/response schemas needed to answer Cursor exec calls.

## Verified constraints

These constraints were verified against the current repo and installed pi packages:

1. **`lsArgs` must use `createLsTool()`**, not `createReadTool()`.
   - The public read tool only reads files/images.
   - The public ls tool is the correct directory-listing implementation.

2. **Public grep support is narrower than Cursor grep support.**
   - pi grep supports: `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `context`, `limit`
   - Cursor grep args include extra fields such as `outputMode`, `contextBefore`, `contextAfter`, `type`, `headLimit`, `multiline`, `sort`, `sortAscending`
   - Therefore grep bridging must be partial or reject unsupported modes.

3. **Public bash does not accept per-call `cwd`.**
   - `createBashTool(cwd)` captures cwd at tool creation time.
   - `shellArgs.workingDirectory` therefore requires creating a bash tool for that request's cwd, or bypassing the public bash tool.

4. **Public bash streaming does not preserve separate stdout/stderr channels.**
   - The public bash tool merges output for updates.
   - Cursor `shellStreamArgs` expects start/stdout/stderr/exit events.
   - Faithful `shellStreamArgs` support is not possible with only the public bash tool.

5. **Public write only supports text content.**
   - Cursor `writeArgs` supports both `fileText` and raw `fileBytes`.
   - `createWriteTool()` only writes a string.
   - Raw binary writes require custom FS handling or explicit rejection.

6. **The public extension API does not expose executable handles for all active pi tools.**
   - `pi.getActiveTools()` returns names.
   - `pi.getAllTools()` returns metadata/schema.
   - It does **not** expose executable handles for arbitrary tools registered by other extensions.
   - Therefore generic MCP bridging for all active tools is not available from public APIs alone.

## Goal

Replace the current chat-only behavior with a **minimal reliable exec bridge** that supports the subset of Cursor exec calls that can be implemented cleanly with public pi APIs, and explicitly rejects unsupported exec cases.

The first implementation goal is:

- keep pi tools enabled while using Cursor models
- support reliable exec handling for:
  - `requestContextArgs`
  - `readArgs`
  - `lsArgs`
  - `writeArgs` with `fileText`
  - `deleteArgs`
  - `shellArgs`
  - `diagnosticsArgs` -> rejected
- provide **partial** grep support only if the response format can be mapped safely
- explicitly reject unsupported or misleadingly implemented features instead of pretending full parity

## Non-goals for the first pass

These should be rejected or deferred in v1 of the bridge:

- faithful `shellStreamArgs`
- `backgroundShellSpawnArgs`
- `writeShellStdinArgs`
- `fetchArgs`
- `listMcpResourcesExecArgs`
- `readMcpResourceExecArgs`
- `recordScreenArgs`
- `computerUseArgs`
- generic `mcpArgs` execution for all active pi tools
- binary `writeArgs.fileBytes` unless custom raw-byte writing is added
- full Cursor grep parity (`files_with_matches`, `count`, sort, multiline, etc.) unless implemented separately

## Architecture

```text
Cursor Server -> gRPC stream -> src/cursor-provider.ts
                             |
                             +-> interactionUpdate -> existing text/thinking handling
                             +-> kvServerMessage   -> existing blob store handling
                             +-> execServerMessage -> NEW: src/cursor-exec-bridge.ts
                                                        |
                                                        +-> requestContextArgs -> bridged tool list
                                                        +-> readArgs           -> createReadTool(cwd)
                                                        +-> lsArgs             -> createLsTool(cwd)
                                                        +-> grepArgs           -> partial support or reject
                                                        +-> writeArgs          -> createWriteTool(cwd)
                                                        +-> deleteArgs         -> direct fs with cwd-aware resolution
                                                        +-> shellArgs          -> createBashTool(workingDirectory)
                                                        +-> others             -> explicit rejected/error response
```

## Files to change

### 1. NEW: `src/cursor-exec-bridge.ts`

Core module for Cursor exec dispatch.

Suggested responsibilities:

#### Bridge state / factory

Create a bridge from session cwd:

```ts
createCursorExecBridge({
  cwd,
  toolInfos,
})
```

Where the bridge stores:

- session cwd
- built-in tool instances created for that cwd:
  - `readTool`
  - `lsTool`
  - `writeTool`
  - `grepTool`
- helper for per-request bash execution:
  - `createBashTool(resolvedWorkingDirectory)`

#### RequestContext support

Build `RequestContext` from the subset of tools the bridge can actually execute.

Important rule:
- only advertise tools that this bridge can really handle
- do **not** advertise arbitrary active tools as executable MCP tools unless this extension owns executable handles for them

The safest initial request context is:
- native bridged tool availability only
- empty MCP tool list, or only bridge-owned custom tools if they ever exist

#### `sendExecClientMessage()` helper

Build and send:
- `ExecClientMessageSchema`
- wrapped in `AgentClientMessageSchema`
- framed with the existing Connect/gRPC framing logic

#### `executeTool()` helper

Wrap public `AgentTool.execute()` with:
- `tool.execute(toolCallId, params, undefined, undefined)`
- try/catch normalization
- a result object that also records whether the execution failed

#### Cwd-aware path resolver

Add a local helper that resolves paths relative to the session cwd in a pi-compatible way.

At minimum:
- absolute paths stay absolute
- relative paths resolve against session cwd
- optionally support `~` and `@` prefixes to better match pi path behavior

This helper is needed especially for:
- `deleteArgs`
- default shell cwd fallback

#### Result builders

Implement builders tailored to the actual public tool outputs used by this extension.
Do **not** assume the reference Cursor implementation can be copied over unchanged.

Needed builders:

- `buildRequestContextResult()`
- `buildReadResult()`
- `buildLsResult()`
- `buildWriteResult()`
- `buildDeleteResult()`
- `buildShellResult()`
- `buildRejected...()` / `buildError...()` helpers for unsupported cases

Notes per builder:

- **Read**: map text/image read tool output into `ReadResult`
- **Ls**: map public ls output into a minimal `LsDirectoryTreeNode`
- **Write**: support only text writes at first; reject raw byte writes
- **Delete**: pre-read/stat before deletion if needed to populate `DeleteSuccess`
- **Shell**: build a minimal success/failure result from merged bash output; do not claim separate stdout/stderr fidelity if the public tool cannot provide it
- **Grep**: only add after the output mapping is well-defined; otherwise reject unsupported grep modes explicitly

#### `handleExecServerMessage()` dispatcher

Initial dispatch behavior:

- `requestContextArgs` -> success with bridged tool context
- `readArgs` -> `readTool.execute(id, { path })`
- `lsArgs` -> `lsTool.execute(id, { path })`
- `writeArgs`
  - if `fileBytes` is non-empty -> reject or error as unsupported in v1
  - else `writeTool.execute(id, { path, content: fileText })`
- `deleteArgs` -> direct fs delete using cwd-aware path resolution
- `shellArgs`
  - resolve working directory from `args.workingDirectory` or session cwd
  - create `createBashTool(resolvedCwd)` for that request
  - execute with `{ command, timeout }`
- `grepArgs`
  - either support a narrow content-only subset
  - or reject with a clear unsupported reason
- `diagnosticsArgs` -> rejected (no LSP access in public extension API)
- unsupported exec messages -> explicit rejected/error result

### 2. MODIFY: `src/cursor-provider.ts`

Changes:

- replace the current `handleExecServerMessage()` stub with a call into `cursor-exec-bridge.ts`
- thread the current bridge instance into exec handling
- keep existing behavior unchanged for:
  - `interactionUpdate`
  - `kvServerMessage`
  - conversation checkpoint handling
  - request framing/parsing

Suggested shape:
- keep streaming/chat logic where it is
- keep exec logic isolated in the bridge module

### 3. MODIFY: `src/index.ts`

Changes:

- remove `updateCursorMode()` entirely
- remove `nonCursorTools`
- remove the chat-only notification/status text
- initialize bridge state for the session cwd on:
  - `session_start`
  - `session_switch`
  - `session_fork`
- update provider registration so `streamCursorChat` can access the current bridge
- keep model sync behavior

Important detail:
- the bridge should be recreated whenever the active session cwd changes

### 4. MODIFY: `README.md`

Update docs to reflect the new behavior.

Remove or revise:
- the “chat-only mode” limitation
- statements that Cursor always disables pi tools

Replace with:
- supported exec subset
- unsupported/rejected exec cases in the first implementation

## Corrected exec mapping

| Cursor exec case | Implementation | Status |
|---|---|---|
| `requestContextArgs` | build context from tools this bridge can actually execute | supported |
| `readArgs` | `readTool.execute(id, { path })` | supported |
| `lsArgs` | `lsTool.execute(id, { path })` | supported |
| `writeArgs` (`fileText`) | `writeTool.execute(id, { path, content: fileText })` | supported |
| `writeArgs` (`fileBytes`) | reject or custom raw-byte FS write | deferred/rejected in v1 |
| `deleteArgs` | direct fs delete with cwd-aware path resolution | supported |
| `shellArgs` | `createBashTool(resolvedWorkingDirectory).execute(id, { command, timeout })` | supported |
| `grepArgs` | narrow content-only subset or explicit reject | partial/deferred |
| `diagnosticsArgs` | rejected | supported as rejection |
| `shellStreamArgs` | not faithfully implementable via public bash tool | rejected in v1 |
| `backgroundShellSpawnArgs` | not supported | rejected |
| `writeShellStdinArgs` | not supported | rejected |
| `mcpArgs` | no generic execution path for arbitrary active tools via public API | rejected/deferred |

## Grep plan

Because Cursor grep and public pi grep do not align 1:1, choose one of these explicitly:

### Option A: defer grep in v1
Recommended if correctness matters most.

- reject all `grepArgs` with a clear reason
- land the rest of the bridge first

### Option B: support a narrow grep subset
Only if the response format is validated end-to-end.

Support only:
- `pattern`
- `path`
- `glob`
- `caseInsensitive -> ignoreCase`
- `context`
- `headLimit -> limit`

Reject if any of these are requested:
- `outputMode` other than default content mode
- `type`
- `multiline`
- `sort`
- `sortAscending`
- incompatible `contextBefore` / `contextAfter`

## Shell result plan

Use the public bash tool for `shellArgs`, but document the fidelity limits.

Facts:
- public bash output is merged
- streaming updates are merged
- per-call cwd requires constructing the bash tool with that cwd

Initial shell behavior:
- support normal shell execution
- return a minimal `ShellSuccess` / `ShellFailure`
- if a full output temp file path is available in tool details, map it to `OutputLocation`
- do not claim faithful stdout/stderr separation
- reject `shellStreamArgs` in v1 rather than sending misleading stream events

## Delete result plan

For `deleteArgs`, use custom FS handling rather than a pi public tool.

Suggested steps:
1. resolve path relative to session cwd
2. stat the target
3. reject if not found / not a file as appropriate
4. read previous text content when reasonable
5. delete the file
6. build `DeleteSuccess`

If binary or very large previous content is problematic, prefer:
- a smaller safe `prevContent`, or
- an error/rejection policy documented in code

## Testing and verification

The repo currently has **no test setup** in `package.json`, so “tests first” requires adding one.

Recommended lightweight option:
- use Node's built-in `node:test`
- avoid adding a large framework unless needed

### Automated tests to add if test setup is introduced

1. **Result builder tests**
   - `read` success/error
   - `ls` success/error
   - `write` success/error/rejection for `fileBytes`
   - `delete` success/error
   - `shell` success/failure mapping

2. **Exec dispatch tests**
   - each supported exec case sends the correct `ExecClientMessage`
   - unsupported cases return explicit rejected/error results

3. **Temp-dir integration tests**
   - read/write/delete against a temporary workspace
   - shell with per-request working directory
   - request context advertises only supported tools

### Manual verification

After implementation, verify in pi:

1. select a Cursor model
2. confirm pi tools are no longer forcibly disabled
3. confirm Cursor can:
   - read files
   - list directories
   - write text files
   - delete files
   - run shell commands in the requested working directory
4. confirm unsupported exec cases fail clearly rather than hanging silently
5. confirm normal chat streaming still works

## Implementation order

1. Add a corrected bridge design in `src/cursor-exec-bridge.ts`
2. Implement request context + explicit rejected/error helpers
3. Implement `readArgs`, `lsArgs`, `writeArgs(fileText)`, `deleteArgs`, `shellArgs`
4. Wire the bridge into `src/cursor-provider.ts`
5. Remove chat-only tool disabling in `src/index.ts`
6. Update `README.md`
7. Optionally add test setup and automated tests
8. Evaluate whether grep should be added as a narrow supported subset or remain rejected

## Key reference files

| Purpose | File |
|---|---|
| Extension entry point | `src/index.ts` |
| Cursor stream handler | `src/cursor-provider.ts` |
| Generated exec/result protobufs | `src/cursor-gen/agent_pb.ts` |
| Public tool exports | `@mariozechner/pi-coding-agent` |
| Public `AgentTool.execute` type | `@mariozechner/pi-agent-core/dist/types.d.ts` |
| Public built-in tool behavior | pi installed dist files for read/bash/write/grep/ls |

## Success criteria

This plan is complete when:

- Cursor models no longer force pi into chat-only mode
- supported exec calls return valid protobuf responses
- unsupported exec calls return explicit rejected/error responses
- request context advertises only tools this bridge can actually execute
- README matches the implemented support level
