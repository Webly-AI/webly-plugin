# Windows twin of install.sh: installs the Webly agent skill for Claude Code
# (~/.claude/skills) and Codex and other agents (~/.agents/skills). It does not register
# the MCP server: the skill does that when the person signs in to keep a site.
# Run with: irm https://webly.ai/install.ps1 | iex   (works under the Restricted policy)
$ErrorActionPreference = 'Stop'

$repoBase = 'https://raw.githubusercontent.com/Webly-AI/webly-plugin/main/skills/webly'
$claudeDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$targets = @((Join-Path $claudeDir 'skills\webly'), (Join-Path $HOME '.agents\skills\webly'))

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Warning "node (20+) is required to run the skill's helper; install it before publishing"
}

$stage = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName())
try {
  New-Item -ItemType Directory -Force (Join-Path $stage 'scripts') | Out-Null
  Invoke-WebRequest "$repoBase/SKILL.md" -OutFile (Join-Path $stage 'SKILL.md') -UseBasicParsing
  Invoke-WebRequest "$repoBase/scripts/webly.mjs" -OutFile (Join-Path $stage 'scripts\webly.mjs') -UseBasicParsing

  foreach ($target in $targets) {
    # A link here belongs to `npx skills`; replace it with a real copy.
    # Delete only the link itself: Remove-Item -Recurse follows it on Windows PowerShell 5.1.
    $existing = Get-Item $target -Force -ErrorAction SilentlyContinue
    if ($existing -and $existing.Attributes -band [IO.FileAttributes]::ReparsePoint) { $existing.Delete() }
    elseif ($existing) { Remove-Item $target -Recurse -Force }
    New-Item -ItemType Directory -Force $target | Out-Null
    Copy-Item (Join-Path $stage '*') $target -Recurse -Force
    "installed $target"
  }
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

''
'done - Webly skill installed.'
'Claude Code picks it up right away (or run /reload-skills); Codex and others load it in a new session.'
