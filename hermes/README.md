# Webly for Hermes Agent

[Webly](https://webly.ai) is website hosting for agents. This folder is a
Portable Agent Plugins v1 package for [Hermes Agent](https://github.com/NousResearch/hermes-agent):

- `mcp.json`: the hosted Webly MCP server, `https://api.webly.ai/v1/mcp` (Streamable HTTP).
- `skills/webly/`: the `webly` skill and its zero-dependency Node helper
  (`scripts/webly.mjs`, Node 20+). It is the same skill as `skills/webly/` at the
  repo root, except that this copy has no update check (see below).

With it, Hermes can publish a website, or share files and folders, at a live
`*.webly.site` URL with no account. When the person wants to keep it, they sign
in, claim it, and the agent edits it over MCP and publishes the drafts they approve.

## Install

```bash
hermes plugins install webly
hermes plugins enable webly
```

Publishing without an account works right away through the skill's helper. The
MCP tools (editing, drafts, publishing, domains, forms, analytics) need a
Webly sign-in, using one of these:

- **OAuth (recommended).** A portable `mcp.json` cannot ask for OAuth, so add a
  same-named server to your Hermes config, which replaces the package's entry,
  and sign in in the browser:

  ```bash
  hermes mcp add webly --url https://api.webly.ai/v1/mcp --auth oauth
  hermes mcp login webly
  ```

- **API key.** Create a `wb_` key in the Webly dashboard (Settings, Agents &
  keys) and set it as `WEBLY_API_KEY`: in the Desktop app's plugin settings, or
  in `~/.hermes/.env`. The package sends it as `Authorization: Bearer` to
  `api.webly.ai` only. API keys can manage sites but cannot claim an anonymous
  one; the skill opens the claim page in the browser instead.

Until one of these is set up, the `webly` MCP server does not connect (Hermes
reports that `WEBLY_API_KEY` is not set), and the skill still publishes anonymously.

## What it does on your machine

- **Network.** MCP tool calls go to `https://api.webly.ai/v1/mcp`. The helper
  talks to `https://api.webly.ai` (publishing, sign-in, uploads), to presigned
  storage upload URLs that the API returns, and, for `domain-watch`, to the
  custom domain you name. Published sites are public at `*.webly.site` unless the
  owner adds a password.
- **Files it writes.** `~/.webly/` (mode 0700): `state.json` (the anonymous
  site's token, mode 0600), `login.json` (`webly login` only; OAuth refresh
  token, mode 0600), `deploys.json`, `pending` and `version`. In the project
  folder it deploys: `.webly/project.json`, the link to the site. Large folders
  are zipped to the system temp folder and deleted after upload.
- **Files it reads outside its own data.** The files and folders you ask it to
  publish or share. `webly doctor` also checks whether the Webly MCP server is
  configured for Claude Code or Codex by reading `~/.claude.json`,
  `~/.claude/settings.json` and `~/.codex/config.toml` (only whether a `webly`
  entry exists; nothing is sent anywhere).
- **Shell commands.** Deploying a folder that has a `package.json` build script
  runs `npm`/`pnpm`/`yarn install` (if `node_modules` is missing) and `run build`
  there first. Sign-in and the claim page open your browser (`open`, `xdg-open`
  or `start`). `webly connect claude|codex` runs the Claude Code or Codex CLI to
  register the MCP server for those hosts; the skill uses it only on those hosts,
  never in Hermes.
- **Long-running.** `webly domain-watch` polls a custom domain every 30 seconds
  for up to 2 hours, only when asked to watch one.
- **No telemetry, no update check.** This copy never checks for or downloads
  updates; a new version reaches you as a reviewed catalog pin and
  `hermes plugins update webly`.

The skill publishes only when the person asks to publish, and publishes a
signed-in site's draft only after they approve it. Deleting, moving or
replacing a site needs their explicit confirmation. These are skill
instructions, not Hermes approval gates.

## Links

- Docs: https://api.webly.ai/docs
- Full API contract for agents: https://api.webly.ai/llms.txt
- Security: see [SECURITY.md](../SECURITY.md) or email contact@webly.ai
- License: Apache-2.0
