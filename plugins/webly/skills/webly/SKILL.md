---
name: webly
description: >-
  Webly is website hosting for agents: publish a folder or an HTML file to a
  live URL in seconds with no account, then let the person sign in and claim it
  to keep it, edit it over MCP, and publish drafts they approve. Use when asked
  to "publish this", "host this", "deploy this", "put this online", "make a
  website", "share this as a web page", "give me a link to this site", "keep my
  site", "claim my site", "make a Webly account", "connect Webly", or when
  working on a site hosted on Webly (*.webly.site). Also use at the start of any
  session where a Webly site or an unfinished Webly step is waiting on this
  machine.
license: Apache-2.0
metadata:
  publisher: Webly
  homepage: https://webly.ai
  docs: https://api.webly.ai/docs
  api-contract: https://api.webly.ai/llms.txt
  mcp-server: https://api.webly.ai/v1/mcp
---

# Webly

Webly hosts websites for agents. Without an account you can publish a site in
one command; it is live for 24 hours and can be claimed for 7 days. Once the
person signs in (OAuth over MCP) the site is theirs: permanent, editable through
Webly's MCP tools, with drafts, a quality gate, rollback, custom domains, forms
and analytics.

`https://api.webly.ai/llms.txt` is the full contract. Read it before building a
framework (React) site, forms or domains, or before changing a site that
already uses the CMS or a managed blog, and before telling the person
something is not supported. If this file and the live API disagree, trust the API.

The helper that does every deterministic step is `scripts/webly.mjs` in this
skill's folder (zero dependencies, Node 20+). Below, `webly` means
`node <this skill's folder>/scripts/webly.mjs`.

## Language

Reply in the person's language. Keep URLs, commands, tool names and error
reasons exactly as returned.

## Step 0: find out where we are (every time, first)

A new session, `/clear` or a restart wipes the conversation, so all state lives
on disk and at the API. Rebuild it before doing anything:

1. Run `webly doctor`. It is read-only and never creates a token. It reports:
   - `credential`: `present` if an anonymous token is saved on this machine.
   - `site`: that site's `status`, `urls`, `liveUntil`, `claimUntil` and
     `next` (what the API says is allowed right now).
   - `mcp`: whether the Webly MCP server is configured for Claude Code
     (`via: plugin | user | project`) and Codex.
   - `pending`: a step an earlier session asked you to finish, e.g. `claim`.
   - `updatedFrom`: set on the first run after this skill was updated. Tell
     the person in one line which version they are now on.
   - `update`: set when a newer version of this skill is published. Run its
     `command` (it matches how this copy was installed), tell the person in one
     line, then carry on with the task using this copy. The new one loads next
     session.
2. Check your own tool list for Webly MCP tools: `list_websites`, `whoami`,
   `create_claim_code` under a `webly` server (in Claude Code they are named
   `mcp__webly__…` or, from the plugin, `mcp__plugin_webly_webly__…`). A server
   that is configured but not in your tool list is **not loaded**.
   Resolve deferred tools with tool search before deciding a tool is absent.
   Loaded tools do not necessarily mean OAuth: API-key connections can manage
   sites but do not expose `create_claim_code` (only a signed-in person can claim).
3. Pick the row and follow it:

| # | Token saved | Webly MCP tools loaded | Who this is | Do this |
|---|---|---|---|---|
| 1 | no | no | New to Webly | **Publish without an account** (below). Don't set up MCP until they want to keep the site. |
| 2 | yes | no | Published before; MCP was never set up or didn't load | Read `site.next`. While it lists `update`, keep publishing with `webly deploy`. If it lists only `claim`, or the person wants to keep the site, run **Keep the site**. |
| 3 | no | yes | Signed in | Use **Working over MCP**. Anything they deployed anonymously was already claimed. |
| 4 | yes | yes | Connected with a site still unclaimed | Claim it: **Keep the site**, step 5. Never read `credentialFile` yourself. Continue with **Working over MCP** after claiming. |

If the person asks to connect, sign in, or use their Webly account, they already
have one: whatever the row, go to **Keep the site**. With a token saved, run it all.
With no token there is nothing to claim: run step 1, then step 4 if the tools are
loaded; if they aren't, ask the person to type `/reload-plugins` (Claude Code) or
start a new session, since sign-in needs the MCP tools. Don't publish anonymously
for them.

If `pending` is `claim` and the claim tool is available, finish the claim now (row 4),
without asking again: the person already asked for it before the restart. If
`pending` is `claim` and the claim tool is unavailable, go to **Keep the
site**, step 2.

## Publish without an account

1. Put the site in a folder, e.g. `./site`, with `index.html` at its root.
   Plain HTML, CSS and JS work best here. Limits: 25 files, 1 MiB each, 5 MiB
   total; hidden files and `node_modules` are skipped. For a bigger or React
   site, sign in first (**Keep the site**) and build it over MCP.
   Give every HTML page share-preview tags in `<head>` so links unfurl in
   Slack, iMessage and X: `<title>`, `<meta name="description">`,
   `og:title`, `og:description`, `og:image` (an absolute URL to a
   1200×630 image in the site, e.g. `/og.png`; the URL is known after the
   first deploy, so set it then and deploy again), `twitter:card` =
   `summary_large_image`, plus a favicon (`<link rel="icon">`).
2. Run `webly deploy ./site` (a single `.html` file works too). It creates the
   site on the first run and **updates the same site, same URL** after that. It
   waits for the build and prints the site JSON. A project folder whose
   `package.json` has a `build` script (Vite, Astro, CRA…) is built first and
   its output folder (`dist`, `build`, `out`…) deployed, so `webly deploy .`
   works. The site is named after `package.json`'s `name` or the project
   folder; pass `--name "…"` to choose. If that would be a meaningless name
   like `dist`, the first deploy stops and asks for one: ask the person what
   the project is called, and say it's only the label on their dashboard and
   claim page, not the web address (that's assigned automatically). Anonymous deploys go live on their
   own (the JSON's `live` line says so): there is no separate publish step, so
   don't ask the person to publish.
3. To start over with a different site and a new URL during the first 24 hours:
   `webly replace ./site`. Only when the person asks for a new site; the old
   one goes offline.

Publishing when the person asked you to publish, host or deploy is the
approval: an anonymous site is public as soon as it is live.

### What to tell the person

Put the URL on a line by itself, with nothing after it, so it stays clickable.
Then the deadlines, from the JSON, in their time zone if you know it:

> Your site is live:
>
> https://anon-….webly.site/
>
> It stays online for 24 hours (until {liveUntil}) and I can keep changing it
> until then. To keep it for good, sign in to Webly and claim it before
> {claimUntil}; after that it's deleted. Want me to set that up now?

Offer the claim once per site, not after every edit. Never show the token or
the contents of `~/.webly/`.

### Errors (`details.reason`)

| Reason | Means | Do |
|---|---|---|
| `site_already_created` | This token already has a site | `webly deploy` updates it; use `replace` only for a new URL |
| `edit_window_closed` (410) | 24 hours are up; offline but claimable | **Keep the site** |
| `build_failed` (400) | A swap's new site didn't build; the old one is untouched | Fix the files, retry |
| `network_limit` (409) | 50 live anonymous sites on this network | Wait `details.retryAfterSeconds`, or sign in |
| `credential_consumed` / `credential_expired` | Token is dead (claimed, or past 7 days) | The helper already deleted it; the next deploy starts fresh |
| `invite_only` (503) | Anonymous publishing is switched off | Sign in instead |
| HTTP 429 | Rate limited | Wait for `Retry-After` |
| HTTP 413 | Over the upload budget or size limit | Trim files, or sign in |

## Keep the site: sign in and claim

Run this when the person wants to keep the site, make an account or sign in, or
when `next.actions` is only `["claim"]`. Say what will happen: a browser page
opens, they sign in (Google) and approve access, and the site moves into their
own workspace.

1. **Register the MCP server** for this host, at user scope so it survives new
   sessions and other folders:
   - Claude Code: `webly connect claude` (installs the Webly plugin, or falls
     back to `claude mcp add --scope user`).
   - Codex: `webly connect codex`.
   - Other hosts: follow https://webly.ai/agent.md, Phase 2.
   `connect` also records `pending: claim`, so the claim is finished by
   whichever session loads the tools first. Its `next` field says what to do.
2. **Use MCP if it's already callable; otherwise claim in the browser now.**
   Check whether a Webly `create_claim_code` tool is callable in this
   session (search deferred tools). If yes, go to step 4. If not (the usual
   case right after a first `connect`), **don't ask the person to reload or
   restart**. Run `webly claim-link --open` straight away. It opens
   `app.webly.ai/claim` with the token in the URL fragment (never sent to a
   server, never printed). Ask them to sign in and click **Claim website**. If the
   page shows the wrong Google account, **Not you? Use a different account**
   switches it.
   Opening the page or signing in alone does not claim the site. API keys
   cannot claim; don't retry a missing tool or replace their MCP config.
3. **Confirm the browser claim.** After they say they're done, run
   `webly doctor`: only `siteError.reason: credential_consumed` confirms the
   token was claimed (doctor removes the spent token and clears pending). If
   it is still unclaimed, the browser was closed, or status is unavailable,
   keep the token and pending step so they can retry. Never run `forget`
   merely because the browser opened. MCP loads by itself next session
   (Codex: `codex mcp login webly` first). Stop here; steps 4-5 are the MCP
   path.
4. **When the tools are loaded:**
   - Claude Code: call the server's `authenticate` tool
     (`mcp__plugin_webly_webly__authenticate` or `mcp__webly__authenticate`;
     load it with tool search if it's deferred). It returns an authorization
     URL. Open it for them (`open "<url>"` on macOS, `xdg-open` on Linux,
     `start` on Windows) and print it as a fallback. The callback completes by
     itself.
   - Other hosts: call `whoami`; the 401 starts the host's own sign-in.
   - The consent page offers `webly:content`, `webly:edit` and `webly:admin`
     and defaults to `webly:admin`, which creating sites needs. Tell them to
     keep it unless they only want you editing existing sites (`webly:edit`).
5. **Claim:** call `create_claim_code`, then run `webly claim <code>`. The
   helper sends the code and the saved token to Webly itself, so you never
   read the token, and on success it deletes the token and the pending step.
   Tell them which site moved and give the printed `dashboardUrl`. A retry by
   the same person is safe (`alreadyClaimed: true`). The code lasts 10
   minutes; get a new one if it expired (`claim_code_invalid`).

After the claim: with billing off, or on a paid plan with a free slot, the site
is permanent. On the Free plan with billing on it's *held*: editable until the
original 24-hour mark, then offline until they upgrade (`402 claim_held`). Say
which one the response shows (`website.claimHeld`); don't promise permanence.

## Working over MCP (signed in)

Call `whoami` and `list_websites` first, and continue an existing site rather
than creating a second one.

1. Framework sites (typed React, the default): `acquire_edit_lease`, then
   `put_source_file` / `str_replace`. Static sites: `deploy_files`. Each write
   makes a new draft version; the live site doesn't change. Writes are
   Prettier-formatted, so copy `str_replace` text from `read_source_file`.
2. `check_head` runs the quality gate (lint, typecheck, bundle, render). Fix
   every diagnostic.
3. Show the person the draft URL (`https://draft--{subdomain}.webly.site`, not
   public, not indexed).
4. `publish_website` only after they say yes to that exact site and version.
   `rollback_website` / `unpublish_website` if something is wrong live.

New sites: `create_website` names the subdomain after the site; if that's taken
it gets a suffix (`portfolio-x7k2p9`). Pass `subdomain` only when the person asks
for a specific one (up to 56 characters); a taken one is a `409`, not a variant.

New content, including blog posts and repeating content (products, team, FAQs),
goes in the site's source files; don't create collections or blog posts, the CMS
is deprecated. A site that already reads collections or a managed blog keeps
using those tools for that content until the owner asks to move it. Forms
post with `formAction('name')`, never `mailto:`.
Details are in llms.txt.

`403` names the missing capability in `details.capability`: the grant was
narrower than the task, so tell them which access level covers it. `401` /
`invalid_token`: call a Webly tool again to re-trigger sign-in; don't start a
second attempt while one is waiting. `409 Invalid edit lease`: re-acquire and
re-read before writing.

## Rules

- The token is a secret that proves ownership. Never print it, log it, commit
  it, or put it in a URL other than through `webly claim-link`.
- Only state URLs, sites and counts that a command or tool actually returned.
- Don't set up MCP for someone who only wants a quick link; offer it when they
  want to keep or grow the site.
- One anonymous site per machine. If they want a second site kept, claim the
  first, then deploy again.
