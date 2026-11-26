# Changelog

This file lists the notable changes of each release of the `agentcat` npm package.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the SDK follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). For the releases before 2.0.0, see
the [GitHub releases](https://github.com/agentcathq/agentcat-typescript-sdk/releases).

## [Unreleased]

## [2.2.1] - 2026-11-26

### Security

- The SDK now masks sensitive values in every event before the event leaves your server. It
  tests each key in `parameters`, `response` and `error`, at any depth. When the key names a
  secret, the SDK keeps the key and replaces the value with `[redacted]`. A key names a secret
  when it is a known credential header (`authorization`, `cookie`, `x-api-key` and others) or
  has a word such as `token`, `secret`, `password`, `signature` or `api-key`, in any spelling
  (`X-Api-Key`, `HTTP_X_API_KEY`, `xApiKey`). Before, the SDK sent the HTTP headers of each MCP
  request as received, in `parameters.extra.requestInfo.headers` (MCP SDK v1) or
  `parameters.extra.http.req.headers` (v2). Tool arguments and results under such key names
  lose their values too, for example `pageToken` and `auth_type`. `null`, `true` and `false`
  stay. No option turns the mask off (#88).

## [2.2.0] - 2026-11-17

### Added

- Tool-call events (`mcp:tools/call`) now carry `input_tokens` and `output_tokens`: estimates of
  the tokens that the calling model spends on the tool arguments and reads back from the tool
  result. No option changes. The SDK computes both before your `redactSensitiveInformation` and
  `redactEvent` hooks run, so they describe the original size; to keep that size on your server,
  drop the two fields in `redactEvent`. The estimate is `ceil(utf8_bytes / 3.5)`, the same in the
  TypeScript, Python and Go SDKs. Expect counts about 10 percent lower than the earlier
  server-side estimates, because the JSON envelope no longer counts (#71).
- The SDK now sends AgentCat a description of your MCP server: its name, version, title and
  instructions, and the lists of its tools, resources, resource templates and prompts. About
  once an hour per process and server name, after your server answers a request, the SDK calls
  your server's own list handlers and sends the result in the background. In a runtime that
  keeps no memory between requests, it sends only on a `tools/list` request or a
  `get_more_tools` call. `redactSensitiveInformation` runs on every text; item names and URIs
  stay as they are. No option changes: the send is on when tracking is on, and a failed send
  never reaches your server (#84).

### Changed

- The SDK now depends on `agentcat-api` 1.0.5, which adds the two token fields to the publish
  request (#71) and the server info request (#84).

## [2.1.0] - 2026-08-31

Explicit session handles are sturdier and easier for agents to use. The `track()` API does not
change; the changes are in the wire contract between your server and the agent.

### Changed

- The text block that issues an ID is now the first content element of the response, not the
  last, so it survives client-side truncation of long results. Published events still carry
  your original response.
- `session_id` is required, with the pattern `^(start|ses_[0-9A-Za-z]{27})$`. An agent sends
  `start` to begin a new task, or the `ses_` ID issued for the task underway. Calls without it
  are still accepted and treated as `start`.
- `mcp_session` replaces `_mcp_instructions` as the structured mirror in `structuredContent`:
  `{session_id?, agent_id?, status?}`, with the `status` values `issued`, `active` and
  `unrecognized` in place of the prose `instructions` member.
- An unrecognized `session_id` comes back as `mcp_session.status: "unrecognized"` and a leading
  `[session_id unrecognized …]` text block that states how to recover. That response issues no
  new ID.
- Shorter `session_id` and `agent_id` descriptions, the same in all AgentCat SDKs. The two
  `agent_id` variants are now one.
- Breaking for consumers that check response internals or advertised schemas (tests, proxies,
  clients that read `structuredContent`): the `_mcp_instructions` key is now `mcp_session`, the
  issuance block moved to the first position with new headers, and `session_id` and `agent_id`
  are in each tool's `required` array.

### Fixed

- `serverName`, `serverVersion`, `clientName` and `clientVersion` no longer pass through
  `redactSensitiveInformation`: they are MCP metadata, not user content (#57).

## [2.0.0] - 2026-08-05

AgentCat 2 rebuilds task correlation for sessionless MCP (the 2026-07-28 specification) and adds
support for MCP TypeScript SDK v2. The
[migration guide](https://github.com/agentcathq/agentcat-typescript-sdk/blob/main/MIGRATION.md)
lists the changes your MCP clients see and the cases that need a code change.

### Added

- Explicit session handles: `track()` injects `session_id` into each tracked tool's input
  schema, and agents send it back on each call, so related calls group into one task across
  stateless HTTP, load balancers and per-request server instances. Issued IDs reach the agent
  through `_mcp_instructions` and, for tools with an output schema, `structuredContent`. Your
  tool handler never sees the injected parameters.
- The `resolveSessionId` hook, to derive the session from your own correlation ID instead.
- Opt-in agent attribution: with `enableAgentTracking: true`, each agent sends a self-generated
  `agent_id`.
- Support for MCP TypeScript SDK v2 next to v1, for the high-level `McpServer` and the low-level
  `Server`, with the 2026-07-28 protocol. Per-request serving: call `track()` in your
  `createMcpHandler` or `serveStdio` factory.
- `get_more_tools` has the read-only tool annotation.

### Changed

- An AgentCat failure no longer affects your server. A failure after a tool call returns your
  result unchanged. One tool schema that the SDK cannot process no longer fails `tools/list`.
  The hooks `identify`, `resolveSessionId`, `eventTags` and `eventProperties` run beside your
  tool handler with a fixed time budget, so a slow or failing hook costs only that event's
  analytics. The schema-registry rebuild stops after 5 seconds. When the log file cannot be
  created, logging stops instead of writing to stdout. SIGINT and SIGTERM handlers flush and
  then stop the process as before.
- Sturdier Cloudflare Workers support.
- Breaking: agent tracking is opt-in. `enableAgentTracking` defaults to `false`.
- Breaking: `publishCustomEvent` takes session IDs as they are; `CustomEventData.sessionId`
  replaces the session references.

### Removed

- Breaking: the session-ID machinery, the identity caches and the identify events. Correlation
  now uses the explicit `session_id` handles.

[Unreleased]: https://github.com/agentcathq/agentcat-typescript-sdk/compare/v2.2.1...HEAD
[2.2.1]: https://github.com/agentcathq/agentcat-typescript-sdk/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/agentcathq/agentcat-typescript-sdk/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/agentcathq/agentcat-typescript-sdk/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/agentcathq/agentcat-typescript-sdk/compare/v1.0.0...v2.0.0
