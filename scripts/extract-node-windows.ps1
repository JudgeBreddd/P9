param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$Build,
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][string]$Version
)

$ErrorActionPreference = 'Stop'
Expand-Archive -LiteralPath $Archive -DestinationPath $Build -Force
Copy-Item -LiteralPath (Join-Path $Build "node-v$Version-win-x64\node.exe") -Destination $Destination -Force
Copy-Item -LiteralPath (Join-Path $Build "node-v$Version-win-x64\LICENSE") -Destination (Join-Path (Split-Path $Destination) 'LICENSE') -Force
