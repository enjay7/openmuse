// Small stdio process launched by the ACP provider. The server owns the tool
// executors; this process only forwards to a per-run, authenticated loopback URL.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const endpoint = process.env.OPENMUSE_TOOL_URL;
const token = process.env.OPENMUSE_TOOL_TOKEN;
if (!endpoint || !token) throw new Error("Missing OpenMuse tool bridge configuration");
async function request(path, body) {
  const response = await fetch(`${endpoint}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`OpenMuse tool bridge returned ${response.status}`);
  return response.json();
}
const server = new Server({ name: "openmuse", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => request("list", {}));
server.setRequestHandler(CallToolRequestSchema, (input) => request("call", input.params));
await server.connect(new StdioServerTransport());
