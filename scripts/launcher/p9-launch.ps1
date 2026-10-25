# AU4: the 'P9 Foundation' task runs this fixed copy in %LOCALAPPDATA%\P9\launcher. It starts the daemon version that
# daemon\current names (install-windows.ps1 copies each version to daemon\<version>), so an update or a rollback only
# rewrites current. -Payload is install-windows.ps1's; its node and server become current's.
# AU5 (threat model row 40): -Rollback is the app's, from a version that failed 2 starts (apps/desktop/rollback.mjs).
# It waits for that app to quit, runs the kept installer of -To (or the release's, checked against its latest.yml) with
# /S, sets daemon\current back, writes rollback.json and rollback.log beside this folder, and starts the app again.
# An update writes its launcher as p9-launch.ps1.next; the app renames it over this one after a healthy start, so the
# launcher that runs a rollback is always from a version that started.
param([string]$Log, [string]$Payload, [switch]$Rollback, [string]$To, [string]$From, [string]$App, [string]$Arch, [int]$AppPid)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
# What stopped it goes to daemon.log, which teh doctor reads, since nothing else shows this host's output; a rollback's to
# rollback.log, which the restored app shows.
function Note([string]$Text) { [IO.File]::AppendAllText((Join-Path $root 'rollback.log'), (Get-Date -Format o) + ' ' + $Text + [Environment]::NewLine) }
trap {
  if ($Rollback) { Note ('rollback failed: ' + $_) } elseif ($Log) { Add-Content -LiteralPath $Log -Value ((Get-Date -Format o) + ' launcher failed: ' + $_) }
  exit 1
}
$pattern = '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$'

if ($Rollback) {
  # Windows PowerShell under a PowerShell 7 process inherits 7's module folders (install-windows.ps1 says why that breaks).
  if ($PSVersionTable.PSEdition -eq 'Desktop') { $env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -notmatch '\\PowerShell\\' }) -join ';' }
  if ($To -notmatch $pattern -or $From -notmatch $pattern -or $To -eq $From) { throw 'refused: a version' }
  if ($Arch -cnotin @('x64', 'arm64')) { throw 'refused: the arch' }
  if (-not $App -or -not [IO.Path]::IsPathRooted($App) -or [IO.Path]::GetFileName($App) -ne 'P9 Event Horizon.exe' -or -not (Test-Path -LiteralPath $App -PathType Leaf)) { throw 'refused: the app' }
  if ($AppPid -le 0) { throw 'refused: the process id' }
  Note ('P9 ' + $From + ' did not start twice; going back to ' + $To)
  Wait-Process -Id $AppPid -Timeout 60 -ErrorAction SilentlyContinue
  $installers = Join-Path $root 'installers'
  $installer = Join-Path $installers ($To + '.exe')
  $how = 'kept'
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    # Not kept (an install from before AU5, or removed): the release's own, run only when its SHA-512 matches latest.yml.
    $how = 'downloaded'
    $name = 'p9-event-horizon-' + $To + '-windows-' + $Arch + '.exe'
    $base = 'https://github.com/JudgeBreddd/p9/releases/download/v' + $To + '/'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    New-Item -ItemType Directory -Force -Path $installers | Out-Null
    $feed = Join-Path $installers 'latest.yml.part'
    Invoke-WebRequest -UseBasicParsing -Uri ($base + 'latest.yml') -OutFile $feed
    $latest = [IO.File]::ReadAllText($feed)
    Remove-Item -LiteralPath $feed -Force
    if ($latest -notmatch ('url:\s*' + [regex]::Escape($name) + '\s+sha512:\s*(\S+)')) { throw ('latest.yml of v' + $To + ' names no ' + $name) }
    $sha512 = $Matches[1]
    Note ('downloading ' + $base + $name)
    Invoke-WebRequest -UseBasicParsing -Uri ($base + $name) -OutFile ($installer + '.part')
    $stream = [IO.File]::OpenRead($installer + '.part')
    try { $got = [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash($stream)) } finally { $stream.Dispose() }
    if ($got -cne $sha512) { Remove-Item -LiteralPath ($installer + '.part') -Force; throw ('the download of ' + $name + ' does not match latest.yml') }
    Move-Item -LiteralPath ($installer + '.part') -Destination $installer -Force
  }
  Note ('running ' + $installer + ' /S (' + $how + ')')
  $run = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru
  if ($run.ExitCode -ne 0) { throw ('the installer of ' + $To + ' exited ' + $run.ExitCode) }
  # The installer's install-windows.ps1 sets current; this makes sure, if that version's daemon copy is whole.
  $current = Join-Path $root 'daemon\current'
  if ((Test-Path -LiteralPath (Join-Path $root ('daemon\' + $To + '\.complete')) -PathType Leaf) -and [IO.File]::ReadAllText($current).Trim() -ne $To) {
    [IO.File]::WriteAllText($current, $To); Note ('daemon\current set to ' + $To) }
  [IO.File]::WriteAllText((Join-Path $root 'rollback.json'), (ConvertTo-Json -Compress @{ from = $From; to = $To; at = (Get-Date).ToUniversalTime().ToString('o'); installer = $how }))
  Note ('P9 ' + $To + ' is installed again; starting it')
  Start-Process -FilePath $App
  exit 0
}

$version = [IO.File]::ReadAllText((Join-Path $root 'daemon\current')).Trim()
if ($version -notmatch $pattern) { throw 'daemon\current is unreadable' }
$dir = Join-Path $root ('daemon\' + $version)
$decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
$decoded.argv[0] = Join-Path $dir 'node.exe'
$decoded.argv[1] = Join-Path $dir 'apps\server\main.mjs'
$current = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($decoded | ConvertTo-Json -Compress -Depth 4)))
& (Join-Path $dir 'scripts\windows-host.ps1') -Mode Daemon -Log $Log -Payload $current
exit $LASTEXITCODE
