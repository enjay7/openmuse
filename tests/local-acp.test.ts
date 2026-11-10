import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AbstractAgent } from "@ag-ui/client";
import { type BaseEvent, EventType, type RunAgentInput } from "@ag-ui/core";
import { defineTool } from "@copilotkit/runtime/v2";
import { Observable } from "rxjs";
import { z } from "zod";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { AcpAgent } from "../apps/server/src/engine/acp-agent.ts";
import { LocalThreads } from "../apps/server/src/local-threads.ts";

const fixture = fileURLToPath(new URL("./helpers/acp-fixture.mjs", import.meta.url));
const input: RunAgentInput = {
  threadId: "test-thread",
  runId: "test-run",
  messages: [{ id: "user", role: "user", content: "Remember I prefer morning meetings" }],
  tools: [],
  state: {},
  context: [],
  forwardedProps: {},
};
const config = (directory: string): Config => ({
  mode: "sample",
  host: "127.0.0.1",
  port: 8787,
  publicUrl: "http://localhost:8787",
  dataDir: directory,
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: [],
  agentBackend: "acp",
  threadStorage: "local",
  acpCommand: process.execPath,
  acpArgs: [fixture],
  acpTimeoutMs: 10_000,
  webSearchEnabled: false,
});
async function collect(events: Observable<BaseEvent>) {
  const result: BaseEvent[] = [];
  await new Promise<void>((resolve, reject) =>
    events.subscribe({
      next: (event) => result.push(event),
      complete: resolve,
      error: reject,
    }),
  );
  return result;
}

test("ACP crosses stdio MCP, validates args, executes tools, and streams original tool names", async () => {
  let invoked = 0;
  const agent = new AcpAgent(config(".openmuse"), {
    model: "unused",
    maxSteps: 3,
    prompt: "Application instructions",
    tools: [
      defineTool({
        name: "openmuse_probe",
        description: "fixture",
        parameters: z.object({ text: z.string() }),
        execute: async (args) => {
          invoked++;
          return { received: args.text };
        },
      }),
    ],
  });
  const events = await collect(agent.run(input));
  assert.equal(invoked, 1);
  assert.equal(
    events.some((event) => event.type === EventType.RUN_ERROR),
    false,
  );
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.TOOL_CALL_START && event.toolCallName === "openmuse_probe",
    ),
  );
  assert.ok(events.some((event) => event.type === EventType.TOOL_CALL_RESULT));
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
});

test("an invalid tool call never reaches the application executor", async () => {
  let invoked = 0;
  const agent = new AcpAgent(config(".openmuse"), {
    model: "unused",
    maxSteps: 3,
    prompt: "",
    tools: [
      defineTool({
        name: "openmuse_probe",
        description: "fixture",
        parameters: z.object({ count: z.number() }),
        execute: async () => {
          invoked++;
          return {};
        },
      }),
    ],
  });
  const events = await collect(agent.run(input));
  assert.equal(invoked, 0);
  assert.ok(JSON.stringify(events).includes("Invalid OpenMuse tool arguments"));
});

test("a wedged ACP provider times out and completes with a useful error", async () => {
  const agent = new AcpAgent(
    {
      ...config(".openmuse"),
      acpArgs: [fixture, "--hang"],
      acpTimeoutMs: 1000,
    },
    { model: "unused", maxSteps: 3, prompt: "", tools: [] },
  );
  const events = await collect(agent.run(input));
  assert.ok(
    events.some(
      (event) =>
        event.type === EventType.RUN_ERROR &&
        typeof event.message === "string" &&
        event.message.includes("timed out"),
    ),
  );
});

test("abortRun cancels direct ACP runs used by the background worker", async () => {
  const agent = new AcpAgent(
    {
      ...config(".openmuse"),
      acpArgs: [fixture, "--hang"],
    },
    { model: "unused", maxSteps: 3, prompt: "", tools: [] },
  );
  const finished = collect(agent.run(input));
  setTimeout(() => agent.abortRun(), 50);
  const events = await finished;
  assert.equal(
    events.some((event) => event.type === EventType.RUN_ERROR),
    false,
  );
});

test("local chat works without a key, survives reopening, and retains names and rich tool history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-local-chat-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  let openDb = db;
  let closed = false;
  t.after(async () => {
    if (!closed) await openDb.close();
    await rm(directory, { recursive: true, force: true });
  });
  const server = await createApp(db, config(directory));
  const session = await (
    await server.app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
  ).json();
  const headers = { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" };
  const main = await (await server.app.request("/api/main-thread", { headers })).json();
  const run = await server.app.request("/api/copilotkit/agent/default/run", {
    method: "POST",
    headers,
    body: JSON.stringify({ ...input, threadId: main.threadId }),
  });
  assert.equal(run.status, 200);
  const stream = await run.text();
  assert.ok(stream.includes("TOOL_CALL_RESULT"), stream);
  assert.ok(stream.includes("remember_fact"), stream);
  assert.equal(stream.includes("RUN_ERROR"), false, stream);
  assert.equal((await db.list("local-user", "memories")).length, 1);
  const renamed = await server.app.request(`/api/copilotkit/threads/${main.threadId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Morning preferences", userId: "forged" }),
  });
  assert.equal(renamed.status, 200);
  await db.close();
  closed = true;
  openDb = await createStore({ dataDir: join(directory, "db") });
  closed = false;
  const reopened = await createApp(openDb, config(directory));
  const after = await (await reopened.app.request("/api/main-thread", { headers })).json();
  assert.equal(after.threadId, main.threadId);
  const history = await (
    await reopened.app.request(`/api/copilotkit/threads/${main.threadId}/messages`, { headers })
  ).json();
  assert.ok(history.messages.some((message: { role: string }) => message.role === "tool"));
  const list = await (
    await reopened.app.request("/api/copilotkit/threads?agentId=default&userId=forged", { headers })
  ).json();
  assert.equal(list.threads[0].name, "Morning preferences");
  assert.equal(list.threads[0].createdById, "local-user");
  assert.equal((await reopened.app.request("/api/copilotkit/threads")).status, 401);
  await reopened.app.request(`/api/copilotkit/threads/${main.threadId}/archive`, {
    method: "POST",
    headers,
    body: "{}",
  });
  const archived = await (
    await reopened.app.request("/api/copilotkit/threads?agentId=default", { headers })
  ).json();
  assert.equal(archived.threads.length, 0);
  await reopened.app.request(`/api/copilotkit/threads/${main.threadId}`, {
    method: "PATCH",
    headers,
    body: '{"archived":false}',
  });
  const restored = await (
    await reopened.app.request("/api/copilotkit/threads?agentId=default", { headers })
  ).json();
  assert.equal(restored.threads.length, 1);
});

test("background tasks use ACP without MODEL or a direct model key", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-local-task-"));
  const db = await createStore();
  const server = await createApp(db, config(directory));
  t.after(async () => {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const task = await server.agent.createTask("task-owner", {
    prompt: "Write a short packing list",
    kind: "agent",
  });
  await server.agent.worker.tick();
  const completed = await server.agent.getTask("task-owner", task.id);
  assert.equal(completed.status, "succeeded", JSON.stringify(completed));
  assert.ok(completed.artifactIds.length > 0);
});

test("local runners isolate owners with identical thread ids and reject overlapping runs", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const threads = new LocalThreads(db);
  await threads.ensure("alice", "same");
  await threads.ensure("bob", "same");
  class ReplyAgent extends AbstractAgent {
    run(request: RunAgentInput): Observable<BaseEvent> {
      return new Observable((subscriber) => {
        subscriber.next({
          type: EventType.RUN_STARTED,
          threadId: request.threadId,
          runId: request.runId,
        });
        subscriber.next({
          type: EventType.TEXT_MESSAGE_CHUNK,
          messageId: "reply",
          role: "assistant",
          delta: "alice-only",
        });
        const timeout = setTimeout(() => {
          subscriber.next({
            type: EventType.RUN_FINISHED,
            threadId: request.threadId,
            runId: request.runId,
          });
          subscriber.complete();
        }, 25);
        return () => clearTimeout(timeout);
      });
    }
  }
  const agent = new ReplyAgent();
  agent.setMessages(input.messages);
  const request = { threadId: "same", agent, input: { ...input, threadId: "same" } };
  const runner = threads.runner("alice");
  const running = collect(runner.run(request));
  assert.throws(() => runner.run(request), /already running/);
  assert.equal(await threads.runner("bob").isRunning({ threadId: "same" }), false);
  assert.equal(await threads.runner("bob").stop({ threadId: "same" }), false);
  await db.compareAndSwap(
    "alice",
    "local-threads",
    "same",
    {},
    { name: "Renamed during the reply" },
  );
  await running;
  assert.equal((await threads.get("alice", "same")).name, "Renamed during the reply");
  const alice = await collect(threads.runner("alice").connect({ threadId: "same" }));
  const bob = await collect(threads.runner("bob").connect({ threadId: "same" }));
  assert.ok(JSON.stringify(alice).includes("alice-only"));
  assert.equal(JSON.stringify(bob).includes("alice-only"), false);
});
