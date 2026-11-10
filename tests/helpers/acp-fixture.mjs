// Protocol fixture: crosses the real ACP and stdio MCP boundaries without model access.
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let session;
let client;
const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (id, result) => send({ id, result });
const text = (value) =>
  send({
    method: "session/update",
    params: {
      sessionId: "fixture",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } },
    },
  });
process.once("SIGTERM", () => {
  void client?.close().finally(() => process.exit(0));
});
createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  try {
    switch (message.method) {
      case "initialize":
        reply(message.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] });
        break;
      case "session/new":
        session = message.params;
        reply(message.id, { sessionId: "fixture" });
        break;
      case "session/cancel":
        break;
      case "session/prompt": {
        if (process.argv.includes("--hang")) break;
        const server = session.mcpServers[0];
        client = new Client({ name: "fixture", version: "1.0" });
        await client.connect(
          new StdioClientTransport({
            command: server.command,
            args: server.args,
            env: {
              ...process.env,
              ...Object.fromEntries(server.env.map((item) => [item.name, item.value])),
            },
            stderr: "ignore",
          }),
        );
        const { tools } = await client.listTools();
        const name = tools.some((tool) => tool.name === "finish_task")
          ? "finish_task"
          : tools.some((tool) => tool.name === "remember_fact")
            ? "remember_fact"
            : "openmuse_probe";
        const args =
          name === "finish_task"
            ? { summary: "ACP fixture completed the requested task" }
            : { text: "I prefer morning meetings" };
        text("Calling the application tool. ");
        const result = await client.callTool({ name, arguments: args });
        text(JSON.stringify(result));
        await client.close();
        reply(message.id, { stopReason: "end_turn" });
        break;
      }
      default:
        reply(message.id, {});
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32603, message: error.message } });
  }
});
