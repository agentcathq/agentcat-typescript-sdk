import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

/**
 * Connects a real v2 Client to the given (Mcp)Server over an in-memory
 * linked pair. Both transport halves come from @modelcontextprotocol/client
 * deliberately — the v2 packages bundle separate InMemoryTransport copies
 * and a linked pair must come from ONE package.
 */
export async function connectClient(server: {
  connect(t: unknown): Promise<void>;
}): Promise<Client> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agentcat-test-client", version: "1.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

/**
 * Extracts the SDK-authored [session_id …] text block from a result. The
 * block is prepended as the FIRST content element; reading only content[0]
 * makes every consumer of this helper assert the placement too.
 */
export const mintBackOf = (result: any): string | undefined => {
  const first = (result.content as any[])[0];
  return first?.type === "text" && first.text.startsWith("[session_id")
    ? first.text
    : undefined;
};

/** Reads `name: <value>` out of a mint-back block. */
export const handleFrom = (text: string, name: string): string =>
  new RegExp(`${name}: (\\S+)`).exec(text)![1];
