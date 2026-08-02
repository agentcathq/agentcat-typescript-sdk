## Migrating v1.0.0 to v2.0.0 — Explicit handles replace MCP session correlation

MCP protocol 2026-07-28 (SEP-2567) removed protocol-level sessions, so AgentCat now correlates work with two explicit, server-minted handles that agents echo back as tool parameters:

- `conversation_id` — one goal, start to finish. Subagents share their parent's conversation_id. It is stored in the existing `sessionId` event field with the same `ses`_ prefix, so dashboards, queries, and exporters are unaffected.
- `agent_id` — one per agent; subagents get their own. Rides on events as the `agentcat_agent_id` tag. Off by default — opt in with `enableAgentTracking: true`.

### This changes your tools' public interface

Upgrading takes no configuration, but it does change what your MCP server publishes to its callers. These are your schemas and your responses — review them before you roll out.

**Every tracked tool's input schema gains** `conversation_id` — type `string`, optional. Agents echo it back on later calls, and AgentCat strips it before your handler runs.

```diff
  {
    "name": "search_orders",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": { "type": "string" },
+       "conversation_id": { "type": "string", "description": "REQUIRED on every call after your first…" }
      }
    }
  }
```

`additionalProperties: false` **is removed** from tracked input schemas. If you declared it deliberately to reject unknown parameters, that constraint no longer appears in the schema AgentCat publishes.

**With** `enableAgentTracking: true`**,** `agent_id` **is added to the schema's** `required` **array.** This is the one addition a strict client will enforce — a schema-validating MCP client refuses to send a call that omits it. Server-side enforcement is soft: a call without `agent_id` still succeeds, and the event is simply published without agent identity. This is why agent tracking is off by default.

**Tools with a plain-object** `outputSchema` **gain an optional** `_mcp_instructions` **property**, so validating clients accept the handle mirrored into `structuredContent`. Schemas built from `oneOf` / `allOf` / `anyOf` have no single properties bag to extend and are skipped — mint-back stays content-only there.

**Responses that mint a handle gain a trailing** `[MCP INSTRUCTIONS]:` **text block.** It is wire-only: recorded event responses and error messages contain only your tool's own output.

**Tools that already declare** `conversation_id`**,** `agent_id`**, or** `context` **are left alone.** Your parameter reaches your handler untouched and a warning goes to `~/agentcat.log`. One caveat: this depends on a `tools/list` having run — a call arriving at an instance that never served a listing falls back to stripping all three names.

### Most integrations need no code changes

`track()` and its options are **purely additive** in 2.0.0. `enableAgentTracking` and `resolveConversationId` were added; nothing was removed. `identify`, `redactSensitiveInformation`, `redactEvent`, `exporters`, `enableReportMissing`, `enableTracing`, `enableToolCallContext`, and `customContextDescription` all keep their existing signatures and behavior.

If your integration is a `track(server, projectId, { ...hooks })` call, upgrading is a version bump. Handles are injected and stripped inside the SDK, so your tool handlers never see the extra parameters, and conversation IDs keep landing in the `sessionId` field with the `ses_` prefix — your existing dashboards, queries, and exporter pipelines keep working untouched.

### Update your code only if…

**You call** `publishCustomEvent`**.** The tracked-server form now publishes without a task unless you set `eventData.conversationId`. A session-id string passed as the first argument is used verbatim as the conversation ID, with no derivation.

```diff
  agentcat.publishCustomEvent(server, "proj_abc", {
    resourceName: "checkout",
+   conversationId: currentConversationId,
  });
```

**You import the** `AgentCatData` **type.** Its session bookkeeping fields are gone — `sessionId`, `lastActivity`, `identifiedSessions`, `sessionInfo`, `lastMcpSessionId`, and `sessionSource`. It is now just `{ projectId, options }`. Most integrations never reference this type.

**You snapshot tool schemas in tests.** The schema additions above will fail exact- match assertions. Parameter order is: your params, `conversation_id`, `agent_id`, `context`.

**You built dashboards on** `mcp:initialize`**,** `mcp:tools/list`**, or** `agentcat:identify` **events.** These are no longer published — actor fields ride on every event instead, so requery against the events themselves.

### Behavior changes worth knowing

- `identify` **now runs on every tool call**, and its result is stamped directly on that call's event. There is no identity cache. If your hook does a database or API lookup, it is now on the hot path for every call — add your own caching if that matters for your latency budget.
- MCP `extra.sessionId` is ignored entirely, and inactivity-based session rollover is gone.

### Bringing your own conversation IDs

If you already track your own task or correlation IDs, plug yours in and AgentCat will not prompt the agent about conversation_id at all:

```typescript
agentcat.track(server, "proj_abc", {
  resolveConversationId: async (request, extra) =>
    extra?.requestInfo?.headers?.["x-correlation-id"] ?? null,
});
```

# Migrating from `mcpcat` to `agentcat`

MCPcat is now **AgentCat** — same team, same product, new name. The npm package has been renamed from `mcpcat` to `[agentcat](https://www.npmjs.com/package/agentcat)`, starting fresh at `v1.0.0`.

## Nothing breaks if you stay

We keep every existing surface alive **permanently** — not on a deprecation timer:

- The `mcpcat` npm package stays published and functional
- `api.mcpcat.io` keeps accepting events forever
- The `MCPCAT_API_URL` environment variable keeps working
- Your project, data, and history stay unified regardless of which SDK sends them

If you never touch your integration, nothing stops working. Migrate on your own schedule — new features only land in `agentcat`.

## What changed

|                   | `mcpcat` (old)                                      | `agentcat` (new)                                          |
| ----------------- | --------------------------------------------------- | --------------------------------------------------------- |
| npm package       | `mcpcat`                                            | `agentcat` (starts at `v1.0.0`)                           |
| Import            | `import * as mcpcat from "mcpcat"`                  | `import * as agentcat from "agentcat"`                    |
| Default endpoint  | `https://api.mcpcat.io`                             | `https://api.agentcat.com`                                |
| Public types      | `MCPCatOptions` / `MCPCatData` / `MCPCatIDPrefixes` | `AgentCatOptions` / `AgentCatData` / `AgentCatIDPrefixes` |
| Endpoint override | `MCPCAT_API_URL`                                    | `AGENTCAT_API_URL` (`MCPCAT_API_URL` still honored)       |
| Local log file    | `~/mcpcat.log`                                      | `~/agentcat.log`                                          |

There are no other API changes — `track()`, its options, the `identify` and redaction hooks, and the telemetry exporters all work exactly as before.

## Steps

1. **Swap the package:**

```bash
 npm uninstall mcpcat
 npm install agentcat
```

2. **Rename your imports:**

```diff
 - import * as mcpcat from "mcpcat";
 + import * as agentcat from "agentcat";

 - mcpcat.track(server, "proj_0000000");
 + agentcat.track(server, "proj_0000000");
```

3. **Rename any imported types 1:1** — `MCPCatOptions` → `AgentCatOptions`, `MCPCatData` → `AgentCatData`, `MCPCatIDPrefixes` → `AgentCatIDPrefixes`.
4. **Environment variables (optional):** if you override the endpoint, prefer `AGENTCAT_API_URL`. The old `MCPCAT_API_URL` name is still read as a fallback.
5. **Log tooling (if any):** the SDK now writes to `~/agentcat.log` instead of `~/mcpcat.log`.

Your project ID does not change, and your dashboard history is continuous.

## Or let an AI agent do it

Paste this into your coding agent (Claude Code, Cursor, Copilot, etc.) from your project root:

```text
Migrate this project from the `mcpcat` npm package to its renamed successor `agentcat` (same API, new package name):

1. Replace the `mcpcat` dependency with `agentcat` using this project's package manager (e.g. `npm uninstall mcpcat && npm install agentcat`).
2. Update every import/require of "mcpcat" to "agentcat".
3. Rename these types 1:1 wherever they're used: MCPCatOptions → AgentCatOptions, MCPCatData → AgentCatData, MCPCatIDPrefixes → AgentCatIDPrefixes.
4. If the env var MCPCAT_API_URL appears anywhere (code, .env files, CI, deploy config), rename it to AGENTCAT_API_URL. (Optional — the old name is still read as a fallback.)
5. Update any references to the log path ~/mcpcat.log → ~/agentcat.log.
6. Do NOT change the project ID passed to track() — it stays the same.
7. Run the project's build and tests to verify, and report anything that referenced mcpcat which you could not migrate mechanically (e.g. dashboards or filters keying on source=mcpcat).
```

## Heads-up if you forward telemetry to your own tools

If you use the exporters (Datadog, Sentry, PostHog, OTLP), the `source` value stamped into **your** observability platform changes from `mcpcat` to `agentcat`. Update any saved filters, monitors, or dashboards that key on it — a one-time change on your side.

## FAQ

**Do I have to migrate?** No — and there is no deadline. The old package and endpoint stay up permanently.

**Will my data/history split?** No. Both SDKs report into the same platform and your history stays unified under your project.

**What about the GitHub repo?** The org is being renamed; old repo URLs will redirect automatically, and stars/issues are preserved.

**Questions?** Open an issue or email [hi@agentcat.com](mailto:hi@agentcat.com).
