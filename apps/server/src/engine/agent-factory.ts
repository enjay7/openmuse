import type { Config } from "../config.ts";
import { AcpAgent, type AgentOptions } from "./acp-agent.ts";
import { tanstackAgent } from "./tanstack-agent.ts";

export function applicationAgent(config: Config, options: AgentOptions) {
  return config.agentBackend === "acp" ? new AcpAgent(config, options) : tanstackAgent(options);
}
