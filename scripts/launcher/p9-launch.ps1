# AU4: the 'P9 Foundation' task runs this fixed copy in %LOCALAPPDATA%\P9\launcher. It starts the daemon version that
# daemon\current names (install-windows.ps1 copies each version to daemon\<version>), so an update or a rollback only
# rewrites current. -Payload is install-windows.ps1's; its node and server become current's.
param([string]$Log, [string]$Payload)
$ErrorActionPreference = 'Stop'
# What stopped it goes to daemon.log, which teh doctor reads, since nothing else shows this host's output.
trap { if ($Log) { Add-Content -LiteralPath $Log -Value ((Get-Date -Format o) + ' launcher failed: ' + $_) }; exit 1 }
$root = Split-Path -Parent $PSScriptRoot
$version = [IO.File]::ReadAllText((Join-Path $root 'daemon\current')).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') { throw 'daemon\current is unreadable' }
$dir = Join-Path $root ('daemon\' + $version)
$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$decoded.argv[0] = Join-Path $dir 'node.exe'
$decoded.argv[1] = Join-Path $dir 'apps\server\main.mjs'
$current = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($decoded | ConvertTo-Json -Compress -Depth 4)))
& (Join-Path $dir 'scripts\windows-host.ps1') -Mode Daemon -Log $Log -Payload $current
exit $LASTEXITCODE
