# MCP TypeScript SDK v2 Compatibility Audit

**Date:** 2026-07-31
**Branch audited:** `feat/explicit-handles-v2` (agentcat 2.0.0-beta.2)
**Audited against:** `modelcontextprotocol/typescript-sdk` tag `@modelcontextprotocol/server@2.0.0` (GA, released 2026-07-27) — cloned and read locally, plus the official migration guides (`docs/migration/upgrade-to-v2.md`, `docs/migration/support-2026-07-28.md`).
**Method:** source-level audit of every AgentCat↔SDK touch point, cross-checked against v2 source, plus **empirical probes** running the built `dist/` against real published v2 packages (`@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/client@2.0.0`, `zod@4.x`, Node 22).

> Scope note: this document audits and records findings only. No fixes are applied here.
> Per project direction: continued use of SDK-internal/private fields is acceptable —
> we have robust change detection. v2's "private" fields are TypeScript-private, not
> ES `#private`, so they remain reachable at runtime (verified).

---

## Executive summary

v2 is a **package split + API rewrite**: `@modelcontextprotocol/sdk` becomes `@modelcontextprotocol/{core,client,server,node,express,hono,fastify,server-legacy}` (plus unpublished `core-internal`). The v1 package line continues (last release `1.30.0`, same day as v2 GA) but the ecosystem's high-level entry (`McpServer`, `createMcpHandler`, `serveStdio`) is now v2.

Today, **AgentCat is fully broken against v2 servers**, in three escalating ways (all empirically confirmed):

| #   | Scenario                                                        | Result                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Customer has only v2 packages installed                         | `import "agentcat"` **crashes the customer's process** at module load (`ERR_MODULE_NOT_FOUND: @modelcontextprotocol/sdk`)                                                                                           |
| 2   | v1 installed alongside; customer tracks a v2 `McpServer`        | `track()` **silently no-ops** — `isCompatibleServerType` throws on the removed `.tool()` method, logging the _misleading_ message "requires MCP SDK v1.11 or higher"                                                |
| 3   | v1 installed alongside; customer tracks a v2 low-level `Server` | Structural validation **passes**, but every `setRequestHandler(ZodSchema, …)` call throws `TypeError: '[object Object]' is not a spec request method`; `track()` logs "setup complete" having installed **nothing** |

The good news: the **fundamental injection seams survive**. `_requestHandlers` is still a runtime-accessible `Map` keyed by method string; `_registeredTools`, `_serverInfo`, `_capabilities`, `getClientVersion()` all still exist; and direct `_requestHandlers.get/set` wrapping was verified working end-to-end against v2 (event capture, arg observation, mint-back text append, structured mirror all mechanically possible). The v2 model (method strings instead of Zod schemas) actually lets AgentCat **drop its runtime SDK imports entirely**, enabling one build that supports both majors.

The deeper strategic finding: this branch's explicit-handles/2026-07-28 features (per-request `_meta` clientInfo/protocolVersion, session-free operation) **only fully materialize on v2**, because v1 never serves the 2026-07-28 era. v2 support is not just compatibility work — it is the delivery vehicle for this branch's headline feature.

---

## 0. What v2 is (context)

- **Split packages.** `@modelcontextprotocol/server` (server impl incl. `McpServer`, `Server`, web-standard HTTP transport, `createMcpHandler`, `serveStdio`), `@modelcontextprotocol/client`, `@modelcontextprotocol/core` (public Zod `*Schema` constants), `@modelcontextprotocol/core-internal` (unpublished; `server`/`client` bundle their own compiled copies of it), `@modelcontextprotocol/node` (Node HTTP transport wrapper), framework adapters, `server-legacy` (frozen v1 SSE + auth code).
- **Versioning.** All v2 packages share one version number. GA `2.0.0` tagged 2026-07-27. v1 `1.30.0` released the same day; v1 tops out at protocol `2025-11-25` and will never serve `2026-07-28`.
- **Runtime.** Node.js ≥ 20, ESM-first with a native CJS build. `zod ^4.2.0` (SDK-internal; AgentCat has no runtime zod dependency, so this only affects our test harness).
- **Protocol.** v2 serves both the legacy eras (2025-x) and the new 2026-07-28 era, with per-era wire codecs. The 2026 era is per-request (no `Mcp-Session-Id`), served through `createMcpHandler` (fresh server instance per request) or `serveStdio` (factory instance pinned per connection).
- **Both majors coexist** in one `node_modules` (different names). Objects must never flow between v1-imported and v2-imported code (`instanceof`/nominal types don't cross).

---

## 1. Packaging & module resolution

### 1.1 ❌ CRITICAL — static SDK imports crash customer processes without v1 installed

`src/types.ts:1`, `src/modules/tracing.ts:1-5`, `src/modules/tracingV2.ts:1`, `src/modules/tools.ts:1-4` import from `@modelcontextprotocol/sdk/types(.js)`. tsup leaves these external, so `dist/index.mjs` and `dist/index.cjs` both carry top-level imports of `@modelcontextprotocol/sdk/types.js`.

**Verified:** in a project with only v2 packages installed, `import "agentcat"` fails with `ERR_MODULE_NOT_FOUND` — the customer's whole server crashes at startup, before `track()`'s try/catch can soften anything. This is the single worst failure mode in the audit: AgentCat's core design principle is "never break the customer's server," and this breaks it at import time.

What is actually imported, and why it matters:

| Import                                            | Kind                                                         | v2 disposition                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `CallToolRequestSchema`, `ListToolsRequestSchema` | **runtime** Zod constants (used as `setRequestHandler` args) | moved to `@modelcontextprotocol/core`; but v2 registration uses **method strings**, so these become unnecessary entirely |
| `CallToolResult`, `ListToolsResult`               | type-only                                                    | erased at build; harmless — can be inlined/ducked                                                                        |

The only _runtime_ values AgentCat pulls from the SDK are the two request schemas. On v2 they are not needed at all (method strings), and even on v1 the codebase already addresses `_requestHandlers` by method string. Dropping these two imports (e.g. lazy/optional resolution for v1, or bypassing `setRequestHandler` in favor of the map seam AgentCat already uses elsewhere) would make the package **zero-SDK-import** and immune to this whole class of breakage.

### 1.2 ❌ HIGH — `peerDependencies` cannot express v2

`"@modelcontextprotocol/sdk": ">=1.11"` names a package that v2 consumers do not install. Consequences:

- Package managers may warn/fail on unmet peer for v2-only consumers (behavior varies: npm 7+ auto-installs peers → npm would **install v1 automatically**, masking 1.1 but shipping a useless extra SDK; pnpm/yarn warn).
- Per the upstream guide's "Library authors" section: swapping the peer name is itself semver-major for our consumers; the two majors coexist under different names, so the supported dual posture is v1 peer marked **optional** (via `peerDependenciesMeta`) alongside optional v2 peers — or no SDK peer at all once runtime imports are gone (AgentCat never hands SDK class instances across its API, so the v1/v2 object-boundary rule does not bind us).

### 1.3 ⚠ MEDIUM — diagnostics SDK-version probe silently reports nothing on v2

`src/modules/diagnostics.ts:100-103` reads `@modelcontextprotocol/sdk/package.json` via `createRequire`. Two independent breaks for v2 consumers:

1. The v1 package isn't installed → probe returns `null` (graceful, but the `agentcat.mcp_sdk.version` attribute — our main fleet-visibility signal for exactly this migration — is absent precisely where we need it).
2. Even naming a v2 package doesn't work: **verified** `require('@modelcontextprotocol/server/package.json')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` — v2's `exports` map does not expose `./package.json`. Version detection needs a different technique (e.g. `require.resolve` the entry and walk up to the real `package.json` on disk, per-package for `server`/`client`).

### 1.4 ✅ Non-issues

- AgentCat ships ESM + CJS; v2 does both natively — no interop concern.
- No `engines` field in agentcat `package.json`; v2 requires Node ≥ 20. Worth documenting, not code-breaking (AgentCat itself runs fine on 20+).
- AgentCat has **no runtime zod dependency** — the zod-3→4 forced bump that hits server authors does not hit us (test harness only; see §9).
- `getMCPCompatibleErrorMessage`, `captureException`, KSUID/handles logic: SDK-independent, unaffected.

---

## 2. Server detection & structural validation (`compatibility.ts`)

### 2.1 ❌ CRITICAL — high-level check requires the removed `.tool()` method

`src/modules/compatibility.ts:61-66` requires `typeof server.tool === "function"`. v2 removed `.tool()`/`.prompt()`/`.resource()` from `McpServer` (**verified**: `typeof mcp.tool === 'undefined'` on v2 GA). Result (empirically confirmed): `isCompatibleServerType` throws → `track()`'s outer catch logs `Warning: Failed to track server - … High-level server must have tool() method. This requires MCP SDK v1.11 or higher.` and returns the server **untracked**.

Two problems:

- Every v2 `McpServer` is rejected. This is the mainstream v2 path.
- The error copy is **actively misleading** — it tells a user on the newest SDK to "upgrade to v1.11+". Support burden magnet. (Same misleading suffix on every other validation message in this file.)

Detection direction: `registerTool` exists on both v1.12+ and v2; `.tool` exists only on v1. `typeof server.registerTool === 'function' && typeof server.tool !== 'function'` is a clean v2-high-level discriminator if version-branching is needed.

### 2.2 ✅ Everything else in `validateLowLevelServer` passes on v2 (verified)

| Check                                                           | v2 status                                                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `server.server` duck-check for high-level (`isHighLevelServer`) | ✅ `McpServer.server` accessor unchanged                                                                 |
| `_registeredTools` object on `McpServer`                        | ✅ present, TS-private (`packages/server/src/server/mcp.ts:76`)                                          |
| `setRequestHandler` is a function                               | ✅ (signature changed — see §3)                                                                          |
| `_requestHandlers instanceof Map`                               | ✅ still a `Map<string, (request, ctx) => Promise<Result>>` (`core-internal/src/shared/protocol.ts:561`) |
| `getClientVersion` is a function                                | ✅ present, `@deprecated` but functional (`server.ts:973`)                                               |
| `_serverInfo.name`                                              | ✅ present (constructor param property, `server.ts:315`)                                                 |

Caveat: all of these are **`@deprecated`-adjacent or internal**; v2 marks the low-level `Server` class itself `@deprecated` ("use McpServer"). Internals we rely on are stable at GA but carry no compat promise — acceptable per our change-detection posture, but the compat test matrix (§9) is what makes that posture real.

### 2.3 ⚠ LOW — `RegisteredTool` shape drift

v2 registry entries always use `handler` (plus new fields `executor`, `enabled`, `outputSchemaJson`, `annotations`, `icons`, `execution`, `_meta`, `enable/disable/remove/update`). `mcp-sdk-compat.ts`'s `handler`/`callback` dance still _detects_ them (`hasToolFunction` passes), but wrapping them is ineffective — see §4.1, which supersedes this concern.

---

## 3. Handler registration & interception (`tools.ts`, `tracing.ts`, `tracingV2.ts`)

### 3.1 ❌ CRITICAL — `setRequestHandler(ZodSchema, handler)` throws at runtime on v2

v2's signature is `setRequestHandler(method: string, handler)` (spec methods) or `setRequestHandler(method, {params, result?}, handler)` (custom methods). A Zod schema first argument reaches `isSpecRequestMethod(object)` → **`TypeError: '[object Object]' is not a spec request method; pass schemas as the second argument to setRequestHandler().`** (verified live; also called out in the upstream guide's "import-less (injected) SDK surfaces" section — our exact architecture).

Affected call sites:

| Site                                                                        | Effect on v2                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `src/modules/tools.ts:78` (`setupAgentCatTools`, low-level list wrap)       | throws → caught → logged; **no `get_more_tools`, no handle/context injection, no strip registry — ever** |
| `src/modules/tracing.ts:79` (`setupListToolsTracing`, high-level list wrap) | throws → caught → logged; same losses                                                                    |
| `src/modules/tracing.ts:172` (`setupToolCallTracing`, low-level call wrap)  | throws → caught in `track()` → logged; **no events at all**                                              |

Net effect on a v2 low-level server (verified): `track()` completes, logs "setup complete", and **nothing is instrumented**. Silent total data loss, discoverable only in `~/agentcat.log`.

The **method-string forms work** and the **direct map seam works** (verified end-to-end: wrapping via `mcp.server._requestHandlers.get('tools/call')` + `.set(...)` on a live v2 server correctly intercepted a real client call, saw raw args including injected params, and successfully appended a mint-back text block to the result). Note when re-registering via public v2 `setRequestHandler('tools/list', …)`: it _replaces_ the stored handler and re-runs `assertRequestHandlerCapability` (fine — capabilities already declared); the map-`.set` route (which tracingV2 already uses for `tools/call` on v1) bypasses even that.

### 3.2 ❌ HIGH — the `setRequestHandler` monkey-patch mis-parses v2 calls, and breaks customers' custom registrations

`src/modules/tracingV2.ts:277-296` replaces `lowLevelServer.setRequestHandler` with a 2-parameter function that introspects the first argument as a Zod schema (`getObjectShape`/`getLiteralValue`) to find `"tools/call"`. On v2:

1. **Method detection never matches.** First arg is the string `'tools/call'`; `getObjectShape('tools/call')` → `undefined` → the wrapper passes through **unwrapped**. Any `tools/call` handler registered after `track()` (e.g. `McpServer`'s lazy `setToolRequestHandlers()` when the customer declared no `tools` capability and registers their first tool post-track) gets **no tracing, silently**.
2. **3-arg custom-method registrations are corrupted.** The patched function forwards only `(requestSchema, handler)` — for `setRequestHandler('acme/x', {params}, handlerFn)` it forwards the schemas object and **drops the handler**, so the customer's own registration throws `TypeError: setRequestHandler: handler is required`. This is AgentCat _breaking_ a tracked customer's server — worse than losing our own data.

(Mitigating timing note, verified: with `capabilities: { tools: {} }` declared, v2 `McpServer` installs `tools/list` + `tools/call` **eagerly at construction**, so for the common declared-capability case the handlers already exist at `track()` time and the map-wrap path in `setupToolsCallHandlerWrapping` — which uses `.get`/`.set` directly, no schemas — would engage. The monkey-patch is the post-track-registration safety net, and that net is gone on v2.)

The Zod-internals helpers in `mcp-sdk-compat.ts` (`getObjectShape`, `getLiteralValue`, `isZ4Schema`) exist solely to serve this patch; on v2 they become dead weight (v2 never hands us schemas). A v2-aware patch needs to branch on `typeof first === 'string'` and preserve full arity pass-through for 2-arg _and_ 3-arg forms.

### 3.3 ⚠ MEDIUM — stored handlers are pre-wrapped; understand what our wrapper sits above/below

v2's `setRequestHandler` stores `_wrapHandler(method, validatingHandler)` in the map (`protocol.ts:1738`). For `tools/call`, `Server._wrapHandler` adds era-codec request validation and the 2026 multi-round-trip (`input_required`) driver. Consequences for map-seam wrapping (our surviving technique):

- **Calling the stored handler works** (verified): it accepts the raw JSON-RPC request; era validation happens inside it. Our wrapper's `(request, extra)` pass-through remains signature-compatible (`extra` = v2 `ctx`).
- **Our outer wrapper's own result mutations bypass server-side result validation** (`validateToolOutput` runs inside `McpServer`'s inner handler, _before_ our mint-back append/mirror). Same layering as v1 — mint-back is added after customer-schema validation, by design. Still true on v2. ✅
- **`input_required` rounds** (2026 era): each client round re-arrives as another `tools/call` through our wrapper → one logical tool call can emit **multiple AgentCat events** with the same arguments; the intermediate `input_required` result has no `content` array (so `appendMintBack`/`mirrorStructuredMintBack` no-op safely — verified guards hold) but `event.response` will record the intermediate result and `event.duration` only the final round. Needs a product decision (dedupe? tag rounds?), not just a mechanical fix.

### 3.4 ⚠ LOW — list wrapper drops `nextCursor` / `_meta` from `tools/list` responses

Both list wrappers (`tools.ts:82-155`, `tracing.ts:83-156`) return `{ tools }` only. Pre-existing on v1, but v2 raises the stakes: v2 clients called with no cursor now **auto-aggregate every page**; a paginating server behind AgentCat has its `nextCursor` silently discarded, so v2 clients see a truncated single page believing it's the aggregate. Also drops any server-stamped list metadata (v2 SEP-2549 cache hints ride the result — `attachCacheHintFallback` in `_wrapHandler` runs _inside_ the handler we wrap for non-`tools/call` methods only if we re-register through `setRequestHandler`; a map-`.set` outer wrapper preserves it as long as we spread the original response instead of rebuilding it).

---

## 4. High-level tool wrapping (`tracingV2.ts` + `mcp-sdk-compat.ts`)

### 4.1 ❌ HIGH — v2 dispatches via `tool.executor`, making callback/handler wrapping a silent no-op

v2 `McpServer` invokes `tool.executor(args, ctx)` (`mcp.ts:333`), where `executor` is a closure created at registration (`createToolExecutor(inputSchema, handler)`, `mcp.ts:861`) capturing the handler **by value**. Replacing `tool.handler`/`tool.callback` afterward — the entire strategy of `addTracingToToolCallbackInternal`, `addTracingToToolRegistry`, and the `_registeredTools` Proxy `set` trap — changes nothing at dispatch time. Additionally `createWrappedTool`'s spread-copy (`{...tool, [key]: wrapped}`) copies the original `executor` reference, so even the copy dispatches the unwrapped handler.

What the dead callback wrapper was responsible for, and where that lands on v2:

| Responsibility                                                                | v2 outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripping injected args (`task_id`/`agent_id`/`context`) before customer code | **Partially covered by accident:** v2 validates args against the _registered_ standard schema before dispatch; default `z.object()` is strip-mode, so unknown keys vanish (verified: handler saw only `name` after we injected `task_id` + `context`). **Not covered** for passthrough/`.loose()` zod objects or permissive non-zod validators — customers' handlers would receive AgentCat's injected args (behavior regression vs v1, where we stripped). Strict schemas (`.strict()`, ArkType defaults) fail validation on injected args — but that failure mode already existed on v1 (validation always ran before our callback-level strip). |
| `__agentcat_error` stash for full stack traces on thrown tool errors          | **Lost.** `McpServer` still converts handler throws into `isError` results (`createToolError`), so error _events_ still fire from the outer wrapper, but with the flattened message-only capture (the "SDK 1.21.0+ converted error" fallback path becomes the only path).                                                                                                                                                                                                                                                                                                                                                                          |
| `update()` interception (re-wrap on callback replacement)                     | **Moot/dead** with the rest. Note v2's `update({callback})` regenerates `executor` from the new callback — so a future wrap strategy that targets `executor` must also re-hook after `update()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Also note a **copy-divergence hazard** if the registry-replacement strategy is kept on v2: `addTracingToToolRegistry` rebuilds `_registeredTools` with spread-copies, but v2's `update`/`enable`/`disable`/`remove` closures mutate the _original_ `registeredTool` object and re-index the registry by name — mutations through those closures act on objects our registry no longer serves to `tools/list`… except `tools/list` on v2 reads live from `this._registeredTools` (our replaced object), so `enabled` flips and description updates made via saved `RegisteredTool` references would silently stop being reflected. (Latent variant existed on v1; v2's richer `update` surface widens it.)

**Direction:** on v2, the per-tool callback layer should be retired; the low-level `tools/call` map wrapper is the single reliable interception point, and it must take over arg-stripping by forwarding the stripped clone (exactly what the _low-level_ path already does — `tracing.ts:275-279` passes `cloneRequestWithStrippedArguments(...)` through). The two code paths converge.

### 4.2 ⚠ MEDIUM — `_registeredTools` Proxy remains installable but loses most of its purpose

Assigning `server._registeredTools = new Proxy(...)` still works on v2 (TS-private field). The `set` trap still fires on registration (v2 assigns `this._registeredTools[name] = registeredTool`). But its two jobs — wrapping callbacks (dead per 4.1) and calling `setupListToolsTracing` on late registrations — reduce to the latter, and that call itself throws on v2 today (§3.1). After migration it remains a useful "a tool was registered, (re)arm the list wrap" signal; `deleteProperty`/rename paths (`delete this._registeredTools[name]`) pass through the trap fine.

---

## 5. Handler context: `extra` → `ctx` (`ServerContext`)

Verified v2 handler context shape at our wrapper: `{ sessionId, mcpReq, http }`, with `mcpReq = { id, method, _meta, envelope?, requestState(), inputResponses?, signal, send, notify, log, elicitInput, requestSampling }`.

### 5.1 ✅ AgentCat's own use survives

We treat `extra` as an opaque duck (`CompatibleRequestHandlerExtra`) and only pass it through; `ctx.sessionId` still exists (top-level, same key). The `(extra as any).__agentcat_error` stash pattern would still work on a plain ctx object (moot per §4.1).

### 5.2 ⚠ MEDIUM — customer-facing hook contract changes shape

`identify`, `resolveTaskId`, `eventTags`, `eventProperties` all receive `(request, extra)`. On v2 the second argument is a `ServerContext`: customers' hook code reading `extra.authInfo`, `extra.requestInfo?.headers['x']`, `extra.requestId`, `extra.sendNotification` etc. must move to `ctx.http?.authInfo`, `ctx.http?.req?.headers.get('x')` (Web `Headers`, `.get()` not bracket), `ctx.mcpReq.id`, `ctx.mcpReq.notify`. AgentCat can't absorb this (we forward verbatim), but our **docs and JSDoc examples teach the v1 shape** (`index.ts:137` example uses `extra?.requestContext?.traceId`; README/identify examples similar) and our exported `CompatibleRequestHandlerExtra` type advertises a `headers?: Record<string,…>` member that matches neither major. Documentation + typing vector.

### 5.3 ⚠ LOW — `request.params?.arguments` access unchanged

Our wrapper receives the raw JSON-RPC frame (map seam) — `params.arguments`, `params.name` unchanged on every era. 2026-era `Mcp-Param-*` header-sourced params are materialized into `params` before dispatch, and MRTR wire-only material (`requestState`, `inputResponses`) is lifted _out_ of `params` before handlers — so `extractHandle` and the strip logic see a clean args bag. ✅

---

## 6. Client identity & protocol version (`session.ts`) — the branch's own feature

### 6.1 ❌ HIGH — reserved `_meta` keys are lifted out before any handler sees them

`getClientInfoForRequest` and `getProtocolVersion` read `request.params._meta["io.modelcontextprotocol/clientInfo" | "…/protocolVersion"]`. v2's protocol layer **lifts every reserved `io.modelcontextprotocol/*` envelope key out of inbound `_meta` before dispatch, on every message, on every era** (`core-internal/src/shared/protocol.ts:181-250`). The lifted material surfaces at **`ctx.mcpReq.envelope`** (`.clientInfo`, `.protocolVersion`, `.clientCapabilities`, `.logLevel`).

On v2, therefore:

- The SEP-2575 per-request clientInfo read **always returns `undefined`** → we fall back to `getClientVersion()`.
- The `agentcat_protocol_version` tag **never populates** from `_meta`.
- The correct v2 source is `ctx.mcpReq.envelope` — i.e., the _second_ argument our functions already receive but currently ignore for this purpose. (Fallback ladder for a dual-major build: `extra?.mcpReq?.envelope?.clientInfo` → `request.params._meta[…]` (v1 passthrough) → `server.getClientVersion()`.)

### 6.2 ⚠ Fallback quality varies by serving entry (v2)

- Legacy-era connections (`initialize` handshake): `getClientVersion()` works (verified). `@deprecated` but functional through the 12-month window.
- 2026-era HTTP per-request instances (`createMcpHandler`): the entry **backfills** `getClientVersion()` from the validated envelope (`seedClientIdentityFromEnvelope`, `server.ts:207-228`) — deprecated accessor keeps answering.
- 2026-pinned stdio (`serveStdio`): `getClientVersion()` returns **`undefined`** (no `initialize` ever runs); envelope is the only source.

### 6.3 Strategic note

On v1 servers, modern clients only attach the envelope once a modern era is negotiated — which v1 can never do. So the `_meta`-reading half of this branch effectively **requires v2 support to ever fire in production**. v2 compatibility is the enabling work for the explicit-handles feature set, not an orthogonal chore.

`buildSessionInfo`'s `server._serverInfo` reads: fine on v2 (§2.2). Note v2 additionally self-stamps `io.modelcontextprotocol/serverInfo` into outbound result `_meta` on 2026-era responses — no conflict with our fields.

---

## 7. The 2026-era serving architecture (per-request servers)

### 7.1 ❌ HIGH — `createMcpHandler` constructs a fresh `McpServer` per request

`track()` assumes a long-lived server: WeakMap tracking data, injected-params registry and output registry populated by a `tools/list` and consumed by later `tools/call`s **on the same instance**. Under `createMcpHandler(() => buildServer())`:

- Customers must call `track()` **inside the factory** (per request). Nothing in our docs says so; if they track a template instance outside the factory, per-request instances are untracked.
- Per-request `track()` must be cheap and re-entrant: today it re-runs `initDiagnostics`, `TelemetryManager` construction (if exporters), and full setup each time. Module-level singletons (`eventQueue`, telemetry, diagnostics `initialized` flag) are fine; per-call overhead needs measuring.
- **The registry inference breaks structurally:** a `tools/call` arrives on an instance that never served `tools/list`, so `getInjectedParamsRegistry` is always `undefined` → fallback stripping of all three names (`handle-injection.ts:224-243`) and → "no registry ⇒ mirror anyway" structured-mint-back (`tracingV2.ts:406-421`). The caveat comment in the code ("stateless multi-instance deployments… all three rare") becomes the **default topology** of the 2026 era: a composed-outputSchema or name-collision tool that the listing instance deliberately skipped gets an undeclared `_mcp_instructions` key mirrored into `structuredContent`, and a schema-validating client rejects the whole result. The conservatism analysis needs redoing for a world where every request is a fresh instance. (Config-derived determinism helps: the registry is a pure function of options + the tool list, so it could be rebuilt on demand inside `tools/call` from `_registeredTools` instead of remembered from a prior list.)
- `serveStdio` (factory pinned per connection) is the milder variant: track-in-factory required, registry survives within a connection.

### 7.2 ✅ Session-free design aligned

No `Mcp-Session-Id` on the 2026 era; `ctx.sessionId` is `undefined` there (verified undefined even on an in-memory 2025 pair pre-initialize). This branch already removed session-state dependence in favor of explicit handles — the design is correct for the 2026 era. `publishCustomEvent`'s task-id-string path unaffected.

### 7.3 ⚠ MEDIUM — miscellaneous 2026-era behaviors to account for

- **Multi-round-trip duplicate events** (§3.3).
- **`ctx.mcpReq.log()` suppression:** on 2026 requests, handler logs need the client-supplied `logLevel` envelope key — irrelevant to us (we log to file), listed for completeness.
- **Tool-name validation** (`validateAndWarnToolName`): `get_more_tools` is a valid name. ✅
- **SEP-2243 pre-dispatch schema checks** in `createMcpHandler` validate against the _registry's_ converted schema (`toolInputSchemaJson()`), not our modified listing — injected args survive because v2's zod conversion no longer emits `additionalProperties: false` by default; re-verify during implementation for non-zod schemas.

---

## 8. Schema injection & result decoration (`handle-injection.ts`, `context-parameters.ts`, `handles.ts`)

### 8.1 ✅ The wire-level injection approach itself survives

Injection operates on `tools/list` **response JSON** (post-conversion) — schema-library-agnostic, era-agnostic. Verified compatible with v2-emitted tool descriptors. Details:

- v2 emits JSON Schema 2020-12 from zod 4; plain objects: no `additionalProperties: false` (our delete-the-`false` workaround becomes mostly moot but harmless); passthrough objects emit `additionalProperties: {}` — our injectors don't touch that, and adding properties under it is valid. ✅
- `oneOf/allOf/anyOf` skip guards: unchanged relevance. ✅
- Injected params are advertisement-only; at call time v2 validates against the **registered** schema — see §4.1 for the strip/leak/strict trichotomy (zod-strip default: silently removed before customer handler, verified).

### 8.2 ✅ Result decoration guards hold on v2 (with one ordering caveat)

- `appendMintBack` requires `content` array → no-ops safely on `input_required` results and any exotic result families. ✅
- `mirrorStructuredMintBack` requires plain-object `structuredContent` → correctly skips SEP-2106 non-object values (`null`/`0`/arrays/strings now legal). ✅ Note the mirror's presence-check semantics differ from v2's (`=== undefined`), but since we only _extend_ objects, no conflict.
- Ordering: our decoration runs **after** `McpServer`'s `validateToolOutput` and `projectCallToolResult` (SEP-2106 projection) but **before** the era codec's encode seam. Wire results on the 2025 era with wrapped non-object roots (`{result: …}`) present as objects — mirroring into that envelope would add `_mcp_instructions` beside `result`, an undeclared key under the codec-wrapped schema advertised to that client. Edge case (non-object outputSchema roots are new in v2); flag for the migration's test matrix.
- Client-side acceptance of the mirror depends on the outputSchema injection having happened at list time — any partial-failure state where the call wrap works but the list wrap doesn't (v2 today; also §7.1's fresh-instance topology) risks validating-client rejections. Migration must keep list-wrap and mirror gating **atomic**.

### 8.3 ✅ `get_more_tools` synthetic tool

Never registered with the SDK — answered directly in our wrappers on both paths, including tracing-off mode. No v2 interaction. Annotations block remains spec-valid. ✅

---

## 9. Error semantics (`exceptions.ts`, event capture)

- No `McpError`/`StreamableHTTPError` imports or `instanceof` checks anywhere in `src/` → the ProtocolError/SdkError/SdkHttpError reshuffle does not touch us directly. ✅
- `isToolResultError` duck-check (`result.isError === true`): unchanged shape on v2. ✅
- **Unknown/disabled tools now throw** `ProtocolError(-32602)` (v2) instead of resolving `isError` results in some v1 paths — our wrappers' catch branch already publishes thrown-error events, so capture survives; but error _taxonomy_ dashboards will see these shift from tool-result errors to thrown JSON-RPC errors. ⚠ telemetry-classification note.
- Stack-trace fidelity regression from the dead `__agentcat_error` seam — see §4.1.
- `captureException(result)` on converted errors: unchanged.

---

## 10. Tests, CI, and tooling

- **Every test file** imports v1 paths (`@modelcontextprotocol/sdk/server/mcp.js`, `/client/index.js`, `/inMemory.js`, …) and the harness (`test-utils/client-server-factory.ts`) builds v1 servers/clients. None of it compiles against v2 names. Because the majors coexist under different names, the right structure is **additive**: keep the v1 matrix (`mcp-version-compatibility.test.ts` currently validates 1.11→1.30 behaviors like `callback`→`handler`) and add a v2 harness (`@modelcontextprotocol/server` + `/client` devDependencies, `zod@^4.2` — possibly via an npm alias to keep the zod-3 harness paths intact).
- **In-memory testing limits:** v2 `InMemoryTransport.createLinkedPair()` connects 2025-era instances only; 2026-era behavior (envelope identity, per-request instances, MRTR rounds) must be tested by driving `createMcpHandler(...).fetch(new Request(...))` in-process (upstream-recommended pattern). Both `InMemoryTransport` halves must come from the _same_ v2 package (`client` or `server` — they bundle separate copies).
- **`esm-consumer.test.ts` / packaging tests** should gain the two probe scenarios this audit ran: (a) v2-only install → import must not crash (the §1.1 acceptance test), (b) v1+v2 coexistence → `track()` of each server flavor.
- **Repo tooling greps:** `pnpm.overrides` comment pins `body-parser … via @modelcontextprotocol/sdk` — a v1-transitive that disappears for v2; harmless but part of the §1 sweep. No other literal `@modelcontextprotocol/sdk` gates found outside `src/`/`package.json`/`dist`.

---

## 11. Documentation & developer-facing copy

- README + `index.ts` JSDoc: every example is v1-idiom (`new Server(...)`, `setRequestHandler(ListToolsRequestSchema, …)`, `extra` shapes). Needs v2 twins, including the **track-inside-factory** pattern for `createMcpHandler`/`serveStdio` (§7.1) and the ctx-shape guidance for hooks (§5.2).
- Compatibility error messages: rewrite so an SDK-_too-new_ situation never says "upgrade to v1.11+" (§2.1).
- Multi-instance/no-registry caveat docs (README, this branch) assume stateless deployments are rare — revise for the 2026 era (§7.1).

---

## 12. Verified-working inventory (what does _not_ need to change)

| Mechanism                                                                               | v2 status                                                                           |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `WeakMap` keying on the low-level server object (`internal.ts`, registries)             | ✅ works (same object identity through `McpServer.server`)                          |
| Direct `_requestHandlers.get('tools/call')` / `.set(...)` wrap                          | ✅ **verified end-to-end on v2 GA** — the go-forward injection seam for both majors |
| Reading `_serverInfo`, `_capabilities`, `getClientVersion()`, `_registeredTools`        | ✅ all present (TS-private)                                                         |
| Handler pass-through arity `(request, extra)`                                           | ✅ `ctx` slots in as `extra`                                                        |
| Mint-back text append & structured mirror mechanics                                     | ✅ verified on v2 results (guards hold)                                             |
| Event pipeline, redaction, truncation, KSUID, telemetry exporters, `publishCustomEvent` | ✅ SDK-independent                                                                  |
| zod-internals introspection (`getObjectShape`/`getLiteralValue`)                        | ✅ irrelevant on v2 (method strings) — retire rather than port                      |

---

## 13. Migration-shape summary (direction only — no fixes in this audit)

1. **Detach from the v1 package at module scope** (§1.1): eliminate top-level runtime imports; inline the two request-schema uses or route all registration through the map seam on both majors. Target: agentcat imports **zero** SDK modules.
2. **Version-aware adapter** at `track()` entry (§2.1): discriminate v1/v2 (e.g. `.tool` presence, or first-arg-type feature detection) and fix the error copy.
3. **Converge interception on the low-level `tools/call`/`tools/list` map wrap** for both majors (§3, §4): method strings on v2; stripping moves into the outer wrapper (as the low-level path already does); retire the per-tool callback wrap, the `_registeredTools` re-wrap, and the Zod-introspecting `setRequestHandler` patch (replace with an arity-and-type-aware patch or drop the patch in favor of registration-signal-driven re-arming).
4. **Read client identity/protocol version from `ctx.mcpReq.envelope`** with v1 `_meta` and `getClientVersion()` fallbacks (§6).
5. **Design for per-request servers** (§7): track-in-factory docs, cheap re-entrant setup, registry rebuild-on-demand instead of remember-from-listing, revisit the mirror-anyway conservatism.
6. **Packaging** (§1.2/1.3): optional-peer both majors (or no peer), fix diagnostics version probing for v2's sealed `exports`.
7. **Test matrix** (§10): additive v2 harness incl. 2026-era `createMcpHandler.fetch` in-process tests and the two packaging probes.
8. **Product decisions needed:** MRTR round dedupe/tagging (§3.3), error-taxonomy shift (§9), `nextCursor` pass-through (§3.4).

---

## Appendix A — empirical probe transcript (summarized)

Environment: Node 22.23.1, npm registry packages `@modelcontextprotocol/server@2.0.0`, `@modelcontextprotocol/client@2.0.0`, `zod@4.x`; agentcat `dist/` from this branch installed as `node_modules/agentcat`.

1. **v2-only install, `import 'agentcat'`** → `ERR_MODULE_NOT_FOUND: Cannot find package '@modelcontextprotocol/sdk' imported from …/agentcat/dist/index.mjs`. (Control: importing the dist by absolute path from inside this repo _succeeds_ because Node resolves the v1 devDependency from the repo's own `node_modules` — masking the failure in local dev.)
2. **`track(v2 McpServer)`** (v1 SDK also installed) → log: `Failed to track server - … High-level server must have tool() method. This requires MCP SDK v1.11 or higher.`; server returned untracked. Introspection: `.tool` undefined; `_registeredTools`, `_requestHandlers` (Map, keys `ping, initialize, tools/list, tools/call` — eager install), `_serverInfo`, `getClientVersion`, `_capabilities` all present.
3. **`track(v2 low-level Server)`** → logs `Warning: Failed to override list tools handler - TypeError: '[object Object]' is not a spec request method…` (×1) and `Warning: Failed to setup tool call tracing - TypeError: …` (×2), then `AgentCat setup complete`; neither handler replaced (map identity unchanged).
4. **Manual v2-style wrap** (`_requestHandlers.get/set` on `'tools/call'`) + real `Client` over `InMemoryTransport`, calling a zod-schema tool with injected `task_id`/`context` args → wrapper observed raw args and ctx (`{sessionId, mcpReq, http}`); customer handler received only its declared `name` arg (zod strip-mode removed the injected keys); mint-back text block delivered to the client in the result. `getClientVersion()` returned the client's info (legacy-era handshake); `request.params._meta` was `undefined` at the handler.

## Appendix B — v2 source references consulted

- `packages/core-internal/src/shared/protocol.ts` — `_requestHandlers` (l.561), dispatch (l.1006), `setRequestHandler` overloads + TypeError (l.1670-1740), `_wrapHandler` seam (l.1745), reserved-key lift (l.181-250), `BaseContext`/`mcpReq` incl. `envelope` (l.330-395).
- `packages/server/src/server/server.ts` — `_serverInfo`/`_capabilities`/`_clientVersion`/`getClientVersion` (l.263-1018), `seedClientIdentityFromEnvelope` (l.207-228), `_wrapHandler` tools/call validation + MRTR driver (l.472-540).
- `packages/server/src/server/mcp.ts` — `_registeredTools` (l.76), eager `setToolRequestHandlers` (l.118-126, 161-238), `tools/call` handler + `validateToolInput`/`validateToolOutput`/`executeToolHandler`→`tool.executor` (l.210-333), `_createRegisteredTool`/`executor` capture/`update()` regen (l.805-920).
- `packages/core-internal/src/shared/envelope.ts` — envelope claim/validation model.
- `docs/migration/upgrade-to-v2.md` (1855 lines) & `docs/migration/support-2026-07-28.md` (709 lines) — read in full; §"Import-less (injected) SDK surfaces", §"Library authors", §"Server (McpServer…) behavior", §"createMcpHandler", §"Server identity in result `_meta`" most load-bearing for AgentCat.
