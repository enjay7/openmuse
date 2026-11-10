import { randomUUID } from "node:crypto";
import { type BaseEvent, EventType, type Message } from "@ag-ui/core";
import {
  AgentRunner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  finalizeRunEvents,
} from "@copilotkit/runtime/v2";
import type { Hono } from "hono";
import { filter, Observable, ReplaySubject } from "rxjs";
import { z } from "zod";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

type LocalThread = {
  id: string;
  name: string | null;
  agentId: string;
  createdById: string;
  organizationId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  state: Record<string, unknown>;
};
type ActiveRun = {
  request: AgentRunnerRunRequest;
  events: ReplaySubject<BaseEvent>;
  stopRequested: boolean;
  done: Promise<void>;
};
const threadIdSchema = z.string().min(1).max(200);

/** Durable, owner-scoped thread snapshots. Active streams never use the SDK global store. */
export class LocalThreads {
  private readonly active = new Map<string, ActiveRun>();
  constructor(private readonly db: Store) {}
  async stop() {
    const runs = [...this.active.values()];
    for (const run of runs) {
      run.stopRequested = true;
      run.request.agent.abortRun();
    }
    await Promise.all(runs.map((run) => run.done));
  }
  private key(owner: string, id: string) {
    return JSON.stringify([owner, id]);
  }
  async ensure(owner: string, id: string): Promise<LocalThread> {
    threadIdSchema.parse(id);
    const now = new Date().toISOString();
    await this.db.insertIfAbsent(owner, "local-threads", {
      id,
      name: null,
      agentId: "default",
      createdById: owner,
      organizationId: "local",
      archived: false,
      createdAt: now,
      updatedAt: now,
      messages: [],
      state: {},
    });
    return this.get(owner, id);
  }
  async get(owner: string, id: string): Promise<LocalThread> {
    const thread = await this.db.get<LocalThread>(owner, "local-threads", threadIdSchema.parse(id));
    if (!thread) throw new AppError("Conversation not found", 404);
    return thread;
  }
  private async patch(
    owner: string,
    id: string,
    patch: Partial<LocalThread>,
  ): Promise<LocalThread> {
    const updated = await this.db.compareAndSwap<LocalThread>(
      owner,
      "local-threads",
      threadIdSchema.parse(id),
      {},
      patch,
    );
    if (!updated) throw new AppError("Conversation not found", 404);
    return updated;
  }
  runner(owner: string): AgentRunner {
    const manager = this;
    return new (class extends AgentRunner {
      run(request: AgentRunnerRunRequest) {
        const key = manager.key(owner, request.threadId);
        threadIdSchema.parse(request.threadId);
        if (manager.active.has(key)) throw new Error("Thread already running");
        const active: ActiveRun = {
          request,
          events: new ReplaySubject(),
          stopRequested: false,
          done: Promise.resolve(),
        };
        manager.active.set(key, active);
        active.done = manager.execute(owner, key, active);
        return active.events.asObservable();
      }
      connect(request: AgentRunnerConnectRequest) {
        return new Observable<BaseEvent>((subscriber) => {
          let subscription: { unsubscribe(): void } | undefined;
          const active = manager.active.get(manager.key(owner, request.threadId));
          if (active) {
            // Replay from the run's input, not a database snapshot that might
            // already contain the same run's output after an await.
            subscriber.next({
              type: EventType.RUN_STARTED,
              threadId: request.threadId,
              runId: active.request.input.runId,
            });
            subscriber.next({
              type: EventType.MESSAGES_SNAPSHOT,
              messages: active.request.input.messages,
            });
            subscriber.next({
              type: EventType.STATE_SNAPSHOT,
              snapshot: active.request.input.state,
            });
            subscription = active.events
              .pipe(filter((event) => event.type !== EventType.RUN_STARTED))
              .subscribe(subscriber);
            return () => subscription?.unsubscribe();
          }
          void manager
            .get(owner, request.threadId)
            .then((thread) => {
              if (subscriber.closed) return;
              const runId = randomUUID();
              subscriber.next({ type: EventType.RUN_STARTED, threadId: request.threadId, runId });
              subscriber.next({ type: EventType.MESSAGES_SNAPSHOT, messages: thread.messages });
              subscriber.next({ type: EventType.STATE_SNAPSHOT, snapshot: thread.state });
              subscriber.next({ type: EventType.RUN_FINISHED, threadId: request.threadId, runId });
              subscriber.complete();
            })
            .catch((error) => subscriber.error(error));
          return () => subscription?.unsubscribe();
        });
      }
      async isRunning(request: AgentRunnerIsRunningRequest) {
        return manager.active.has(manager.key(owner, request.threadId));
      }
      async stop(request: AgentRunnerStopRequest) {
        const active = manager.active.get(manager.key(owner, request.threadId));
        if (
          !active ||
          active.stopRequested ||
          (request.runId && active.request.input.runId !== request.runId)
        )
          return false;
        active.stopRequested = true;
        active.request.agent.abortRun();
        return true;
      }
    })();
  }
  private async execute(owner: string, key: string, active: ActiveRun) {
    const { request } = active;
    const events: BaseEvent[] = [];
    let thread: LocalThread | undefined;
    try {
      thread = await this.ensure(owner, request.threadId);
      // The desktop supplies the full messages. Store input before launching a
      // provider, so a failed CLI does not lose the user's submitted message.
      await this.patch(owner, request.threadId, {
        messages: request.input.messages,
        state: request.input.state,
        updatedAt: new Date().toISOString(),
      });
      if (!active.stopRequested) {
        await request.agent.runAgent(request.input, {
          onEvent: ({ event }) => {
            events.push(event);
            // Publish completion only after the thread snapshot is committed.
            if (event.type !== EventType.RUN_FINISHED) active.events.next(event);
          },
        });
      }
    } catch (error) {
      for (const event of finalizeRunEvents(events, {
        stopRequested: active.stopRequested,
        interruptionMessage: error instanceof Error ? error.message : "Conversation failed",
      })) {
        events.push(event);
        if (event.type !== EventType.RUN_FINISHED) active.events.next(event);
      }
    } finally {
      try {
        if (thread) {
          // Patch only the snapshot, preserving concurrent metadata changes.
          await this.patch(owner, request.threadId, {
            messages: request.agent.messages.length
              ? request.agent.messages
              : request.input.messages,
            state: request.agent.state,
            updatedAt: new Date().toISOString(),
          });
        }
        const terminal = events.findLast(
          (event) => event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR,
        );
        if (terminal?.type === EventType.RUN_FINISHED) active.events.next(terminal);
        else if (terminal?.type !== EventType.RUN_ERROR)
          active.events.next({
            type: EventType.RUN_FINISHED,
            threadId: request.threadId,
            runId: request.input.runId,
          });
        active.events.complete();
      } catch (error) {
        active.events.error(error);
      }
      this.active.delete(key);
    }
  }

  routes(app: Hono<{ Variables: { owner: string } }>) {
    app.get("/api/copilotkit/threads", async (c) => {
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(c.req.query("limit") ?? 20);
      const cursor = c.req.query("cursor");
      const includeArchived = c.req.query("includeArchived") === "true";
      const agentId = c.req.query("agentId") ?? "default";
      const all = (await this.db.list<LocalThread>(c.get("owner"), "local-threads"))
        .filter((thread) => thread.agentId === agentId && (includeArchived || !thread.archived))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
      const start = cursor ? Math.max(0, all.findIndex((thread) => thread.id === cursor) + 1) : 0;
      const page = all.slice(start, start + limit);
      return c.json({
        threads: page.map(({ messages: _messages, state: _state, ...summary }) => summary),
        nextCursor: start + limit < all.length ? (page.at(-1)?.id ?? null) : null,
      });
    });
    app.get("/api/copilotkit/threads/:id/messages", async (c) => {
      const thread = await this.get(c.get("owner"), c.req.param("id"));
      return c.json({
        messages: thread.messages.map((message) => {
          if (message.role !== "assistant") return message;
          return {
            ...message,
            toolCalls: message.toolCalls?.map((call) => ({
              id: call.id,
              name: call.function.name,
              args: call.function.arguments,
            })),
          };
        }),
      });
    });
    app.get("/api/copilotkit/threads/:id/state", async (c) =>
      c.json({ state: (await this.get(c.get("owner"), c.req.param("id"))).state }),
    );
    app.patch("/api/copilotkit/threads/:id", async (c) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(200).optional(),
          archived: z.boolean().optional(),
        })
        .parse(await c.req.json());
      return c.json(
        await this.patch(c.get("owner"), c.req.param("id"), {
          ...body,
          updatedAt: new Date().toISOString(),
        }),
      );
    });
    app.post("/api/copilotkit/threads/:id/archive", async (c) => {
      const thread = await this.get(c.get("owner"), c.req.param("id"));
      await this.patch(c.get("owner"), thread.id, {
        archived: true,
        updatedAt: new Date().toISOString(),
      });
      return c.json({ threadId: thread.id, archived: true });
    });
  }
}
