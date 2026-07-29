---
"agentcat": major
---

Replace MCP session correlation with explicit task and agent handles (MCP 2026-07-28 / SEP-2567).

MCP 2026-07-28 removes protocol-level sessions, so AgentCat no longer derives correlation from an MCP session ID. Tools now expose optional `task_id` and `agent_id` parameters that the server mints on a first call — appending an `[MCP INSTRUCTIONS]:` block to that tool result — and the agent echoes back on every later call. `Event.sessionId` carries the Task ID and keeps its `ses_` prefix, so dashboards and saved queries are unaffected.

Breaking:

- `identify` runs on every tool call instead of once per session. Nothing is cached, and `userData` no longer accumulates across calls — return the complete object each time.
- `identify` can no longer receive an `initialize` request, so a callback reading `request.params.clientInfo` loses that input. Use `extra` or `server.getClientVersion()`.
- `mcp:initialize`, `mcp:tools/list`, and `agentcat:identify` events are no longer published. Actor fields ride on the remaining events.
- Custom events are anonymous unless `CustomEventData.actor` is supplied.
- `publishCustomEvent` takes a Task ID: a `ses_`-prefixed value is used verbatim, anything else is derived as before. A tracked server with no `taskId` now publishes without a session ID.
- Tool schemas gain optional `task_id` / `agent_id` parameters. `enableTracing: false` disables handles entirely — nothing is injected, read, stripped, or minted back.

New: `enableAgentTracking` and `resolveTaskId` options, `CustomEventData.actor` / `CustomEventData.taskId`, and `AgentCatIDPrefixes.Agent`.
