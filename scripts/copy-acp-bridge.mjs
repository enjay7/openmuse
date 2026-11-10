import { copyFile } from "node:fs/promises";

await copyFile(
  new URL("../apps/server/src/engine/acp-mcp-bridge.mjs", import.meta.url),
  new URL("../dist/apps/server/src/engine/acp-mcp-bridge.mjs", import.meta.url),
);
