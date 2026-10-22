param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$Build,
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][string]$Version,
  [ValidateSet('x64', 'arm64')][string]$Arch = 'x64'
)

$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath $Archive -DestinationPath $Build -Force
Copy-Item -LiteralPath (Join-Path $Build "node-v$Version-win-$Arch\node.exe") -Destination $Destination -Force
Copy-Item -LiteralPath (Join-Path $Build "node-v$Version-win-$Arch\LICENSE") -Destination (Join-Path (Split-Path $Destination) 'LICENSE') -Force
