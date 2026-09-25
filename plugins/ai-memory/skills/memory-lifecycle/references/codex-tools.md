# Codex Tool Mapping

MCP tools (`memory_orient`, `memory_flush`, `memory_store`, `memory_search`, etc.) work identically across Claude Code and Codex -- no mapping needed.

For non-MCP tools referenced in skills:
| Skill references | Codex equivalent |
|---|---|
| `Read` / `Write` / `Edit` | Use your native file tools |
| `Bash` | Use your native shell tools |
| `Skill` tool | Skills load natively via `~/.agents/skills/` -- follow instructions directly |
