; electron-builder NSIS hooks (package.json build.nsis.include): register the daemon's per-user Scheduled Task on
; install, stop and remove it on uninstall and before an update replaces its files (release r1 R1-2).
; The workspace is the installed task's, or a new, empty %USERPROFILE%\P9; install-windows.ps1 -Workspace <folder>
; points it elsewhere. -InputFormat None: PowerShell under nsExec can wait on a stdin that never closes (belief, 2026-10-20:
; GitHub run 39528710341's silent install did not finish in 5 min). An update stops the task but keeps it, so its workspace survives (release r2 R2-6).
!macro customInstall
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -InputFormat None -ExecutionPolicy Bypass -File "$INSTDIR\resources\daemon\scripts\install-windows.ps1"'
  Pop $0
  StrCmp $0 "0" +2
    MessageBox MB_ICONEXCLAMATION|MB_OK "P9 is installed, but its background service did not start (code $0). Run $INSTDIR\resources\daemon\scripts\install-windows.ps1 -Workspace <folder> from PowerShell to see why." /SD IDOK
!macroend

!macro customUnInstall
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -InputFormat None -Command "Stop-ScheduledTask -TaskName 'P9 Foundation' -ErrorAction SilentlyContinue"`
  Pop $0
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -InputFormat None -Command "Unregister-ScheduledTask -TaskName 'P9 Foundation' -Confirm:$$false -ErrorAction SilentlyContinue"`
    Pop $0
  ${endIf}
!macroend
