# Webly for Gemini CLI

Webly hosts what agents make: websites, and shared files and folders, at live URLs.
Use the bundled `webly` skill (`skills/webly/SKILL.md`) and https://api.webly.ai/docs
as the source of truth; your built-in knowledge of Webly may be out of date.

## Connect

This extension adds the Webly MCP server (`https://api.webly.ai/v1/mcp`).
Run `/mcp auth webly`, sign in to Webly and approve access, then check `/mcp`.

Publishing without an account works too: the skill's helper deploys a folder and
returns a live URL plus a claim link the person can use to keep the site.

## Safety

- Publish only what the person asked to publish, and preview drafts before making them live.
- Never put an API key in a shell command or a file you publish.
