param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$Build,
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][string]$Version,
  [ValidateSet('x64', 'arm64')][string]$Arch = 'x64'
)

$ErrorActionPreference = 'Stop'
# O151: Expand-Archive under Windows PowerShell 5.1 failed on the windows-11-arm runner image (20261112) with "Cannot find
# an overload for ExtractToDirectory and the argument count: 3". Windows' own tar.exe (bsdtar, in System32 since Windows 10
# 1803) reads zip files; the full path keeps any other tar on PATH (a GNU tar cannot read zip) out of it.
New-Item -ItemType Directory -Force -Path $Build | Out-Null
& (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $Archive -C $Build
if ($LASTEXITCODE -ne 0) { throw "tar-extract-failed-$LASTEXITCODE" }
Copy-Item -LiteralPath (Join-Path $Build "node-v$Version-win-$Arch\node.exe") -Destination $Destination -Force
Copy-Item -LiteralPath (Join-Path $Build "node-v$Version-win-$Arch\LICENSE") -Destination (Join-Path (Split-Path $Destination) 'LICENSE') -Force
