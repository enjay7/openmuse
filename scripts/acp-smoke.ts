import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType } from "@ag-ui/core";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import { readConfig } from "../apps/server/src/config.ts";
import { AcpAgent } from "../apps/server/src/engine/acp-agent.ts";

const config = readConfig();
const code = randomUUID();
let calls = 0;
const agent = new AcpAgent(config, {
  model: "unused",
  maxSteps: 3,
  prompt: "You are testing the OpenMuse ACP bridge. Call openmuse_probe and quote its result.",
  tools: [
    defineTool({
      name: "openmuse_probe",
      description: "Get the verification code for this ACP smoke test.",
      parameters: z.object({}),
      execute: async () => {
        calls++;
        return { code };
      },
    }),
  ],
});
const events: BaseEvent[] = [];
await new Promise<void>((resolve, reject) =>
  agent
    .run({
      threadId: randomUUID(),
      runId: randomUUID(),
      messages: [
        {
          id: randomUUID(),
          role: "user",
          content: "Call openmuse_probe and quote the verification code.",
        },
      ],
      state: {},
      tools: [],
      context: [],
      forwardedProps: {},
    })
    .subscribe({ next: (event) => events.push(event), complete: resolve, error: reject }),
);
const error = events.find((event) => event.type === EventType.RUN_ERROR);
assert.equal(error, undefined, JSON.stringify(error));
assert.ok(calls > 0, "The provider did not execute the OpenMuse MCP tool");
assert.ok(
  events.some((event) => event.type === EventType.TOOL_CALL_RESULT),
  "No AG-UI tool result",
);
assert.ok(
  events.some((event) => event.type === EventType.RUN_FINISHED),
  "No run completion",
);
const text = events
  .flatMap((event) =>
    event.type === EventType.TEXT_MESSAGE_CONTENT ? [(event as { delta: string }).delta] : [],
  )
  .join("");
assert.ok(text.includes(code), "The provider did not quote the returned verification code");
console.log(`${config.acpProvider} ACP verified: local CLI → OpenMuse MCP tool → streamed reply.`);
