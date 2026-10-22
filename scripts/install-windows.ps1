param(
  [string]$Workspace,
  [string]$Settings = (Join-Path $env:APPDATA 'P9\settings.json'),
  [string]$Node,
  [string]$Server
)

$ErrorActionPreference = 'Stop'
# Timestamps in service-install.log, and the line a failure stopped at (a tester's log had neither, issue #6).
function Say([string]$Text) { Write-Output ((Get-Date -Format o) + ' ' + $Text) }
trap { Say ('failed at line ' + $_.InvocationInfo.ScriptLineNumber + ': ' + $_); exit 1 }
Say ('install-windows.ps1 as ' + [Security.Principal.WindowsIdentity]::GetCurrent().Name)
# Windows PowerShell started under a PowerShell 7 process (the installer run from pwsh) inherits 7's module folders,
# autoloads 7's Microsoft.PowerShell.Security and Set-Acl fails (GitHub run 39535290300). Keep only its own folders.
if ($PSVersionTable.PSEdition -eq 'Desktop') { $env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -notmatch '\\PowerShell\\' }) -join ';' }
function Full([string]$Value, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.IndexOfAny([char[]]@([char]0, [char]13, [char]10, [char]34)) -ge 0) { throw "invalid-$Name" }
  return [IO.Path]::GetFullPath($Value)
}

# No -Workspace (the installer, and every update): keep the installed task's workspace, else a new %USERPROFILE%\P9
# (release r2 R2-6). Re-registering on update also gives an older task this version's settings.
$away = $false
if (-not $Workspace) {
  $installed = Get-ScheduledTask -TaskName 'P9 Foundation' -ErrorAction SilentlyContinue
  if ($installed -and $installed.Actions[0].Arguments -match '-Payload (\S+)') {
    # A payload this cannot read (not base64, not JSON, no argv: hand-edited, cut short, a later format) falls to the
    # default folder; before, it failed every reinstall and the app's launch repair (v0.1.3 review finding 2).
    try {
      $old = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Matches[1])) | ConvertFrom-Json
      # An older task with no --workspace gave IndexOf -1, so argv[0], node.exe, became the workspace (issue #6 B7).
      $i = [Array]::IndexOf([string[]]$old.argv, '--workspace')
      if ($i -ge 0) { $Workspace = $old.argv[$i + 1] }
      # A saved folder that is not there now (an unplugged drive, a locked or offline share) failed every reinstall with
      # workspace-not-found. The task keeps it; the daemon runs on the default folder until it is back and /health says so
      # (the owner 2026-10-22, Fable review finding 1). An explicit -Workspace that does not exist still fails below.
      if ($Workspace -and -not (Test-Path -LiteralPath $Workspace -PathType Container)) {
        Say ('saved workspace ' + $Workspace + ' is not there now; the task keeps it and the daemon uses the default ' + (Join-Path $env:USERPROFILE 'P9') + ' until it is back')
        $away = $true
      }
    } catch { Say ('task payload unreadable, so the default workspace: ' + $_); $Workspace = $null }
  }
  if (-not $Workspace) {
    $Workspace = Join-Path $env:USERPROFILE 'P9'
    New-Item -ItemType Directory -Force -Path $Workspace | Out-Null
  }
}
Say ('workspace ' + $Workspace)
$Workspace = Full $Workspace 'workspace'
$Settings = Full $Settings 'settings'
if (-not $away -and -not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw 'workspace-not-found' }
# No settings file yet is fine: the daemon starts and Mission Control says settings-missing (release r1 R1-2).

$bundledNode = Join-Path $PSScriptRoot '..\node.exe'
if (-not $Node) { $Node = if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $bundledNode } else { (Get-Command node.exe -ErrorAction Stop).Source } }
if (-not $Server) { $Server = Join-Path $PSScriptRoot '..\apps\server\main.mjs' }
$Node = Full $Node 'node'
$Server = Full $Server 'server'
# The arm64 CI install (job 119704715150) registered the runner's node from PATH though node.exe was in the package.
Say ('node ' + $Node + ' (bundled ' + (Test-Path -LiteralPath $bundledNode -PathType Leaf) + '), PowerShell ' + $PSHOME +
  ', 64-bit ' + [Environment]::Is64BitProcess + ', ' + $env:PROCESSOR_ARCHITECTURE)
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) {
  $dir = Split-Path $Node
  Say ('in ' + $dir + ': ' + ((Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name + ' ' + $_.Length }) -join ', '))
  throw 'node-not-found'
}
if (-not (Test-Path -LiteralPath $Server -PathType Leaf)) { throw 'server-not-found' }

$root = Join-Path $env:LOCALAPPDATA 'P9'
$state = Join-Path $root 'runtime'
$recovery = Join-Path $root 'conflicts'
New-Item -ItemType Directory -Force -Path $root, $state, $recovery | Out-Null
# Owner-only, through icacls (the pattern in apps/desktop/editor-host.mjs). Set-Acl threw PrivilegeNotHeldException
# (SeSecurityPrivilege) for a standard user installing over an earlier install, so no task was re-registered and
# v0.1.1's visible task kept running (issue #6 item 4). Why Set-Acl wanted that privilege there is not proven.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $root /reset /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw ('icacls-failed reset ' + $LASTEXITCODE) }
& icacls.exe $root /inheritance:r /grant:r ('*' + $sid + ':(OI)(CI)F') /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw ('icacls-failed grant ' + $LASTEXITCODE) }
Say ('owner-only ' + $root)

$hostScript = Full (Join-Path $PSScriptRoot 'windows-host.ps1') 'host'
if (-not (Test-Path -LiteralPath $hostScript -PathType Leaf)) { throw 'host-not-found' }
$allow = @('HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'COLORTERM', 'TMPDIR',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ProgramData')
$environment = @{}
Get-ChildItem Env: | Where-Object { $allow -icontains $_.Name } | ForEach-Object { $environment[$_.Name] = $_.Value }
$payloadJson = @{ argv = @($Node, $Server, '--workspace', $Workspace, '--state', $state, '--recovery', $recovery,
    '--settings', $Settings); env = $environment } | ConvertTo-Json -Compress -Depth 4
$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payloadJson))
# The daemon's output goes to daemon.log, which inherits the root's owner-only ACL; teh doctor reads it (issue #6 B4).
$log = Full (Join-Path $root 'daemon.log') 'log'
$arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $hostScript + '"'),
  '-Mode', 'Daemon', '-Log', ('"' + $log + '"'), '-Payload', $payload) -join ' '
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
# conhost --headless: the host gets a console with no window. Plain powershell.exe opened one at every logon, and closing it
# killed the daemon (GitHub issue #4; on Windows 11, Terminal ignores -WindowStyle Hidden).
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument ('--headless powershell.exe ' + $arguments)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
# Every caller (the installer, the app's repair, Setup's Change the folder, a hand run) stops the running daemon here, as
# installer.nsh customInit does: Register -Force leaves it running, and Start-ScheduledTask on a running task is refused
# (v0.1.3 review finding 1). Stop-ScheduledTask ends only conhost.exe, so the bundled node.exe is ended too; its host exits.
# ponytail: a daemon on a node from PATH (a source run) is not ended, so it keeps the lock and the new one exits.
Stop-ScheduledTask -TaskName 'P9 Foundation' -ErrorAction SilentlyContinue
$bundled = Full $bundledNode 'node'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.ExecutablePath -eq $bundled } | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
  Say ('stopped the daemon ' + $_.ProcessId) }
Register-ScheduledTask -TaskName 'P9 Foundation' -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Force | Out-Null
Say 'task registered'
Start-ScheduledTask -TaskName 'P9 Foundation'
Say 'task started'
# Each install leaves an ns*.tmp folder in %TEMP% when its files stay locked (the leftover in a tester's %TEMP%, issue #6 B6).
# Only P9's own: older than an hour and holding the marker P9's installer writes there (installer.nsh customInit). Any
# electron-builder installer holds app-64.7z, so another app's, left open on a page for an hour, lost its files (v0.1.3
# review finding 3). ponytail: a P9 installer itself left open over an hour while the app repairs the task loses its folder.
Get-ChildItem -LiteralPath $env:TEMP -Directory -Filter 'ns*.tmp' -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'p9-event-horizon.marker') -PathType Leaf) } |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue; Say ('removed ' + $_.FullName) }
# ponytail: started, not proven answering (release r2 R2-8); the app shows daemon-unreachable if it never comes up.
Write-Output 'P9_WINDOWS_TASK_INSTALLED'
