import type { PublishServerInfoRequest } from "agentcat-api";
import type { ServerInfoSender } from "../../modules/serverInfo.js";

type Responder = (
  body: PublishServerInfoRequest,
  signal: AbortSignal,
) => Promise<void>;

/**
 * Stands in for the server info sender in every test: it records each body
 * and sends nothing. A test can script the answer with `respond`.
 */
class ServerInfoRecorder {
  bodies: PublishServerInfoRequest[] = [];
  respond: Responder = async () => {};

  readonly sender: ServerInfoSender = (body, signal) => {
    this.bodies.push(body);
    return this.respond(body, signal);
  };

  reset(): void {
    this.bodies = [];
    this.respond = async () => {};
  }
}

export const serverInfoRecorder = new ServerInfoRecorder();
