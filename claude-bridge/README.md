# claude-bridge

Claude models in [Pi](https://github.com/earendil-works/pi) through Claude Code and your Claude subscription.

Log in with `claude auth login`, then pick a `claude-bridge/...` model with `/model`. The `anthropic/...` models are Pi's own provider and don't use the subscription.

Each Pi turn runs as a Claude Code query with `tools: []`. Pi's tools are served to it over MCP, so every tool call runs and renders in Pi. Steering reaches Claude at the next tool boundary, and bash gets Claude Code's 120-second default timeout.

Claude Code keeps its own preset prompt. From Pi's prompt it gets the appended instructions, project context, skills, a custom prompt that replaced Pi's default, and sections added by extensions. Pi's own preamble, tool list, rules, docs and cwd stay out. A turn whose forwarded text still contains Pi's preamble, or both `docs/custom-provider.md` and `docs/packages.md`, is refused, since Anthropic may bill that as extra usage.

Claude Code loads only user settings. Project `.claude/settings*.json`, `CLAUDE.md` and `AGENTS.md` files, MCP servers from `~/.claude.json` and `.mcp.json`, claude.ai connectors and auto-memory are all off. Models measured to serve 1M context request it; the rest run at 200K.

The bridge resumes the Claude Code session while Pi's history matches what it recorded, and rebuilds it after compaction, tree navigation, edits, model changes or changed instructions. Session pointers live in `claude-bridge/sessions/` in Pi's agent folder.

An exported `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` redirects Claude Code, and every turn fails with that gateway's auth error.

Based on [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) · [MIT](LICENSE)
