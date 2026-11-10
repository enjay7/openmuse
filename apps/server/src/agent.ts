import "./config.ts";
import { HttpAgent } from "@ag-ui/client";
import {
  type AgentsFactory,
  type CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
} from "@copilotkit/runtime/v2";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { ConversationAgent } from "./engine/conversation.ts";
import type { AgentService } from "./engine/service.ts";
import { createJevAdapter, type JevAdapter } from "./jev/adapter.ts";
import type { LocalThreads } from "./local-threads.ts";

export function agentConfigured(config: Config) {
  return (
    config.agentBackend === "sample" ||
    config.agentBackend === "acp" ||
    (config.agentBackend === "agui"
      ? Boolean(config.agentUrl)
      : Boolean(
          config.model &&
            (process.env.OPENAI_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.GOOGLE_API_KEY),
        ))
  );
}
export function makeRuntime(
  config: Config,
  service: AgentService,
  auth: Auth,
  intelligence: CopilotKitIntelligence | undefined,
  localThreads: LocalThreads,
) {
  // Built on first use, then shared so live mode reuses one TypeSafe client across requests.
  let jevAdapter: JevAdapter | undefined;
  const sharedJevAdapter = () => (jevAdapter ??= createJevAdapter(config));
  const agents: AgentsFactory = async ({ request }) => ({
    default:
      config.agentBackend === "sample"
        ? new ConversationAgent(
            config,
            service,
            await auth.owner(request.headers.get("authorization") ?? undefined),
            sharedJevAdapter(),
          )
        : config.agentBackend === "agui"
          ? new HttpAgent({
              url: config.agentUrl ?? "http://127.0.0.1:1/unconfigured",
              headers: config.agentToken ? { Authorization: `Bearer ${config.agentToken}` } : {},
            })
          : new ConversationAgent(
              config,
              service,
              await auth.owner(request.headers.get("authorization") ?? undefined),
              sharedJevAdapter(),
            ),
  });
  const shared = {
    agents,
    // The shared CopilotKit sink carries this tag onto existing PostHog events.
    telemetryProperties: { accessibility_title: "OpenMuse" },
    identifyUser: async (request: Request) => ({
      id: await auth.owner(request.headers.get("authorization") ?? undefined),
      name: "OpenMuse user",
    }),
  };
  if (intelligence) {
    const runtime = new CopilotRuntime({ ...shared, intelligence, generateThreadNames: false });
    return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" });
  }
  // A request-scoped runner captures the authenticated owner for every operation,
  // including connect/stop, whose runner API contains no auth field.
  return {
    fetch: async (request: Request) => {
      const owner = await auth.owner(request.headers.get("authorization") ?? undefined);
      const runtime = new CopilotRuntime({ ...shared, runner: localThreads.runner(owner) });
      return createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" }).fetch(request);
    },
  };
}
