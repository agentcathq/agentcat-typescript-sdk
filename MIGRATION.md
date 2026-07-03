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
