<div align="center">
  <img alt="AgentCat — see exactly how agents experience your product" src="docs/static/og-image.png" width="80%">
</div>
<h3 align="center">
    <a href="#getting-started">Getting Started</a>
    <span> · </span>
    <a href="#why-use-agentcat-">Features</a>
    <span> · </span>
    <a href="https://docs.agentcat.com">Docs</a>
    <span> · </span>
    <a href="https://agentcat.com">Website</a>
    <span> · </span>
    <a href="#free-for-open-source">Open Source</a>
    <span> · </span>
    <a href="https://meet.agentcat.com/meet">Schedule a Demo</a>
</h3>
<p align="center">
  <a href="https://badge.fury.io/js/agentcat"><img src="https://badge.fury.io/js/agentcat.svg" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/agentcat"><img src="https://img.shields.io/npm/dm/agentcat.svg" alt="npm downloads"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg" alt="TypeScript"></a>
  <a href="https://github.com/agentcathq/agentcat-typescript-sdk/issues"><img src="https://img.shields.io/github/issues/agentcathq/agentcat-typescript-sdk.svg" alt="GitHub issues"></a>
  <a href="https://github.com/agentcathq/agentcat-typescript-sdk/actions"><img src="https://github.com/agentcathq/agentcat-typescript-sdk/workflows/CI/badge.svg" alt="CI"></a>
</p>

> [!NOTE]
> Looking for the Python SDK? Check it out here [agentcat-python](https://github.com/agentcathq/agentcat-python-sdk).

AgentCat is an analytics platform for MCP server owners 🐱. It captures user intentions and behavior patterns to help you understand what AI users actually need from your tools — eliminating guesswork and accelerating product development all with one-line of code.

This SDK also provides a free and simple way to forward telemetry like logs, traces, and errors to any Open Telemetry collector or popular tools like Datadog, Sentry, and PostHog.

```bash
npm install -S agentcat
```

To learn more about us, check us out [here](https://agentcat.com). For detailed guides visit our [documentation](https://docs.agentcat.com).

## Why use AgentCat? 🤔

AgentCat helps developers and product owners build, improve, and monitor their MCP servers by capturing user analytics and tracing tool calls.

Use AgentCat for:

- **User session replay** 🎬. Follow alongside your users to understand why they're using your MCP servers, what functionality you're missing, and what clients they're coming from.
- **Trace debugging** 🔍. See where your users are getting stuck, track and find when LLMs get confused by your API, and debug sessions across all deployments of your MCP server.
- **Existing platform support** 📊. Get logging and tracing out of the box for your existing observability platforms (OpenTelemetry, Datadog, Sentry) — eliminating the tedious work of implementing telemetry yourself.

<img alt="AgentCat architecture — the AgentCat SDK inside your MCP server sends analytics to your observability vendors and session replay to the AgentCat dashboard" src="docs/static/architecture.png" />

## Getting Started

To get started with AgentCat, first create an account and obtain your project ID by signing up at [agentcat.com](https://agentcat.com). For detailed setup instructions visit our [documentation](https://docs.agentcat.com).

Once you have your project ID, integrate AgentCat into your MCP server:

```ts
import * as agentcat from "agentcat";

const mcpServer = new Server({ name: "echo-mcp", version: "0.1.0" });

// Track the server with AgentCat
agentcat.track(mcpServer, "proj_0000000");

// Register your tools
```

### Identifying users

You can identify your user sessions with a simple callback AgentCat exposes, called `identify`.

```ts
agentcat.track(mcpServer, "proj_0000000", {
  identify: async (request, extra) => {
    const user = await myapi.getUser(request.params.arguments.token);
    return {
      userId: user.id,
      userName: user.name,
      userData: { favoriteColor: user.favoriteColor },
    };
  },
});
```

### Redacting sensitive data

AgentCat redacts all data sent to its servers and encrypts at rest, but for additional security, it offers a hook to do your own redaction on all text data returned back to our servers.

```ts
agentcat.track(mcpServer, "proj_0000000", {
  redactSensitiveInformation: async (text) => await redact(text),
  // or
  redactSensitiveInformation: (text) => redact(text),
});
```

### Existing Platform Support

AgentCat seamlessly integrates with your existing observability stack, providing automatic logging and tracing without the tedious setup typically required. Export telemetry data to multiple platforms simultaneously:

```typescript
agentcat.track(server, "proj_0000", {
  // Project ID can optionally be "null" if you just want to forward telemetry
  exporters: {
    otlp: {
      type: "otlp",
      endpoint: "http://localhost:4318/v1/traces",
    },
    datadog: {
      type: "datadog",
      apiKey: process.env.DD_API_KEY,
      site: "datadoghq.com",
      service: "my-mcp-server",
    },
    sentry: {
      type: "sentry",
      dsn: process.env.SENTRY_DSN,
      environment: "production",
    },
    posthog: {
      type: "posthog",
      apiKey: process.env.POSTHOG_API_KEY,
      host: "https://us.i.posthog.com", // Optional: defaults to US region
    },
  },
});
```

Learn more about our free and open source [telemetry integrations](https://docs.agentcat.com/telemetry/integrations).

### Internal diagnostics

To help us catch and fix broken installs, the SDK sends AgentCat a small, anonymized
signal when setup or runtime errors occur — never your tool calls, your responses,
or anything about your users. Records carry only operational metadata, such as your
project ID (or an anonymous install ID when none is set). Your local `~/agentcat.log`
is unchanged.

Diagnostics are on by default and can be turned off completely with either:

- `track(server, projectId, { disableDiagnostics: true })`, or
- the `DISABLE_DIAGNOSTICS` environment variable.

## Free for open source

AgentCat is free for qualified open source projects. We believe in supporting the ecosystem that makes MCP possible. If you maintain an open source MCP server, you can access our full analytics platform at no cost.

**How to apply**: Email hi@agentcat.com with your repository link

_Already using AgentCat? We'll upgrade your account immediately._

## Community Cats 🐱

Meet the cats behind AgentCat! Add your cat to our community by submitting a PR with your cat's photo in the `docs/cats/` directory.

<div align="left">
  <img src="docs/cats/bibi.png" alt="bibi" width="80" height="80">
  <img src="docs/cats/zelda.jpg" alt="zelda" width="80" height="80">
</div>

_Want to add your cat? Create a PR adding your cat's photo to `docs/cats/` and update this section!_
