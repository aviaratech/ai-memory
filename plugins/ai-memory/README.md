# ai-memory plugin

The released `@aviaratech/ai-memory` runtime includes this built self-contained plugin under `plugins/ai-memory`. Its portable `plugin.json`/`mcp.json` metadata supports Codex, while `.claude-plugin/plugin.json`/`.mcp.json` preserves Claude Code compatibility. The matching GitHub plugin archive contains the same files, including bundled launcher/server, skills, hooks, canonical migrations, license and third-party notices. No private checkout, source build or npm postinstall is needed by consumers.

Use `ai-memory plugin install|doctor|update|rollback|remove` with explicit `--host codex|claude-code` and `--scope`; install/update also require the exact runtime `--version`. The helper verifies actual native registration and launcher bytes. Hook review/trust and host restart remain explicit actions. Configure the dedicated protected `~/.config/ai-memory/plugin.env` file and initialize PostgreSQL separately; `plugin doctor` verifies schema readiness read-only before an MCP handshake. See the [installation guide](../../docs/installation.md) for supported scopes, recovery, conflicts and data preservation.

For contributors, `npm run build` from the repository root bundles the launcher/server, copies core migrations, and stages the same plugin inventory into the runtime package. Build scripts are not shipped in the consumer plugin.
