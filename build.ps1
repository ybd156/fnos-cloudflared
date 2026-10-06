<#
.SYNOPSIS
    Build the Cloudflare Tunnel .fpk package for fnOS (Windows host).

.DESCRIPTION
    Windows counterpart to build.sh. The project is normally packed on the NAS,
    but this host has no bash and no fnpack on PATH, so this script drives the
    same pipeline with the official fnpack binary and a local Node/Python.

    Steps: regenerate icons, validate, pack with fnpack, normalise the archive
    permission bits (Windows has no executable bit, so fnpack would otherwise
    emit cmd/* and bin/cloudflared as 0666 and the app could not start), then
    verify the artefact against the source tree.

.PARAMETER NoIcons
    Skip icon regeneration.

.PARAMETER Fnpack
    Path to the fnpack executable. Defaults to $env:FNPACK, then
    work/fnpack/fnpack-1.2.3.exe.

.EXAMPLE
    pwsh -File build.ps1
    pwsh -File build.ps1 -NoIcons -Fnpack C:\tools\fnpack.exe
#>
[CmdletBinding()]
param(
    [switch]$NoIcons,
    [string]$Fnpack
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Project = Join-Path $Root 'cloudflared'
$Dist = Join-Path $Root 'dist'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Die($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }

# Resolve a command to its path, or $null. Under StrictMode, touching .Source on
# the $null that Get-Command returns for a miss throws, so guard every lookup.
function Get-CommandPath($name) {
    $c = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -eq $c) { return $null }
    return $c.Source
}

# ------------------------------------------------------------- tool discovery
# The bundled runtime location differs between DSH installs, so probe the known
# layouts instead of hard-coding one. Both are only fallbacks: PATH wins.
$RuntimeRoots = @(
    'D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies',
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies')
)

function Find-Bundled($relative) {
    foreach ($root in $RuntimeRoots) {
        $candidate = Join-Path $root $relative
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

$node = Get-CommandPath 'node'
if (-not $node) { $node = Find-Bundled 'node\bin\node.exe' }
if (-not $node) { Die 'node not found (add it to PATH or set a runtime path in this script)' }

$PyExe = Find-Bundled 'python\python.exe'
if (-not $PyExe) {
    $py = Get-CommandPath 'python'
    if (-not $py) { Die 'python not found' }
    $PyExe = $py
}

if (-not $Fnpack) { $Fnpack = $env:FNPACK }
if (-not $Fnpack) {
    $candidate = Join-Path $Root 'work\fnpack\fnpack-1.2.3.exe'
    if (Test-Path $candidate) { $Fnpack = $candidate }
}
if (-not $Fnpack) {
    $onPath = Get-CommandPath 'fnpack'
    if ($onPath) { $Fnpack = $onPath }
}
if (-not $Fnpack -or -not (Test-Path $Fnpack)) {
    Die "fnpack not found. Download the official binary from https://static2.fnnas.com/fnpack/ and pass -Fnpack <path>"
}

if (-not (Test-Path $Project)) { Die "application source directory not found: $Project" }

Write-Host "node   : $node"
Write-Host "python : $PyExe"
Write-Host "fnpack : $Fnpack"

# ------------------------------------------------------------------- binary
# The 38MB cloudflared binary is not tracked in git (see .gitignore): it is an
# upstream build nobody here edits, and committing it would put it into every
# clone and into the permanent history. Fetch the pinned release instead and
# verify its SHA-256. Without --force a correct local copy is reused.
Step 'Ensuring the cloudflared binary'
& $PyExe (Join-Path $Root 'tools\fetch-cloudflared.py')
if ($LASTEXITCODE -ne 0) { Die 'could not obtain the pinned cloudflared binary' }

# ------------------------------------------------------------------- icons
if (-not $NoIcons) {
    Step 'Generating icons'
    & $PyExe (Join-Path $Root 'tools\make-icons.py')
    if ($LASTEXITCODE -ne 0) { Die 'icon generation failed' }
}
else {
    Step 'Skipping icon generation'
}

# -------------------------------------------------------------- validation
Step 'Validating backend module bindings'
& $node (Join-Path $Root 'tools\lint-requires.mjs')
if ($LASTEXITCODE -ne 0) { Die 'a backend module uses a namespace it never requires' }

# A selector pointing at an element that does not exist fails silently: the
# handler binds to nothing and the control simply stops working, with no error
# anywhere. Nothing else in the pipeline can see that, so check it here.
Step 'Validating UI selectors'
& $node (Join-Path $Root 'tools\lint-ui.mjs')
if ($LASTEXITCODE -ne 0) { Die 'the web UI references a selector that does not resolve' }

# A shell edit is otherwise reviewed by eye only: there is no bash on this host,
# and the mistakes that matter (an unbound ${TRIM_X} under `set -u`, a bare
# `node` absent on the NAS, an unbalanced quote) are invisible to inspection.
Step 'Validating shell scripts (static)'
& $node (Join-Path $Root 'tools\lint-shell.mjs')
if ($LASTEXITCODE -ne 0) { Die 'a lifecycle script has a static defect' }

Step 'Validating JavaScript syntax'
$jsFiles = @(Join-Path $Project 'app\server\server.js')
$jsFiles += Get-ChildItem (Join-Path $Project 'app\server\lib') -Filter *.js | ForEach-Object FullName
$jsFiles += Join-Path $Project 'app\www\app.js'
foreach ($js in $jsFiles) {
    & $node --check $js
    if ($LASTEXITCODE -ne 0) { Die "syntax error in $js" }
}
Write-Host "  backend + frontend JavaScript OK"

Step 'Validating JSON files'
$jsonFiles = @(
    (Join-Path $Project 'config\privilege'),
    (Join-Path $Project 'config\resource'),
    (Join-Path $Project 'app\ui\config')
) + (Get-ChildItem (Join-Path $Project 'wizard') | ForEach-Object FullName)
& $PyExe (Join-Path $Root 'tools\validate-json.py') @jsonFiles
if ($LASTEXITCODE -ne 0) { Die 'invalid JSON in config/privilege, config/resource, app/ui/config or wizard/' }

Step 'Checking required files'
$required = @(
    'manifest', 'ICON.PNG', 'ICON_256.PNG', 'config\privilege', 'config\resource',
    'app\ui\config', 'app\bin\cloudflared', 'app\server\server.js', 'app\www\index.html'
)
foreach ($rel in $required) {
    if (-not (Test-Path (Join-Path $Project $rel))) { Die "missing required file: $rel" }
}
Write-Host '  all required files present'

# ------------------------------------------------------------------ packing
Step "Packing with fnpack"
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$fpk = Join-Path $Dist 'cloudflared.fpk'
if (Test-Path $fpk) { Remove-Item $fpk -Force }

Push-Location $Dist
try {
    & $Fnpack build -d $Project
    if ($LASTEXITCODE -ne 0) { Die 'fnpack build failed' }
}
finally { Pop-Location }

if (-not (Test-Path $fpk)) { Die "expected $fpk was not produced" }

# ------------------------------------------------- archive normalisation
# fnpack takes archive modes from the host filesystem's stat(). Windows has no
# executable bit, so every file lands 0666 and every directory 0777, leaving
# cmd/main and app/bin/cloudflared non-executable on the NAS. Rewrite the modes
# in both tar layers and repair the manifest checksum (MD5 of the new app.tgz).
Step 'Normalising archive permissions'
& $PyExe (Join-Path $Root 'tools\normalize-fpk.py') $fpk
if ($LASTEXITCODE -ne 0) { Die 'archive permission normalisation failed' }

# --------------------------------------------------------- verification
# fnpack reports success as long as required files exist -- it does not check
# the archive against the source tree, so a stale build still prints "Packing
# successfully". Assert what the artefact actually contains before shipping.
Step 'Verifying packaged artefact'
& $PyExe (Join-Path $Root 'tools\verify-fpk.py') $fpk $Project
if ($LASTEXITCODE -ne 0) { Die 'packaged artefact failed verification' }

# --------------------------------------------------------------- result
Step 'Result'
$item = Get-Item $fpk
$hash = (Get-FileHash $fpk -Algorithm SHA256).Hash.ToLower()
Write-Host "  $fpk"
Write-Host ("  size    : {0} bytes ({1:N1} MB)" -f $item.Length, ($item.Length / 1MB))
Write-Host "  sha256  : $hash"
Write-Host "  md5(app.tgz): see manifest checksum above"
