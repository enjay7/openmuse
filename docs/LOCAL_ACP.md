# Local ACP experiment

Branch: `experiment/local-acp-harness`, based on OpenMuse `a4944f4`.

This branch runs OpenMuse chat and open-ended background tasks through a locally
installed Codex, Claude Code, or Kiro CLI, using ACP. Their existing CLI login or
managed credentials supply model access. OpenMuse needs neither a CopilotKit
Intelligence key nor a direct model API key for this path.

## Run

Use Node 22+ and the pinned pnpm version (11.19.0):

```sh
corepack enable pnpm
corepack pnpm install --frozen-lockfile
cp .env.example .env
corepack pnpm dev
```

In a second terminal:

```sh
corepack pnpm dev:web
```

Open `http://localhost:8081`. The API listens at `http://localhost:8787`.
Sample mode uses fictional mail and calendar data. Try “Read my recent email”
or “Create a task to draft a short packing list for a weekend trip.”
The Activity screen shows delegated work and its results.

Set `ACP_PROVIDER=codex`, `claude`, or `kiro` in `.env`, then restart the API.
The Codex and Claude ACP adapters are pinned project dependencies; Kiro exposes
ACP natively. `codex`, `claude`, and `kiro-cli` must be on the API process's PATH.
Codex/Claude adapters use the installed CLI wrappers by default. `CODEX_PATH`
and `CLAUDE_CODE_EXECUTABLE` can select an explicit CLI path.

`ACP_MODEL` optionally selects a provider model through ACP's model config
option. Omit it to use the provider's default. `ACP_COMMAND` and `ACP_ARGS`
(a JSON string array) support a custom ACP launch command. Commands are spawned
directly, without a shell. `ACP_TIMEOUT_MS` defaults to five minutes.

To verify an actual provider and OpenMuse tool round trip:

```sh
ACP_PROVIDER=codex corepack pnpm exec tsx scripts/acp-smoke.ts
ACP_PROVIDER=claude corepack pnpm exec tsx scripts/acp-smoke.ts
ACP_PROVIDER=kiro corepack pnpm exec tsx scripts/acp-smoke.ts
```

All three passed a real tool round trip on November 10, 2026 using this machine's
managed CLI logins. These checks invoke the provider service through its CLI;
“local” refers to the harness and storage, not offline model inference.

## How it works

- OpenMuse retains its existing personal-agent and worker instructions and
  server-side tool implementations, including reviewed email/calendar actions.
- Each run gets a fresh ACP process/session and a temporary working directory.
  Stored chat history and application context are sent in the prompt.
- A per-run stdio MCP bridge forwards only the offered OpenMuse tools to
  authenticated loopback endpoints in the API/worker process. It emits AG-UI
  text and tool events for the existing chat cards.
- Conversations, tool results, names, archive state, and main-thread selection
  are stored in OpenMuse's existing owner-scoped database under `DATA_DIR`
  (or its configured PostgreSQL database). Reloading/restarting retains them.
- Chat and delegated tasks both select the ACP backend. Deterministic PDF,
  finance, and monitor workflows retain their original execution path.
- Local threads use SSE rather than the Intelligence platform's WebSockets.
  SDK telemetry sampling defaults to zero.

## Scope and limits

This is a local prototype, not a replacement for the Linux computer sandbox.
Claude's built-in tools are disabled; Kiro gets a temporary OpenMuse-only agent;
Codex starts in read-only mode. ACP permission requests for other tools are
declined. These controls do not create OS isolation: CLI user settings and
provider behavior still matter, especially when using a custom command.

The original worker's leases, retries, checkpoints, and action review still
apply. ACP runs have a tool-call bound and timeout; tasks can ask for input or
prepare an action for app review. A fresh session replays application history,
rather than reusing provider-side sessions. Provider-native thinking, plans,
and filesystem tools are not shown in the OpenMuse chat.

Google connectors still need their own OAuth configuration in live mode.
Docker/E2B computer use, the separate browser worker, and live Jev still need
their respective original setup. They are optional for the sample experiment.
This change does not introduce voice mode.

Hosted thread storage remains available explicitly with
`THREAD_STORAGE=intelligence` and `CPK_INTELLIGENCE_API_KEY`.
Existing hosted conversations are not migrated into the local store.
