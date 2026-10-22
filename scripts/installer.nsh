; electron-builder NSIS hooks (package.json build.nsis.include): register the daemon's per-user Scheduled Task on
; install, stop and remove it on uninstall and before an update replaces its files (release r1 R1-2).
; The workspace is the installed task's, or a new, empty %USERPROFILE%\P9; install-windows.ps1 -Workspace <folder>
; points it elsewhere. An update stops the task but keeps it, so its workspace survives (release r2 R2-6).
; The installer is a 32-bit program; with WOW64 redirection off it runs the 64-bit PowerShell a user opens. (Not the
; cause of run 39532602630's missing task: 32-bit PowerShell ran the script fine in run 39535290300; Set-Acl's module
; path was, see install-windows.ps1.) cmd's redirection keeps the script's whole output in service-install.log (nsExec's own
; capture is cut at NSIS's string limit), since a silent install shows nothing.
!include x64.nsh
!include LogicLib.nsh

!macro customInstall
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /C ""$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -InputFormat None -ExecutionPolicy Bypass -File "$INSTDIR\resources\daemon\scripts\install-windows.ps1" > "$INSTDIR\service-install.log" 2>&1"'
  Pop $0
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
  ${If} $0 != "0"
    MessageBox MB_ICONEXCLAMATION|MB_OK "P9 is installed, but its background service did not start (code $0). Details: $INSTDIR\service-install.log. Run $INSTDIR\resources\daemon\scripts\install-windows.ps1 -Workspace <folder> from PowerShell to try again." /SD IDOK
  ${EndIf}
!macroend

!macro customUnInstall
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  ; Stop-ScheduledTask ends only conhost.exe, the task's process; the PowerShell host and the daemon outlive it (GitHub run
  ; 39540753837). So the daemon's own node.exe is ended too; its host then exits and its Job Object ends the daemon's children.
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -InputFormat None -Command "Stop-ScheduledTask -TaskName 'P9 Foundation' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter 'Name = ''node.exe''' | Where-Object { $$_.ExecutablePath -eq '$INSTDIR\resources\daemon\node.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -InputFormat None -Command "Unregister-ScheduledTask -TaskName 'P9 Foundation' -Confirm:$$false -ErrorAction SilentlyContinue"`
    Pop $0
  ${endIf}
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
!macroend

; Before an install or update replaces any file: the same stop as customUnInstall, for an older version whose uninstaller
; left its daemon running and holding files open (issue #6 B10). electron-builder runs customInit in .onInit after
; initMultiUser, so $INSTDIR is already the install folder.
!macro customInit
  ${If} ${RunningX64}
    ${DisableX64FSRedirection}
  ${EndIf}
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -InputFormat None -Command "Stop-ScheduledTask -TaskName 'P9 Foundation' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process -Filter 'Name = ''node.exe''' | Where-Object { $$_.ExecutablePath -eq '$INSTDIR\resources\daemon\node.exe' } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  Pop $0
  ${If} ${RunningX64}
    ${EnableX64FSRedirection}
  ${EndIf}
!macroend
