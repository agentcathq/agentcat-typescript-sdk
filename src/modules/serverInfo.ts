import {
  PublishServerInfoRequest,
  ResponseError,
  ServerInfoApi,
} from "agentcat-api";
import { AgentCatData, MCPServerLike, RedactFunction } from "../types.js";
import { writeToLog } from "./logging.js";
import { getServerTrackingData } from "./internal.js";
import { registerBackgroundTask } from "./backgroundTasks.js";
import { getEngineState } from "../engine/registry.js";
import { buildInjectedList } from "../engine/listWrap.js";
import { GET_MORE_TOOLS_NAME } from "./tools.js";
import { redactStrings } from "./redaction.js";
import { eventQueue } from "./eventQueue.js";

/**
 * The server info heartbeat: about once an hour, a handled request starts a
 * background task that calls the server's own list handlers with the context
 * of that request and sends what an agent sees to AgentCat.
 *
 * The only state is `attempts` and `firstCheckAt`, both times in the memory
 * of this process or isolate. Neither holds a promise or an object of a
 * request, because a Cloudflare Workers request cannot use the objects of an
 * earlier one. When the memory is gone the SDK simply sends again.
 */

export type ServerInfoTrigger = "tools/list" | "feedback" | "tools/call";

export type ServerInfoSender = (
  body: PublishServerInfoRequest,
  signal: AbortSignal,
) => Promise<void>;

const ATTEMPT_INTERVAL_MS = 3_600_000;
/**
 * A memory younger than this counts as no memory: a runtime that keeps none
 * between requests must not send for every tool call.
 */
const MEMORY_MIN_AGE_MS = 60_000;
const MAX_ATTEMPT_KEYS = 1_000;
const LIST_TIME_LIMIT_MS = 5_000;
const MAX_LIST_PAGES = 100;
const BUILD_TIME_LIMIT_MS = 30_000;
const SEND_TIME_LIMIT_MS = 10_000;

const OTHER_LISTS = [
  { key: "resources", method: "resources/list" },
  { key: "resourceTemplates", method: "resources/templates/list" },
  { key: "prompts", method: "prompts/list" },
] as const;

const attempts = new Map<string, number>();
let firstCheckAt: number | undefined;

/**
 * The base URL, headers and HTTP client of the event send. The raw call
 * leaves the body of a 2xx answer unread: the answer needs no parsing.
 */
const sendWithApiClient: ServerInfoSender = async (body, signal) => {
  await new ServerInfoApi(
    eventQueue.getApiConfiguration(),
  ).publishServerInfoRaw({ publishServerInfoRequest: body }, { signal });
};

let sender: ServerInfoSender = sendWithApiClient;

/** Replaces the sender; no argument restores the API client sender. */
export function setServerInfoSender(next?: ServerInfoSender): void {
  sender = next ?? sendWithApiClient;
}

/**
 * Empties the heartbeat memory. A test passes `firstCheck` to give the memory
 * an age.
 */
export function resetServerInfoStateForTests(firstCheck?: number): void {
  attempts.clear();
  firstCheckAt = firstCheck;
}

/** Called after a tools/list request has settled. Never throws. */
export function checkServerInfoOnToolList(
  server: MCPServerLike,
  extra: unknown,
): void {
  check(server, extra, () => "tools/list");
}

/** Called after a tools/call request has settled. Never throws. */
export function checkServerInfoOnToolCall(
  server: MCPServerLike,
  request: any,
  extra: unknown,
): void {
  check(server, extra, (data) =>
    data.options.enableReportMissing === true &&
    request?.params?.name === GET_MORE_TOOLS_NAME
      ? "feedback"
      : "tools/call",
  );
}

/**
 * The check on the request path. It reads memory only: no I/O and no
 * customer code. The background task it starts gives way first, so no list
 * handler runs before the result of the request is on its way.
 */
function check(
  server: MCPServerLike,
  extra: unknown,
  triggerOf: (data: AgentCatData) => ServerInfoTrigger,
): void {
  try {
    const now = Date.now();
    if (firstCheckAt === undefined) firstCheckAt = now;

    const data = getServerTrackingData(server);
    if (!data || !data.projectId || data.options.enableTracing === false) {
      return;
    }
    if (
      triggerOf(data) === "tools/call" &&
      now - firstCheckAt < MEMORY_MIN_AGE_MS
    ) {
      return;
    }
    const key = `${data.projectId}\u0000${server._serverInfo?.name ?? ""}`;
    const lastAttempt = attempts.get(key);
    if (lastAttempt !== undefined && now - lastAttempt < ATTEMPT_INTERVAL_MS) {
      return;
    }
    if (lastAttempt === undefined && attempts.size >= MAX_ATTEMPT_KEYS) {
      attempts.clear();
    }
    attempts.set(key, now);

    const task = runHeartbeat(server, data, extra).catch((error) => {
      writeToLog(`Server info heartbeat failed: ${error}`);
    });
    registerBackgroundTask(task);
  } catch (error) {
    try {
      writeToLog(`Server info check failed: ${error}`);
    } catch {
      // The log is best effort; the request must never see this.
    }
  }
}

async function runHeartbeat(
  server: MCPServerLike,
  data: AgentCatData,
  extra: unknown,
): Promise<void> {
  await giveWay();
  let body: PublishServerInfoRequest | undefined;
  try {
    body = await withTimeLimit(
      buildBody(server, data, extra),
      BUILD_TIME_LIMIT_MS,
    );
  } catch (error) {
    writeToLog(`Server info skipped: the build stopped - ${error}`);
    return;
  }
  if (!body) return;
  await send(body);
}

/**
 * One POST. A 413 gets one more POST without the tool schemas; any other
 * failure ends the attempt.
 */
async function send(body: PublishServerInfoRequest): Promise<void> {
  if ((await post(body)) !== 413) return;
  if ((await post(withoutToolSchemas(body))) === 413) {
    writeToLog("Server info not sent: the body is too large");
  }
}

/** Gives the status of a failed POST, or "sent". */
async function post(
  body: PublishServerInfoRequest,
): Promise<number | "sent" | "no answer"> {
  const controller = new AbortController();
  try {
    await withTimeLimit(
      sender(body, controller.signal),
      SEND_TIME_LIMIT_MS,
      () => controller.abort(),
    );
  } catch (error) {
    if (error instanceof ResponseError) {
      const status = error.response.status;
      writeToLog(`Server info not sent: status ${status}`);
      return status;
    }
    writeToLog(`Server info not sent: ${error}`);
    return "no answer";
  }
  const tools = (body.features as { tools?: unknown[] } | undefined)?.tools;
  writeToLog(
    `Server info sent | ${tools?.length ?? 0} tools | ${byteLength(body)} bytes`,
  );
  return "sent";
}

function withoutToolSchemas(
  body: PublishServerInfoRequest,
): PublishServerInfoRequest {
  const features = body.features as Record<string, unknown[]>;
  const tools = features.tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const {
      inputSchema: _inputSchema,
      outputSchema: _outputSchema,
      ...rest
    } = tool as Record<string, unknown>;
    return rest;
  });
  return { ...body, features: { ...features, tools } };
}

function byteLength(body: PublishServerInfoRequest): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

async function buildBody(
  server: MCPServerLike,
  data: AgentCatData,
  extra: unknown,
): Promise<PublishServerInfoRequest | undefined> {
  const features: Record<string, unknown[]> = {};
  try {
    features.tools = await collectTools(server, data, extra);
  } catch (error) {
    writeToLog(`Server info skipped: the tool list failed - ${error}`);
    return undefined;
  }

  for (const { key, method } of OTHER_LISTS) {
    const handler = server._requestHandlers.get(method);
    if (!handler) continue;
    try {
      features[key] = await collectList(key, (params) =>
        handler({ method, params }, extra as any),
      );
    } catch (error) {
      writeToLog(`Server info leaves out ${key}: ${method} failed - ${error}`);
    }
  }

  const info = server._serverInfo as { title?: unknown } | undefined;
  const instructions = (server as { _instructions?: unknown })._instructions;
  const body = {
    projectId: data.projectId,
    serverName: server._serverInfo?.name,
    serverVersion: server._serverInfo?.version,
    serverTitle: typeof info?.title === "string" ? info.title : "",
    instructions: typeof instructions === "string" ? instructions : "",
    features,
  };

  const redactFn = data.options.redactSensitiveInformation;
  if (!redactFn) return body;
  try {
    return await redactBody(body, redactFn);
  } catch (error) {
    writeToLog(`Server info skipped: the redaction function failed - ${error}`);
    return undefined;
  }
}

/** Item keys that name a list item; the redaction function skips them. */
const ITEM_NAME_KEYS: ReadonlySet<string> = new Set([
  "name",
  "uri",
  "uriTemplate",
]);

async function redactBody(
  body: PublishServerInfoRequest & { features: Record<string, unknown[]> },
  redactFn: RedactFunction,
): Promise<PublishServerInfoRequest> {
  const strict: RedactFunction = async (text) => {
    const redacted = await redactFn(text);
    if (typeof redacted !== "string") {
      throw new Error("the redaction function gave no string");
    }
    return redacted;
  };
  const features: Record<string, unknown[]> = {};
  for (const [key, items] of Object.entries(body.features)) {
    features[key] = [];
    for (const item of items) {
      features[key].push(await redactStrings(item, strict, ITEM_NAME_KEYS));
    }
  }
  return {
    ...body,
    serverTitle: await strict(body.serverTitle ?? ""),
    instructions: await strict(body.instructions ?? ""),
    features,
  };
}

/**
 * The tool list as a client gets it: every page of the customer's handler,
 * joined, then the SDK's own injection run once over the whole list.
 */
async function collectTools(
  server: MCPServerLike,
  data: AgentCatData,
  extra: unknown,
): Promise<unknown[]> {
  const originalList = getEngineState(server)?.originalList;
  if (!originalList) throw new Error("no tools/list handler");
  const tools = await collectList("tools", (params) =>
    originalList({ method: "tools/list", params }, extra),
  );
  return buildInjectedList(data, tools).tools;
}

/**
 * Follows `nextCursor` until no cursor comes back. Fails on a repeated
 * cursor, on more than MAX_LIST_PAGES pages and after LIST_TIME_LIMIT_MS.
 */
function collectList(
  itemsKey: string,
  fetchPage: (params: { cursor?: string }) => Promise<any>,
): Promise<any[]> {
  const pages = (async () => {
    const items: any[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await fetchPage(cursor === undefined ? {} : { cursor });
      const pageItems = result?.[itemsKey];
      if (!Array.isArray(pageItems)) {
        throw new Error(`the result has no ${itemsKey} array`);
      }
      items.push(...pageItems);
      const next = result?.nextCursor;
      if (next === undefined || next === null || next === "") return items;
      if (typeof next !== "string" || cursors.has(next)) {
        throw new Error("the list repeats a cursor");
      }
      cursors.add(next);
      cursor = next;
    }
    throw new Error(`the list has more than ${MAX_LIST_PAGES} pages`);
  })();
  return withTimeLimit(pages, LIST_TIME_LIMIT_MS);
}

/**
 * Settles with `work`, or rejects after `ms`. The timer is cleared as soon as
 * either side settles, and the abandoned work can never surface as an
 * unhandled rejection.
 */
function withTimeLimit<T>(
  work: Promise<T>,
  ms: number,
  onTimeout?: () => void,
): Promise<T> {
  work.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`no answer within ${ms} ms`));
    }, ms);
    unrefTimer(timer);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * Resolves on a zero-delay timer. The heartbeat starts from the `finally` of
 * a wrapper; waiting for a timer lets every microtask run first, so the MCP
 * library has taken the result of the request and handed it to the transport
 * before any list handler is entered. The timer belongs to the heartbeat
 * task of this request: the task awaits it, so it fires before that task
 * settles (on Cloudflare Workers, inside the `waitUntil` of this request).
 */
function giveWay(): Promise<void> {
  return new Promise((resolve) => {
    unrefTimer(setTimeout(resolve, 0));
  });
}

/** A heartbeat timer never holds a Node process open. */
function unrefTimer(timer: unknown): void {
  (timer as { unref?: () => void } | undefined)?.unref?.();
}
