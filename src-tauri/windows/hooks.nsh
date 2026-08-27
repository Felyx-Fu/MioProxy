!include FileFunc.nsh

; These variables are deliberately installer-local. They carry only the
; authoritative SCM state observed before an overlay install.
Var MioProxyServicePresent
Var MioProxyServiceWasRunning
Var MioProxyServiceState
Var MioProxyServiceExitCode
Var MioProxyServiceOutput

Function MioProxyQueryService
  StrCpy $MioProxyServicePresent 0
  StrCpy $MioProxyServiceState "absent"
  nsExec::ExecToStack /TIMEOUT=5000 '"$SYSDIR\sc.exe" query MioProxyService'
  Pop $MioProxyServiceExitCode
  Pop $MioProxyServiceOutput
  StrCpy $MioProxyServiceOutput $MioProxyServiceOutput 1024
  DetailPrint "MioProxy Service query exit=$MioProxyServiceExitCode output=$MioProxyServiceOutput"
  ${If} $MioProxyServiceExitCode == "1060"
    Return
  ${ElseIf} $MioProxyServiceExitCode != "0"
    MessageBox MB_ICONSTOP|MB_OK "无法查询 MioProxy Service，安装已取消。$\n诊断：$MioProxyServiceExitCode $MioProxyServiceOutput"
    Abort
  ${EndIf}

  StrCpy $MioProxyServicePresent 1
  nsis_tauri_utils::StrReplace "$MioProxyServiceOutput" "RUNNING" "__MIOPROXY_RUNNING__"
  Pop $0
  StrCmp $0 "$MioProxyServiceOutput" mio_proxy_query_stopped_check
  StrCpy $MioProxyServiceWasRunning 1
  StrCpy $MioProxyServiceState "running"
  Return
mio_proxy_query_stopped_check:
  nsis_tauri_utils::StrReplace "$MioProxyServiceOutput" "STOPPED" "__MIOPROXY_STOPPED__"
  Pop $0
  StrCmp $0 "$MioProxyServiceOutput" mio_proxy_query_unknown
  StrCpy $MioProxyServiceState "stopped"
  Return
mio_proxy_query_unknown:
  MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 正在转换状态，安装已取消。$\n诊断：$MioProxyServiceOutput"
  Abort
FunctionEnd

Function MioProxyCheckTunRecovered
  ; PowerShell is still required for the existing MioProxy-owned adapter,
  ; route and DNS ownership check. nsExec captures it without a console.
  nsExec::ExecToStack /TIMEOUT=10000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (@(Get-NetAdapter -Name MioProxy -ErrorAction SilentlyContinue | Where-Object Status -eq Up).Count -gt 0 -or @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | Where-Object InterfaceAlias -eq MioProxy).Count -gt 0 -or @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object InterfaceAlias -eq MioProxy).Count -gt 0) { exit 1 }"'
  Pop $0
  Pop $1
  StrCpy $1 $1 1024
  DetailPrint "MioProxy TUN ownership check exit=$0 output=$1"
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK "MioProxy TUN 路由或 DNS 尚未恢复，安装已取消。$\n诊断：$0 $1"
    Abort
  ${EndIf}
FunctionEnd

Function un.MioProxyQueryService
  StrCpy $MioProxyServicePresent 0
  StrCpy $MioProxyServiceState "absent"
  nsExec::ExecToStack /TIMEOUT=5000 '"$SYSDIR\sc.exe" query MioProxyService'
  Pop $MioProxyServiceExitCode
  Pop $MioProxyServiceOutput
  StrCpy $MioProxyServiceOutput $MioProxyServiceOutput 1024
  DetailPrint "MioProxy Service query exit=$MioProxyServiceExitCode output=$MioProxyServiceOutput"
  ${If} $MioProxyServiceExitCode == "1060"
    Return
  ${ElseIf} $MioProxyServiceExitCode != "0"
    MessageBox MB_ICONSTOP|MB_OK "MioProxy Service query failed during uninstall. Diagnostic: $MioProxyServiceExitCode $MioProxyServiceOutput"
    Abort
  ${EndIf}

  StrCpy $MioProxyServicePresent 1
  nsis_tauri_utils::StrReplace "$MioProxyServiceOutput" "RUNNING" "__MIOPROXY_RUNNING__"
  Pop $0
  StrCmp $0 "$MioProxyServiceOutput" un_mio_proxy_query_stopped_check
  StrCpy $MioProxyServiceWasRunning 1
  StrCpy $MioProxyServiceState "running"
  Return
un_mio_proxy_query_stopped_check:
  nsis_tauri_utils::StrReplace "$MioProxyServiceOutput" "STOPPED" "__MIOPROXY_STOPPED__"
  Pop $0
  StrCmp $0 "$MioProxyServiceOutput" un_mio_proxy_query_unknown
  StrCpy $MioProxyServiceState "stopped"
  Return
un_mio_proxy_query_unknown:
  MessageBox MB_ICONSTOP|MB_OK "MioProxy Service is changing state; uninstall was cancelled. Diagnostic: $MioProxyServiceOutput"
  Abort
FunctionEnd

Function un.MioProxyCheckTunRecovered
  ; Keep the uninstall ownership check consoleless as well.
  nsExec::ExecToStack /TIMEOUT=10000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (@(Get-NetAdapter -Name MioProxy -ErrorAction SilentlyContinue | Where-Object Status -eq Up).Count -gt 0 -or @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | Where-Object InterfaceAlias -eq MioProxy).Count -gt 0 -or @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object InterfaceAlias -eq MioProxy).Count -gt 0) { exit 1 }"'
  Pop $0
  Pop $1
  StrCpy $1 $1 1024
  DetailPrint "MioProxy TUN ownership check exit=$0 output=$1"
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK "MioProxy TUN route or DNS ownership has not recovered; uninstall was cancelled. Diagnostic: $0 $1"
    Abort
  ${EndIf}
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; Stop the existing Service before NSIS replaces its executable, but retain
  ; the registration so the post-install helper can reconfigure the same
  ; MioProxyService identity instead of deleting and recreating it.
  SetShellVarContext current
  StrCpy $MioProxyServiceWasRunning 0
  Call MioProxyQueryService
  ${If} $MioProxyServicePresent == 0
    Goto service_preinstall_done
  ${EndIf}

  ; A queued SCM restart cannot be canceled by stop/delete. Disable the
  ; service first so maintenance cannot be undone by a delayed recovery.
  nsExec::ExecToStack /TIMEOUT=5000 '"$SYSDIR\sc.exe" config MioProxyService start= disabled'
  Pop $0
  Pop $1
  StrCpy $1 $1 1024
  DetailPrint "MioProxy Service maintenance config exit=$0 output=$1"
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK "无法暂时禁用 MioProxy Service 自动启动，安装已取消。$\n诊断：$0 $1"
    Abort
  ${EndIf}

  ${If} $MioProxyServiceWasRunning == 1
    nsExec::ExecToStack /TIMEOUT=5000 '"$SYSDIR\sc.exe" stop MioProxyService'
    Pop $0
    Pop $1
    StrCpy $1 $1 1024
    DetailPrint "MioProxy Service stop exit=$0 output=$1"
    ${If} $0 != "0"
      MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 未能开始停止，安装已取消。$\n诊断：$0 $1"
      Abort
    ${EndIf}
  ${EndIf}

  StrCpy $1 0
service_stop_wait:
  Sleep 500
  Call MioProxyQueryService
  ${If} $MioProxyServiceState == "stopped"
    Goto service_stopped
  ${EndIf}
  IntOp $1 $1 + 1
  ${If} $1 >= 20
    MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 未能在 10 秒内停止，安装已取消。"
    Abort
  ${EndIf}
  Goto service_stop_wait
service_stopped:
  ; Only reject stale state belonging to MioProxy itself. A separately owned
  ; adapter such as Clash Party's Mimo is intentionally left untouched.
  Call MioProxyCheckTunRecovered
service_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Register the exact Service and Mihomo binaries copied by this installer.
  SetShellVarContext current
  ; The updater passes this explicit marker only for a signed app update.
  ; Forward it so the Service installer can preserve an authoritative stopped
  ; checkpoint without changing normal fresh-install startup behavior.
  StrCpy $1 ""
  ClearErrors
  ${GetOptions} "$CMDLINE" "/MIOPROXY_UPDATER" $2
  ${IfNot} ${Errors}
    StrCpy $1 "/MIOPROXY_UPDATER"
  ${EndIf}
  ${If} $MioProxyServicePresent == 1
  ${AndIf} $MioProxyServiceWasRunning == 0
    StrCpy $1 "$1 /MIOPROXY_PRESERVE_STOPPED"
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=30000 '"$INSTDIR\mioproxy-service.exe" --install --data-dir "$APPDATA\dev.MioProxy" --mihomo-path "$INSTDIR\mihomo.exe" $1'
  Pop $0
  Pop $2
  StrCpy $2 $2 1024
  DetailPrint "MioProxy Service install/reconfigure exit=$0 output=$2"
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 安装失败，安装未完成。请保留此错误并重试。$\n诊断：$0 $2"
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Let SCM stop the Service before files are removed. Verify only the
  ; MioProxy-owned adapter/route/DNS, never a separately owned tunnel.
  SetShellVarContext current
  StrCpy $MioProxyServiceWasRunning 0
  Call un.MioProxyQueryService
  ${If} $MioProxyServicePresent == 0
    Goto service_preuninstall_done
  ${EndIf}

  ; A queued SCM restart cannot be canceled by stop/delete. Disable the
  ; service first so uninstall cannot be undone by a delayed recovery.
  nsExec::ExecToStack /TIMEOUT=5000 '"$SYSDIR\sc.exe" config MioProxyService start= disabled'
  Pop $0
  Pop $1
  StrCpy $1 $1 1024
  DetailPrint "MioProxy Service uninstall config exit=$0 output=$1"
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK "无法暂时禁用 MioProxy Service 自动启动，卸载已取消。$\n诊断：$0 $1"
    Abort
  ${EndIf}

  ${If} $MioProxyServiceWasRunning == 1
    nsExec::ExecToStack /TIMEOUT=5000 '"$SYSDIR\sc.exe" stop MioProxyService'
    Pop $0
    Pop $1
    StrCpy $1 $1 1024
    DetailPrint "MioProxy Service uninstall stop exit=$0 output=$1"
    ${If} $0 != "0"
      MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 未能开始停止，卸载已取消。$\n诊断：$0 $1"
      Abort
    ${EndIf}
  ${EndIf}

  StrCpy $1 0
service_uninstall_stop_wait:
  Sleep 500
  Call un.MioProxyQueryService
  ${If} $MioProxyServiceState == "stopped"
    Goto service_uninstall_stopped
  ${EndIf}
  IntOp $1 $1 + 1
  ${If} $1 >= 20
    MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 未能在 10 秒内停止，卸载已取消。"
    Abort
  ${EndIf}
  Goto service_uninstall_stop_wait
service_uninstall_stopped:
  Call un.MioProxyCheckTunRecovered
  nsExec::ExecToStack /TIMEOUT=5000 '"$SYSDIR\sc.exe" delete MioProxyService'
  Pop $0
  Pop $1
  StrCpy $1 $1 1024
  DetailPrint "MioProxy Service delete exit=$0 output=$1"
  ${If} $0 != "0"
    MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 删除失败，卸载已取消。$\n诊断：$0 $1"
    Abort
  ${EndIf}
service_preuninstall_done:
!macroend
