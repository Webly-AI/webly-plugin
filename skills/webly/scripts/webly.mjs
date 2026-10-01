#!/usr/bin/env node
/** Webly agent helper: anonymous deploys, local state for new sessions, and MCP setup. Zero dependencies. */
import { mkdir, readFile, writeFile, readdir, open, link, unlink, lstat, stat, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { spawn, spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolve4, resolveCname } from 'node:dns/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Skill release. scripts/sync-plugin.sh stamps this into the plugin manifests; bump it to ship. */
export const VERSION = '0.6.8';
// The published plugin manifest is what `npx skills`, install.sh and /plugin install all read from.
const LATEST_URL = process.env.WEBLY_VERSION_URL ?? 'https://raw.githubusercontent.com/Webly-AI/webly-plugin/main/plugins/webly/.claude-plugin/plugin.json';
const CREDENTIAL_FILE = process.env.WEBLY_STATE_FILE || join(homedir(), '.webly', 'state.json');
// Where releases before 0.4.0 saved the token; moved to CREDENTIAL_FILE on first read.
const LEGACY_FILE = process.env.WEBLY_STATE_FILE ? null : join(homedir(), '.webly', 'anonymous-credential');
const PENDING_FILE = join(dirname(CREDENTIAL_FILE), 'pending');
// The last VERSION that ran here, so the first run after an update can say so.
const SEEN_FILE = join(dirname(CREDENTIAL_FILE), 'version');
const PLUGIN_MARKETPLACE = 'Webly-AI/webly-plugin';
// The only server answers that mean the saved secret can never be used again.
const SPENT = new Set(['credential_consumed', 'credential_expired']);
// Mirrors the server's anonymous limits so a too-big folder fails before any request.
const MAX_FILES = 25, MAX_FILE_BYTES = 1024 * 1024, MAX_TOTAL_BYTES = 5 * 1024 * 1024;
const TOKEN = /^wa_[A-Za-z0-9_-]{43}$/;

const USAGE = `Usage: webly.mjs <command>
  doctor [--brief]            Saved site, MCP setup and pending step on this machine (never creates anything)
  deploy <dir|file|payload.json> [--name N]   Publish anonymously: creates the site, or updates it if this machine has one.
                              A project with a package.json build script is built first and its output folder deployed.
  replace <dir|file|payload.json> [--name N]  Swap the site for a new one with a new URL (first 24 hours only)
  upload <file|dir>... [--folder F] [--name N]   Share files without an account: one link per file plus a folder
                              link with Download all (.zip). Folders keep their subfolders and hidden files; over 500
                              files they go up as one zip, served as a folder. 500 MiB in total,
                              live and claimable for 24 hours.
  status                      The saved site's status, URLs, deadlines and next step
  claim <code>                Claim the saved site with a code from the create_claim_code MCP tool (the secret never leaves this helper)
  claim-link [--open]         Open (or print) the page that claims the site into an account
  connect claude|codex        Register the Webly MCP server for this agent host, at user scope
  pending set <intent> | clear   Remember a step to finish after a restart (e.g. claim)
  domain-watch <hostname> [--timeout MIN]   Wait for a custom domain to go live: prints each step (dns, https, live),
                              exits 0 once Webly serves it over HTTPS, 1 after the timeout (default 120). Run it in the background
  forget                      Delete the saved token only after the API confirms it is spent
  init                        Create the token without deploying

Env: WEBLY_API_URL (default https://api.webly.ai), WEBLY_STATE_FILE (default ~/.webly/state.json)`;

/**
 * One look at a custom domain from this machine, no credentials needed:
 * 'dns' (no record yet), 'https' (DNS resolves, Webly not serving it over HTTPS yet) or 'live'.
 */
export async function domainStage(host, fetchImpl = fetch) {
  let target;
  try { target = (await resolveCname(host))[0]; }
  catch { try { target = (await resolve4(host))[0]; } catch { return { stage: 'dns', detail: 'no DNS record found yet' }; } }
  try {
    // Judge only this host's own answer: a redirect elsewhere (say, an old host pointing at a
    // Webly site) must not count. Webly's own redirects (canonical 308) carry the header too.
    const response = await fetchImpl(`https://${host}/`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    if (response.headers.has('x-webly-version')) return { stage: 'live', detail: `https://${host}` };
    const moved = response.status >= 300 && response.status < 400 ? `, redirecting to ${response.headers.get('location')}` : '';
    return { stage: 'https', detail: `DNS points to ${target}, but Webly is not serving it yet (HTTP ${response.status}${moved}); the certificate may still be issuing, or the site is not published` };
  } catch { return { stage: 'https', detail: `DNS points to ${target}; waiting for the HTTPS certificate` }; }
}

/** Delete the saved secret only if it still holds this token, so a newer one saved by a parallel run survives. */
export async function forgetCredential(token, file = CREDENTIAL_FILE) {
  try {
    if (JSON.parse(await readFile(file, 'utf8')).token !== token) return false;
    await unlink(file);
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** The saved token, or null when there is none. Throws if the file is unsafe or for another API. */
export async function savedCredential(api, file = CREDENTIAL_FILE, legacy = file === CREDENTIAL_FILE ? LEGACY_FILE : null) {
  let info;
  try { info = await lstat(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!legacy) return null;
    // No-replace move, so a racing run or a newer state.json is never overwritten.
    let linked = true;
    try { await link(legacy, file); } catch (e) { if (e.code === 'ENOENT') return null; if (e.code !== 'EEXIST') throw e; linked = false; }
    // A legacy copy left behind would bring the token back after `forget`, so undo our link and fail instead.
    try { await unlink(legacy); } catch (e) { if (e.code !== 'ENOENT') { if (linked) await unlink(file).catch(() => {}); throw e; } }
    return savedCredential(api, file, null);
  }
  if (!info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('Credential must be a regular file with mode 0600');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  if (saved.api !== api) throw new Error('Saved credential belongs to another API origin');
  if (!TOKEN.test(saved.token)) throw new Error('Invalid saved credential');
  return saved.token;
}

export async function localCredential(api, file = CREDENTIAL_FILE) {
  const existing = await savedCredential(api, file);
  if (existing) return existing;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const response = await fetch(`${api}/public/v1/anonymous/credentials`, { method: 'POST', redirect: 'error' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Credential issuance failed');
  if (!TOKEN.test(result.token)) throw new Error('Server returned an invalid credential');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ api, token: result.token }) + '\n');
    await handle.sync();
  } finally { await handle.close(); }
  try {
    // Atomic, no-replace publication. Racing processes all read the winning file.
    await link(temporary, file);
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await unlink(temporary); }
  return savedCredential(api, file);
}

// Folder names that say nothing about the site; the project around them names it instead.
const GENERIC_DIRS = new Set(['dist', 'build', 'out', 'public', 'site', 'www', '_site', 'output']);
// Names that would leave the person with a site called "dist" on their dashboard and claim page.
export const isGenericName = (name) => GENERIC_DIRS.has(name.toLowerCase()) || ['index', 'src', 'app', 'web', 'website', 'html', 'tmp', 'temp', 'untitled', 'new folder'].includes(name.toLowerCase());
const BUILD_OUTPUTS = ['dist', 'build', 'out', '_site', 'public'];

/** A project folder with a build script is built, and its output folder is what gets deployed. Otherwise the target itself. */
export async function buildIfProject(target, runner = run) {
  const pkg = await readJson(join(target, 'package.json'));
  if (!pkg?.scripts?.build) return target;
  const pm = await stat(join(target, 'pnpm-lock.yaml')).then(() => 'pnpm', () => stat(join(target, 'yarn.lock')).then(() => 'yarn', () => 'npm'));
  // Output folders only count if this build wrote them; an old dist/ or a source template must not be deployed.
  const started = Date.now() - 2000; // slack for coarse filesystem timestamps
  const steps = [];
  if (!await stat(join(target, 'node_modules')).catch(() => null)) steps.push([pm, ['install']]);
  steps.push([pm, ['run', 'build']]);
  for (const [cmd, args] of steps) {
    console.error(`Webly: running \`${cmd} ${args.join(' ')}\` in ${target}`);
    const result = runner(cmd, args, target);
    if (!result.ok) throw new Error(`\`${cmd} ${args.join(' ')}\` failed:\n${result.output.slice(-2000)}`);
  }
  const fresh = [];
  for (const dir of BUILD_OUTPUTS) {
    const info = await stat(join(target, dir, 'index.html')).catch(() => null);
    if (info && info.mtimeMs >= started) fresh.push(join(target, dir));
  }
  if (fresh.length === 1) { console.error(`Webly: deploying the build output ${fresh[0]}`); return fresh[0]; }
  if (fresh.length > 1) throw new Error(`The build wrote index.html to more than one folder (${fresh.join(', ')}). Run deploy on the output folder you mean.`);
  throw new Error(`Built, but no index.html was written to ${BUILD_OUTPUTS.join('/, ')}/ by this build. Run deploy on the output folder.`);
}

/** The site name: --name, else package.json "name", else the folder, skipping generic ones like dist. */
export async function siteName(target, isFile) {
  if (isFile) return basename(target, extname(target));
  let dir = resolve(target);
  for (let i = 0; i < 2; i++, dir = dirname(dir)) {
    const name = (await readJson(join(dir, 'package.json')))?.name?.replace(/^@[^/]+\//, '');
    if (name) return name;
    if (!GENERIC_DIRS.has(basename(dir))) return basename(dir);
  }
  return basename(resolve(target));
}

/** A folder, a single file, or a ready-made payload.json becomes an anonymous site body. */
export async function payloadFrom(target, name) {
  const info = await stat(target);
  if (info.isFile() && extname(target) === '.json') {
    const payload = JSON.parse(await readFile(target, 'utf8'));
    return name === undefined ? payload : { ...payload, name };
  }
  const found = [];
  if (info.isFile()) {
    found.push({ path: extname(target) === '.html' ? '/index.html' : `/${basename(target)}`, abs: target });
  } else {
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else if (entry.isFile()) found.push({ path: '/' + relative(target, abs).split(sep).join('/'), abs });
      }
    };
    await walk(target);
  }
  if (!found.length) throw new Error(`No files to publish in ${target}`);
  if (found.length > MAX_FILES) throw new Error(`${found.length} files found; anonymous sites take at most ${MAX_FILES}. Publish a built output folder, or sign in for larger sites.`);
  let total = 0;
  const files = [];
  for (const { path, abs } of found.sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = await readFile(abs);
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${path} is larger than 1 MiB, the anonymous per-file limit`);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('The files add up to more than 5 MiB, the anonymous per-site limit');
    const text = !bytes.includes(0) && isUtf8(bytes);
    files.push(text ? { path, content: bytes.toString('utf8') } : { path, content: bytes.toString('base64'), encoding: 'base64' });
  }
  name ??= await siteName(target, info.isFile());
  return { name: name.slice(0, 200) || 'Website', kind: 'static', files };
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** Where this machine's agent hosts have the Webly MCP server registered. Reads config files only. */
export async function mcpSetup(home = homedir()) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const claudeJson = await readJson(process.env.CLAUDE_CONFIG_DIR ? join(claudeDir, '.claude.json') : join(home, '.claude.json'));
  const settings = await readJson(join(claudeDir, 'settings.json'));
  const plugin = Object.entries(settings?.enabledPlugins ?? {}).some(([id, on]) => on && id.startsWith('webly@'));
  const userServer = Boolean(claudeJson?.mcpServers?.webly);
  const projectServer = Boolean(claudeJson?.projects?.[process.cwd()]?.mcpServers?.webly);
  const codexToml = await readFile(join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml'), 'utf8').catch(() => '');
  return {
    claudeCode: { configured: plugin || userServer || projectServer, via: plugin ? 'plugin' : userServer ? 'user' : projectServer ? 'project' : null },
    codex: { configured: /^\s*\[mcp_servers\.webly\]/m.test(codexToml) },
  };
}

const newer = (a, b) => {
  const [x, y] = [a, b].map(v => String(v).split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

/** A newer published skill, with the command that updates this install, or null. Never fails. */
export async function skillUpdate() {
  if (!LATEST_URL) return null;
  try {
    const latest = (await (await fetch(LATEST_URL, { signal: AbortSignal.timeout(3000) })).json()).version;
    if (!newer(latest, VERSION)) return null;
    const plugin = realpathSync(fileURLToPath(import.meta.url)).includes(`${sep}plugins${sep}`);
    return { installed: VERSION, latest, command: plugin
      ? 'claude plugin update webly@webly (then restart Claude Code or run /reload-plugins)'
      : 'npx skills update webly -g   (no npm: curl -fsSL https://webly.ai/install.sh | bash)' };
  } catch { return null; }
}

/** The version this replaced if it is the first run since an update, else null. Records VERSION. Never fails. */
export async function justUpdated(file = SEEN_FILE) {
  const seen = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (seen === VERSION) return null;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 }).then(() => writeFile(file, VERSION + '\n')).catch(() => {});
  // ponytail: installs from before 0.4.1 have no file yet, so their first update is recorded silently.
  return seen && newer(VERSION, seen) ? seen : null;
}

async function api(base, path, token, { timeout = 30_000, ...init } = {}) {
  const response = await fetch(`${base}/public/v1/anonymous${path}`, {
    ...init, redirect: 'error', signal: AbortSignal.timeout(timeout), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) };
}

/** Status calls are what publish a finished build, so poll until it is live or has failed. */
async function settle(base, token, result) {
  for (let i = 0; i < 90 && result.status === 'building'; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const next = await api(base, '/sites/current', token);
    if (!next.ok) return result;
    result = next.body;
  }
  return result;
}

async function openInBrowser(url) {
  const [cmd, ...args] = process.env.WEBLY_OPEN_CMD ? [process.env.WEBLY_OPEN_CMD]
    : process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""'] : ['xdg-open'];
  await new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args, url], { stdio: 'ignore' });
    // Child-process errors and output can contain the secret URL. Only report
    // a fixed diagnostic, and keep the saved credential available for retry.
    const failed = () => reject(new Error('Could not open the claim page. Check your browser opener and retry; the saved token was kept.'));
    const timer = setTimeout(() => { child.kill(); failed(); }, 15_000);
    child.once('error', () => { clearTimeout(timer); failed(); });
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : failed(); });
  });
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 600_000, cwd, shell: process.platform === 'win32' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(), missing: result.error?.code === 'ENOENT' };
}

async function main() {
  const base = new URL(process.env.WEBLY_API_URL || 'https://api.webly.ai').origin;
  const url = new URL(base);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Use HTTPS (HTTP is allowed only for localhost)');
  const argv = process.argv.slice(2);
  const nameAt = argv.indexOf('--name');
  const nameFlag = nameAt === -1 ? undefined : argv.splice(nameAt, 2)[1];
  const folderAt = argv.indexOf('--folder');
  const folderFlag = folderAt === -1 ? undefined : argv.splice(folderAt, 2)[1];
  const [command, argument, extra] = argv;
  const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  const readPending = async () => (await readFile(PENDING_FILE, 'utf8').catch(() => '')).trim() || null;

  if (command === 'pending') {
    if (argument === 'set' && extra) { await mkdir(dirname(PENDING_FILE), { recursive: true, mode: 0o700 }); await writeFile(PENDING_FILE, extra + '\n'); return print(`Pending: ${extra}`); }
    if (argument === 'clear') { await unlink(PENDING_FILE).catch(() => {}); return print('Pending cleared'); }
    throw new Error('Usage: webly.mjs pending set <intent> | clear');
  }

  if (command === 'domain-watch') {
    const host = String(argument ?? '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!host) throw new Error('Usage: webly.mjs domain-watch <hostname> [--timeout MIN]');
    const minutes = extra === '--timeout' ? Number(argv[3]) : 120;
    if (!(Number.isFinite(minutes) && minutes > 0) || (extra !== undefined && extra !== '--timeout')) throw new Error('Usage: webly.mjs domain-watch <hostname> [--timeout MIN]  (MIN is a number of minutes above 0)');
    const deadline = Date.now() + minutes * 60_000;
    // ponytail: fixed 30 s poll of one host; the server re-checks Cloudflare on its own every few minutes.
    for (let last = ''; ;) {
      const { stage, detail } = await domainStage(host);
      if (stage + detail !== last) print(`${new Date().toISOString().slice(11, 19)} ${stage}: ${detail}`);
      last = stage + detail;
      if (stage === 'live') return;
      if (Date.now() > deadline) { process.exitCode = 1; return print(`Still at "${stage}" after ${minutes} min. Run domain-watch again, or call verify_domain for the server's view.`); }
      await new Promise(done => setTimeout(done, 30_000));
    }
  }

  if (command === 'doctor') {
    // The session-start hook allows 10 s; the update check runs alongside the status call.
    const brief = argument === '--brief';
    const updateCheck = skillUpdate();
    const report = { version: VERSION, updatedFrom: await justUpdated(), update: null, api: base, credentialFile: CREDENTIAL_FILE, credential: 'none', site: null, siteError: null, mcp: await mcpSetup(), pending: await readPending() };
    let token = null;
    try { token = await savedCredential(base); } catch (error) { report.credential = `unusable: ${error.message}`; }
    if (token) {
      report.credential = 'present';
      const current = await api(base, '/sites/current', token, { timeout: brief ? 4000 : 30_000 }).catch(error => ({ ok: false, status: 0, body: { message: `Webly unreachable: ${error.message}` } }));
      if (current.ok) report.site = current.body;
      else {
        report.siteError = { status: current.status, reason: current.body.details?.reason ?? null, message: current.body.message ?? null };
        if (SPENT.has(report.siteError.reason) && await forgetCredential(token)) report.credential = 'none (spent token removed)';
      }
    }
    // A claim can't be pending without a token to claim with.
    if (report.pending === 'claim' && !report.credential.startsWith('present')) { await unlink(PENDING_FILE).catch(() => {}); report.pending = null; }
    report.update = await updateCheck;
    if (!brief) return print(report);
    const parts = [];
    if (report.site) {
      const s = report.site;
      parts.push(`anonymous site "${s.name}" is ${s.status}${s.urls.published ? ` at ${s.urls.published}` : ''}. ${s.next?.message ?? ''}`.trim());
    } else if (report.credential === 'present') parts.push(report.siteError?.status === 404 ? 'a token is saved but no site was deployed yet.' : 'an anonymous site is saved on this machine (status unavailable right now).');
    if (report.pending) parts.push(`Unfinished step from an earlier session: ${report.pending}.`);
    if (parts.length) print(`Webly: ${parts.join(' ')} Use the webly skill to continue.`);
    // Hook output reaches the agent, not the person, so say what to pass on.
    if (report.updatedFrom) print(`Webly skill was updated from ${report.updatedFrom} to ${VERSION}. Tell the user in one line.`);
    if (report.update) print(`Webly skill ${report.update.latest} is available (installed ${VERSION}). Tell the user in one line and offer to run: ${report.update.command}`);
    return;
  }

  if (command === 'connect') {
    // Tools registered mid-session aren't callable until a reload; don't block the claim on one.
    const CLAIM_FALLBACK = (hasToken) => hasToken
      ? 'If Webly tools are callable: call create_claim_code, then run `webly claim <code>` (never read the token yourself). If they are not, do not ask for a reload: run `webly claim-link --open` now so the person claims in the browser. MCP loads next session.'
      : 'Webly tools load after /reload-plugins or in the next session.';
    const mcpUrl = `${base}/v1/mcp`;
    const setup = await mcpSetup();
    const hasToken = Boolean(await savedCredential(base).catch(() => null));
    if (hasToken) { await mkdir(dirname(PENDING_FILE), { recursive: true, mode: 0o700 }); await writeFile(PENDING_FILE, 'claim\n'); }
    if (argument === 'claude') {
      if (!setup.claudeCode.configured || setup.claudeCode.via === 'project') {
        const official = base === 'https://api.webly.ai';
        // The plugin reloads mid-session; a plain server entry needs a new session.
        let via = null, log = [];
        if (official) {
          const market = run('claude', ['plugin', 'marketplace', 'add', PLUGIN_MARKETPLACE]);
          if (market.missing) throw new Error('The claude CLI is not on PATH. Run: claude mcp add --scope user --transport http webly ' + mcpUrl);
          // `add` leaves an already-added marketplace at its old clone, which would install a stale plugin.
          log.push(run('claude', ['plugin', 'marketplace', 'update', 'webly']).output);
          const install = run('claude', ['plugin', 'install', 'webly@webly', '--scope', 'user', '-y']);
          log.push(market.output, install.output);
          if (install.ok) {
            via = 'plugin';
            // The plugin ships this skill; a standalone copy (install.sh / npx skills) would load it twice.
            await rm(join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills', 'webly'), { recursive: true, force: true });
          }
        }
        if (!via) {
          const add = run('claude', ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'webly', mcpUrl]);
          log.push(add.output);
          if (!add.ok && !/already exists/i.test(add.output)) throw new Error(`Could not register the MCP server:\n${log.filter(Boolean).join('\n')}`);
          via = 'user';
        }
        return print({ connected: 'claude-code', via, mcpUrl, pending: hasToken ? 'claim' : null, next: CLAIM_FALLBACK(hasToken) });
      }
      return print({ connected: 'claude-code', via: setup.claudeCode.via, mcpUrl, pending: hasToken ? 'claim' : null, next: 'Already configured. If Webly tools are loaded, use them. ' + CLAIM_FALLBACK(hasToken) });
    }
    if (argument === 'codex') {
      if (!setup.codex.configured) {
        const add = run('codex', ['mcp', 'add', 'webly', '--url', mcpUrl]);
        if (add.missing) throw new Error('The codex CLI is not on PATH. Add to ~/.codex/config.toml:\n[mcp_servers.webly]\nurl = "' + mcpUrl + '"');
        if (!add.ok) throw new Error(`codex mcp add failed:\n${add.output}`);
      }
      return print({ connected: 'codex', mcpUrl, pending: hasToken ? 'claim' : null,
        next: 'Run `codex mcp login webly` in the foreground and keep it running until the person clicks Allow. Tools load in a new session: the person runs `codex resume --last`.' });
    }
    throw new Error('Usage: webly.mjs connect claude|codex');
  }

  if (command === 'forget') {
    const token = await savedCredential(base);
    if (token) {
      const current = await api(base, '/sites/current', token);
      if (current.ok || !SPENT.has(current.body.details?.reason)) {
        throw new Error('Claim completion is not confirmed. The saved token and pending step were kept; finish claiming in the browser or over MCP, then retry.');
      }
      await forgetCredential(token);
    }
    await unlink(PENDING_FILE).catch(() => {});
    return print(token ? 'Saved token removed' : 'No saved token');
  }

  if (command === 'claim') {
    const token = await savedCredential(base);
    if (!token) throw new Error('No website deployed without an account is saved on this computer, so there is nothing to claim.');
    if (!/^wc_[\w.-]+$/.test(argument ?? '')) throw new Error('Usage: webly.mjs claim <code>  (get the code from the create_claim_code MCP tool)');
    const response = await fetch(`${base}/api/anonymous/claim`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, code: argument }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (SPENT.has(result.details?.reason)) { await forgetCredential(token); await unlink(PENDING_FILE).catch(() => {}); }
      throw new Error(`${result.message || `Claim failed (${response.status})`}${result.details?.reason ? ` [${result.details.reason}]` : ''}`);
    }
    await forgetCredential(token);
    await unlink(PENDING_FILE).catch(() => {});
    return print({ claimed: true, alreadyClaimed: result.alreadyClaimed ?? false, name: result.website?.name, url: result.website?.urls?.published ?? null, claimHeld: result.website?.claimHeld, dashboardUrl: result.dashboardUrl, billingUrl: result.billingUrl });
  }

  if (!['init', 'deploy', 'replace', 'update', 'status', 'claim-link', 'upload'].includes(command)) throw new Error(USAGE);
  const token = await localCredential(base);
  if (command === 'init') return print(`Credential saved to ${CREDENTIAL_FILE}`);
  const failed = async (result, fallback) => {
    if (SPENT.has(result.details?.reason) && await forgetCredential(token)) {
      throw new Error(`${result.message || fallback} The saved credential is spent and was removed; the next deploy creates a new one.`);
    }
    const reason = result.details?.reason ? ` [${result.details.reason}]` : '';
    throw new Error(`${result.message || fallback}${reason}`);
  };

  if (command === 'claim-link') {
    const current = await api(base, '/sites/current', token);
    if (!current.ok) await failed(current.body, 'Could not find a claimable site');
    // The token rides in the fragment, which browsers never send to a server. Printing it is an explicit choice.
    const link = `${current.body.claimPage}#token=${encodeURIComponent(token)}`;
    if (argument === '--open') { await openInBrowser(link); return print(`Opened the claim page in the browser for "${current.body.name}". Finish sign-in and click Claim website; opening this page does not complete the claim.`); }
    return print(link);
  }

  if (command === 'status') {
    const current = await api(base, '/sites/current', token);
    if (!current.ok) await failed(current.body, `Request failed (${current.status})`);
    return print(current.body);
  }

  if (command === 'upload') return print(await uploadFiles(base, token, argv.slice(1), { folder: folderFlag, name: nameFlag, failed }));

  if (!argument) throw new Error(`${command} needs a folder, a file or a payload.json`);
  const target = await stat(argument).then(i => i.isDirectory(), () => false) ? await buildIfProject(argument) : argument;
  const body = await payloadFrom(target, nameFlag);
  let response;
  const current = command === 'replace' ? null : await api(base, '/sites/current', token);
  if (current?.ok || command === 'update') {
    // One live site per token: publishing again updates it in place and keeps its URL.
    if (!current?.ok) await failed(current.body, 'No site to update');
    const { kind, ...rest } = body;
    response = await api(base, `/sites/${encodeURIComponent(current.body.id)}`, token, { method: 'PUT', body: JSON.stringify({ ...rest, expectedHeadVersion: current.body.headVersion }) });
  } else {
    // Only creation takes the name; updates keep whatever the site is already called.
    const named = typeof body.name === 'string' ? body.name.trim() : '';
    if (!nameFlag && (!named || isGenericName(named))) {
      throw new Error(`Not deployed: the site would be ${named ? `named "${named}", which says nothing about it` : 'unnamed'}. Ask the person what this project is called. ` +
        'Make clear it is only the name shown in their Webly dashboard and on the claim page, not the web address: the URL is assigned automatically (https://anon-….webly.site). ' +
        `Then rerun: webly ${command} ${argument} --name "<their answer>"`);
    }
    response = await api(base, '/sites', token, { method: 'POST', body: JSON.stringify(command === 'replace' ? { ...body, replace: true } : body) });
  }
  if (!response.ok) await failed(response.body, `Request failed (${response.status})`);
  print(await settle(base, token, response.body));
}

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', json: 'application/json', zip: 'application/zip', html: 'text/html' };

/**
 * Files named on the command line; folders contribute every file, hidden ones included (only
 * macOS's .DS_Store is left out), and keep their structure: `upload ./test` names them
 * "src/main.cpp", and with several arguments a folder's files go under its own name.
 */
async function filesFrom(paths) {
  const out = [];
  const lone = paths.length === 1 && (await stat(paths[0])).isDirectory();
  async function add(path, name) {
    const info = await stat(path);
    if (info.isDirectory()) { for (const entry of await readdir(path)) if (entry !== '.DS_Store') await add(join(path, entry), name ? `${name}/${entry}` : entry); }
    else if (info.isFile()) out.push({ path, name: name || basename(path), byteSize: info.size, mimeType: MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream' });
  }
  for (const p of paths) await add(p, lone ? '' : basename(resolve(p)));
  return out;
}

/**
 * Anonymous file sharing: a storage site on this machine's credential (created on first use),
 * one batch per run into its own folder. Bytes go straight to storage with the presigned PUTs.
 */
async function uploadFiles(base, token, paths, { folder, name, failed }) {
  if (!paths.length) throw new Error('Usage: webly.mjs upload <file|dir>... [--folder name] [--name "Shared files"]');
  let files = await filesFrom(paths);
  if (!files.length) throw new Error('No files found to upload');
  // A big folder goes up as one zip the server serves from inside: one upload instead of thousands.
  const archived = files.length > ARCHIVE_OVER ? files.length : 0;
  if (archived) files = [await zipToTemp(files, `${basename(resolve(paths[0]))}.zip`)];
  const results = [];
  const errors = [];
  let first;
  try {
    const current = await api(base, '/sites/current', token);
    let site = current.ok ? current.body : null;
    if (site && site.kind !== 'storage') throw new Error(`This computer's anonymous credential already holds a website ("${site.name}"). Claim it first (webly.mjs claim-link), then share files from the account.`);
    if (!site) {
      const created = await api(base, '/sites', token, { method: 'POST', body: JSON.stringify({ name: name || 'Shared files', kind: 'storage' }) });
      if (!created.ok) await failed(created.body, `Could not create the storage site (${created.status})`);
      site = created.body;
    }
    // A batch holds up to 1000 files; a bigger folder goes up in several, all into the same folder.
    for (let i = 0; i < files.length; i += 1000) {
      const chunk = files.slice(i, i + 1000);
      const out = await uploadBatch(base, token, site, folder ?? first?.folder, chunk, errors, failed);
      first ??= out.begun;
      results.push(...out.files);
    }
  } finally {
    // The temp zip can be hundreds of MiB: never leave it behind, even when the upload fails.
    if (archived) await rm(files[0].path, { force: true });
  }
  if (archived && results[0]?.ok) return {
    folderUrl: first.folderUrl, zipUrl: first.zipUrl, expiresAt: first.expiresAt,
    archive: { files: archived, note: `Over ${ARCHIVE_OVER} files, so they went up as one zip: the folder link, its subfolders and every file's link work as usual (read-only), and Download all is the zip.` },
    next: 'These links stop working after 24 hours. To keep the files, claim them into a free account (1 GB): webly.mjs claim-link --open, or create_claim_code over MCP then webly.mjs claim <code>.',
  };
  return {
    folderUrl: first.folderUrl, zipUrl: first.zipUrl, expiresAt: first.expiresAt,
    // name is the path inside the folder ("sub/c.txt"), so the structure shows.
    files: results.map((f) => f.ok ? { name: f.path ? f.path.split('/').slice(2).join('/') : f.name, url: f.url, size: f.size } : { id: f.id, error: f.error }),
    ...(errors.length ? { errors } : {}),
    next: 'These links stop working after 24 hours. To keep the files, claim them into a free account (1 GB): webly.mjs claim-link --open, or create_claim_code over MCP then webly.mjs claim <code>.',
  };
}

/** Folders with more files than this upload as one archive zip. */
const ARCHIVE_OVER = 500;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Writes the files into a store-only zip in the temp folder, one file in memory at a time. Names are
 * the files' paths inside the folder, so the server serves the same structure. Plain zip, not ZIP64:
 * at most 65,535 files and 4 GB, well above the anonymous allowance.
 */
async function zipToTemp(files, name) {
  if (files.length > 0xffff) throw new Error(`${files.length} files; one archive holds at most 65535`);
  const path = join(tmpdir(), `webly-${randomUUID()}.zip`);
  const out = await open(path, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const f of files) {
      const data = await readFile(f.path);
      const fileName = Buffer.from(f.name);
      const header = (size) => Buffer.alloc(size);
      const crc = crc32(data);
      const local = header(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
      local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26);
      const cd = header(46);
      cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x800, 8);
      cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(fileName.length, 28); cd.writeUInt32LE(offset, 42);
      if (offset + 30 + fileName.length + data.length > 0xffffffff) throw new Error('The folder is over 4 GB; share it in parts');
      await out.write(Buffer.concat([local, fileName, data]));
      central.push(cd, fileName);
      offset += 30 + fileName.length + data.length;
    }
    const cdBytes = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cdBytes.length, 12); end.writeUInt32LE(offset, 16);
    await out.write(Buffer.concat([cdBytes, end]));
  } finally { await out.close(); }
  return { path, name, byteSize: (await stat(path)).size, mimeType: 'application/zip', archive: true };
}

/** Begin, PUT and finalize one batch of up to 1000 files; what doesn't finish is cancelled. */
async function uploadBatch(base, token, site, folder, files, errors, failed) {
  const begun = await api(base, `/sites/${encodeURIComponent(site.id)}/objects/uploads`, token, { method: 'POST', body: JSON.stringify({ folder, files: files.map(({ name, byteSize, mimeType, archive }) => ({ name, byteSize, mimeType, archive })) }) });
  if (!begun.ok) await failed(begun.body, `Upload refused (${begun.status})`);
  // One PUT per small file, one per 100 MiB part of a larger one (a part is a byte range of the file).
  const queue = [];
  begun.body.files.forEach((f, i) => {
    if (f.upload) queue.push({ name: f.name, url: f.upload.url, headers: { ...f.upload.headers }, path: files[i].path });
    for (const p of f.parts ?? []) queue.push({ name: `${f.name} part ${p.partNumber}`, url: p.url, headers: {}, path: files[i].path, start: (p.partNumber - 1) * f.partSize, size: p.size });
  });
  const bytesOf = async (job) => {
    if (job.start === undefined) return readFile(job.path);
    const handle = await open(job.path, 'r');
    try { const buf = Buffer.alloc(job.size); await handle.read(buf, 0, job.size, job.start); return buf; } finally { await handle.close(); }
  };
  // Two at a time, each retried: large uploads get reset now and then, and a presigned URL can be re-sent.
  await Promise.all(Array.from({ length: 2 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      // Local servers without presigning take the PUT themselves and want this credential.
      if (job.url.startsWith(base)) job.headers.Authorization = `Bearer ${token}`;
      delete job.headers['Content-Length'];
      const body = await bytesOf(job);
      let response;
      for (let attempt = 1; attempt <= 4; attempt++) {
        response = await fetch(job.url, { method: 'PUT', headers: job.headers, body, signal: AbortSignal.timeout(15 * 60_000) }).catch((e) => ({ ok: false, status: e.message }));
        if (response.ok || (response.status >= 400 && response.status < 500)) break;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
      if (!response.ok) errors.push(`${job.name}: upload failed (${response.status})`);
    }
  }));
  const finalized = await api(base, `/sites/${encodeURIComponent(site.id)}/objects/finalize`, token, { method: 'POST', body: JSON.stringify({ ids: begun.body.files.map((f) => f.id) }) });
  // Cancel what didn't finish, so a retry isn't blocked by the abandoned upload.
  const done = new Set(finalized.ok ? finalized.body.files.filter((f) => f.ok).map((f) => f.id) : []);
  for (const f of begun.body.files) if (!done.has(f.id)) await api(base, `/sites/${encodeURIComponent(site.id)}/objects/${encodeURIComponent(f.id)}`, token, { method: 'DELETE' }).catch(() => {});
  if (!finalized.ok) await failed(finalized.body, `Finalize failed (${finalized.status})`);
  return { begun: begun.body, files: finalized.body.files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // doctor --brief runs as a session-start hook: it must never break a session.
  const brief = process.argv[2] === 'doctor' && process.argv[3] === '--brief';
  main().catch(error => { if (!brief) { console.error(error.message); process.exitCode = 1; } });
}
