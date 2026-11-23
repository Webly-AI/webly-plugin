---
name: webly
description: >-
  Webly hosts what agents make: publish a website, or share files and folders,
  at a live URL, edit it, preview drafts and publish the versions the person
  approves. Use when asked to "publish this", "host this", "deploy this", "put
  this online", "make a website", "share this as a web page", "give me a link
  to this site", "share these files", "connect my domain", "use my own domain",
  or when working on a site hosted on Webly (*.webly.site).
---

# Webly

Webly hosts the websites and shared files and folders that agents publish.
Everything here goes through the Webly MCP server that this plugin connects
(`https://api.webly.ai/v1/mcp`). The person signs in once with OAuth; there is
no API key to handle. `https://api.webly.ai/llms.txt` is the full contract:
read it before building a framework (React) site, forms or domains, and before
telling the person something is not supported. If this file and the live API
disagree, trust the API.

Reply in the person's language. Keep URLs, tool names and error reasons
exactly as returned.

## Start every time

1. Call `whoami`. On `401` / `invalid_token`, call a Webly tool again to
   re-trigger sign-in; don't start a second attempt while one is waiting.
2. Call `list_websites` and continue an existing site rather than creating a
   second one. Never guess a site from a hostname.
3. `whoami` → `workspaces: "all"` means this connection works in every
   workspace the person belongs to. Tools that act on a whole workspace
   (`create_website`, `list_websites`, `get_billing`) take its slug as
   `workspace`. If there are several, ask which one; on
   `400 workspace_required` ask, never guess.

## Build and publish a site

1. `create_website`. New sites get a short generated address
   (`zen-wreath-y76r.webly.site`); pass `subdomain` only when the person asks
   for a specific one.
2. Write the source:
   - Framework sites (typed React, the default): `put_source_file` and
     `str_replace`.
   - Static sites: `deploy_files` for a few small whole files, `str_replace`
     with `{ path, edits }` for small text edits.
   Every write takes a message written like a git commit message: a short
   imperative subject ("Show yearly plans first on Pricing"), a blank line,
   then a body in plain words saying what changed and why. The site's History
   shows it to everyone who shares the site.
3. `check_head` runs the quality gate (lint, typecheck, bundle, render). Fix
   every diagnostic.
4. Show the person the draft URL (`urls.draft`, not public, not indexed).
5. `publish_website` only after they say yes to that exact site and version,
   with `version` set to the one they previewed. A `202` with
   `status: "building"` means Webly is still building, not a failure: publish
   that version again in about 15 seconds and tell the person it's building.
6. Share `urls.primary`. `rollback_website` or `unpublish_website` if
   something is wrong live.

Only state URLs, sites and counts that a tool actually returned.

## Edit an existing site

Other people and agents may edit the same site at once, and people edit text,
styles, sections, images, pages and brand colours in the dashboard, on static
sites too. So:

- Re-read a file (`read_source_file`, `read_source_files`, `search_source`)
  before editing it, and copy `str_replace` text from what you read: writes are
  Prettier-formatted.
- Send `baseVersion` (the `version` your read returned) with
  `put_source_file` and `delete_source_file`, and `expectedHeadVersion` with
  `deploy_files`. Edits to other lines are merged with yours. `409
  merge_conflict` means you both changed the same lines: tell the person whose
  change it is (`theirsBy`), re-read, re-apply keeping theirs, and resend.
- On a static site the editor's styles compile into `/webly.css`, linked from
  each page that uses them: keep that file and its `<link>` when you rewrite a
  page.
- `wait_for_changes` shows what others wrote since a version.
- Publishing a version also puts live the unpublished versions on main before
  it. The response's `alsoPublishes` lists the ones others wrote: tell your
  person what of theirs went live.

New content, including blog posts and repeating content (products, team,
FAQs), goes in the site's source files. Don't create collections or blog
posts; the CMS is deprecated. A site that already reads collections or a
managed blog keeps using those tools for that content.

## History, rollback and branches

- `list_changes` and `diff_source_file` (from a version's `parentVersion`)
  show what a version changed. `preview_version` gives a private link to how a
  version looked, for an hour, changing nothing.
- `rollback_website` puts an earlier version live.
- For a risky or large change the person wants to see before it reaches main,
  `create_branch` and pass `branch` to every read and write; the preview is at
  `{branch}--{site}.webly.site`. `merge_branch` writes a draft on main and
  closes the branch. Merging is not publishing: ask before sending
  `publish: true`. On `409 merge_conflict`, `update_branch`, fix the listed
  files on the branch, and merge again. On `402 branch_limit`, merge or delete
  a branch, or give the owner `details.upgradeUrl`.

## Custom domains

Needs Hobby (5 domains) or Pro (25); on Free, `add_domain` is
`402 domain_limit`: give the owner `details.upgradeUrl`.

1. Pick the site with `list_websites`.
2. For a bare domain, recommend `www.example.com` (works with every DNS
   provider; the bare domain then forwards to it). Use `example.com` directly
   only if their DNS provider supports CNAME flattening or ALIAS at the root.
3. `add_domain`, then `connect_domain`. If it returns a `url`, give the person
   that link first: they approve at their DNS provider and the records are set
   for them. Otherwise give every `dns.records` entry exactly as returned, as a
   Type / Name / Value table, including the `_acme-challenge` TXT record that
   issues the HTTPS certificate. On Cloudflare the record must be "DNS only".
4. Call `verify_domain` every `next.checkAgainSeconds` and tell the person as
   each step (DNS, HTTPS, live) completes. If it's `failed`, relay
   `failureMessage`.

Adding a domain publishes nothing and takes nothing offline.

## Forms

Forms post with `formAction('name')`, never `mailto:`. Never ask visitors for
card numbers, passwords, ID numbers or health details. `list_forms` and
`list_form_submissions` read what came in; `set_form_notifications` turns on an
email per submission (Hobby and Pro).

## Errors

- `403` names the missing capability in `details.capability`: tell the person
  which access level covers the task.
- `402`: the plan doesn't include it; give the owner `details.upgradeUrl`.
- `404`: the site or resource isn't in this workspace (or doesn't exist).
