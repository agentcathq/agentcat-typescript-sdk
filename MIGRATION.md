# Migration guides

- [Upgrading to v2 — explicit task and agent handles](#upgrading-to-v2--explicit-task-and-agent-handles)
- [Migrating from `mcpcat` to `agentcat`](#migrating-from-mcpcat-to-agentcat)

---

# Upgrading to v2 — explicit task and agent handles

MCP `2026-07-28` ([SEP-2567](https://modelcontextprotocol.io)) removed
protocol-level sessions entirely: there is no `Mcp-Session-Id` header and no
session semantics left to hang correlation on. AgentCat v2 replaces every
session-derived identifier with two **explicit handles** that the agent threads
back as ordinary tool parameters.

|                    | v1 (session-derived)                                                      | v2 (explicit handles)                                                      |
| ------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Correlation source | the MCP session ID, hashed                                                | `task_id`, an optional parameter injected into every tool                  |
| Per-agent identity | none                                                                      | `agent_id`, an optional parameter injected into every tool                 |
| `Event.sessionId`  | hashed MCP session ID (`ses_…`)                                           | the Task ID (still `ses_…` — dashboards and saved queries are unaffected)  |
| `identify`         | ran once per session, result cached and merged                            | runs on every tool call, result stamped on that event only, nothing cached |
| Events published   | `mcp:initialize`, `mcp:tools/list`, `agentcat:identify`, `mcp:tools/call` | `mcp:tools/call` only (plus `agentcat:custom`)                             |

The handle protocol is _omit, then echo_: an agent omits `task_id`/`agent_id` on
its first call, the server mints them and appends an `[MCP INSTRUCTIONS]:` block
to that tool result, and the agent echoes those exact values on every later call.
Subagents reuse the **same** `task_id` and omit `agent_id` so they are issued
their own. AgentCat strips both parameters before your handler sees the
arguments.

Nothing in your tool code changes. What follows are the behavioural changes that
can affect you.

## Breaking changes

### 1. `Event.sessionId` now carries the Task ID

MCP session IDs are no longer read or hashed. `Event.sessionId` is populated from
the resolved Task ID and keeps the `ses_` prefix, so existing dashboards, saved
filters, and queries continue to work — they just group by task instead of by
transport session.

`Event.sessionId` is now optional. It is `undefined` when no handle was
available — for example a custom event published against a tracked server with no
`taskId`.

### 2. Three event types are no longer published

`mcp:initialize`, `mcp:tools/list`, and `agentcat:identify` are gone. The
`initialize` request and the `tools/list` response are no longer intercepted for
telemetry (`tools/list` is still wrapped, but only to inject parameters), and
identity is no longer a separate event.

Actor fields (`identifyActorGivenId`, `identifyActorName`, `identifyActorData`)
now ride on every remaining event instead. If you have alerts, funnels, or
exporter filters keyed on those three event types, they will go quiet.

### 3. `identify` runs per tool call, and its result is never cached

```diff
- // v1: identify ran once per session; the result was cached and reused
- // for every later event on that session.
+ // v2: identify runs on every tool call. What it returns is stamped on
+ // that call's event and nothing else.
```

Two consequences:

**`userData` no longer accumulates.** v1 merged each result into the cached
identity, so returning `{ a: 1 }` on one call and `{ b: 2 }` on the next yielded
`{ a: 1, b: 2 }`. In v2 each call's `userData` stands alone. If you return
partial `userData` per call, fields will appear to vanish — return the complete
object every time:

```diff
  identify: async (request, extra) => {
    const user = await myapi.getUser(token);
    return {
      userId: user.id,
-     userData: { lastTool: request.params.name },     // partial; used to merge
+     userData: { plan: user.plan, lastTool: request.params.name }, // complete
    };
  },
```

**`identify` can no longer receive an `initialize` request.** Because
`initialize` is no longer intercepted, the callback only ever sees `tools/call`
requests. A callback that read `request.params.clientInfo` — a field that exists
only on `initialize` — loses that input permanently:

```diff
  identify: async (request, extra) => {
-   const client = request.params.clientInfo;        // never present in v2
+   const client = mcpServer.getClientVersion();     // negotiated client info
    return { userId: await resolveUser(extra?.headers), userName: client?.name };
  },
```

Use `extra` (headers, auth context) or `server.getClientVersion()` instead.

### 4. Custom events are anonymous unless you supply an actor

In v1, `publishCustomEvent` inherited whatever actor happened to sit in the
identity cache. That inheritance was exactly the cross-request leak this release
removes, and a custom event has no request to run `identify` against — so v2
custom events carry no actor fields unless you pass them:

```diff
  await agentcat.publishCustomEvent(server, "proj_0000000", {
    resourceName: "custom-action",
+   actor: { userId: "user-123", userName: "Ada" },
  });
```

### 5. `publishCustomEvent` takes a Task ID, and interprets it by prefix

The first argument (and the new `eventData.taskId`, which takes precedence) is a
Task ID rather than an MCP session ID. It is interpreted by prefix:

- a value starting with **`ses_`** is used **verbatim** — this is the handle the
  agent echoed back to you;
- **anything else** is hashed with your project ID using the same derivation
  `resolveTaskId` uses. (v1 always hashed, so an existing call passing a
  non-`ses_` string keeps resolving to the same ID it did before.)

Passing a tracked server with no Task ID no longer works: a tracked server holds
no ambient session in v2, so the event is published with **no** session ID and a
warning is logged. Pass `eventData.taskId`:

```diff
- await agentcat.publishCustomEvent(server, "proj_0000000", { resourceName: "x" });
+ await agentcat.publishCustomEvent(server, "proj_0000000", {
+   taskId: taskIdFromThisToolCall,
+   resourceName: "x",
+ });
```

**Two combinations do not correlate,** and neither is fixable — a bare string
cannot say which path it came from:

1. An agent-supplied `task_id` that is _not_ `ses_`-prefixed is taken verbatim on
   a tool call (deliberately, so a caller can thread its own ID), but the same
   string passed to `publishCustomEvent` is derived.
2. A `resolveTaskId` hook returning a _`ses_`-prefixed_ value is derived (hook
   return values always are), but the same string passed to `publishCustomEvent`
   is verbatim.

Pick one convention and stay in it: either always use the handles the agent gave
you (`ses_`-prefixed, verbatim everywhere), or always use your own identifiers
(never `ses_`-prefixed, derived everywhere).

Note that a human-meaningful identifier such as `"checkout-flow"` is hashed —
you will see a `ses_…` value in the dashboard, not that string.

### 6. Your tools' schemas change

Every tool served through `tools/list` gains optional `task_id` and (unless
`enableAgentTracking: false`) `agent_id` string parameters, and tool results gain
an `[MCP INSTRUCTIONS]:` text block on calls where a handle was minted. Injection
is skipped for tools with `oneOf`/`allOf`/`anyOf` schemas, and for tools that
already declare a `task_id` or `agent_id` parameter of their own — those are left
completely alone and their events are tagged `agentcat_handle_collision`.

Handle injection is gated on `enableTracing`; with `enableTracing: false` nothing
is injected, read, or stripped.

Tool-call events also gain `agentcat_task_id_source` and, with agent tracking on,
`agentcat_agent_id` / `agentcat_agent_id_source` tags. These are written after
your `eventTags` are validated, so they cannot collide with your keys or consume
your 50-tag budget.

## New options

```ts
agentcat.track(mcpServer, "proj_0000000", {
  // Default true. False drops agent_id from schemas, tags, and mint-back text.
  enableAgentTracking: false,

  // Your own correlation ID. Wins over an agent-supplied task_id; return null
  // (or throw) to fall back to it, then to minting.
  resolveTaskId: (request, extra) => myWorkflowId(request, extra) ?? null,
});
```

`AgentCatIDPrefixes` gains an `Agent = "agt"` member. The enum is exported as
documentation of the ID scheme only — it has no internal consumers, and you never
need to pass it anywhere.

---

# Migrating from `mcpcat` to `agentcat`

MCPcat is now **AgentCat** — same team, same product, new name. The npm package has been renamed from `mcpcat` to [`agentcat`](https://www.npmjs.com/package/agentcat), starting fresh at `v1.0.0`.

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

The rename itself introduced no other API changes — as of `v1.x`, `track()`, its options, the `identify` and redaction hooks, and the telemetry exporters all work exactly as before. (`v2.0.0` does change behaviour; see [Upgrading to v2](#upgrading-to-v2--explicit-task-and-agent-handles).)

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
