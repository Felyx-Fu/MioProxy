!macro NSIS_HOOK_PREINSTALL
  ; Stop and remove the previous Service before NSIS replaces its executable.
  ; Use SCM commands because an older installed Service binary may not
  ; understand the current installer-only command line flags.
  SetShellVarContext current
  IfFileExists "$INSTDIR\mioproxy-service.exe" 0 service_preinstall_done
  ExecWait '"$SYSDIR\sc.exe" query MioProxyService' $0
  ${If} $0 == 1060
    Goto service_preinstall_done
  ${ElseIf} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "无法查询 MioProxy Service，安装已取消。"
    Abort
  ${EndIf}
  ; A queued SCM restart cannot be canceled by stop/delete. Disable the
  ; service first so maintenance cannot be undone by a delayed recovery.
  ExecWait '"$SYSDIR\sc.exe" config MioProxyService start= disabled' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "无法暂时禁用 MioProxy Service 自动启动，安装已取消。"
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\sc.exe" stop MioProxyService' $0
  StrCpy $1 0
service_stop_wait:
  Sleep 500
  ExecWait '"$SYSDIR\cmd.exe" /C ""$SYSDIR\sc.exe" query MioProxyService | "$SYSDIR\findstr.exe" /C:"STOPPED""' $0
  ${If} $0 == 0
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
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (@(Get-NetAdapter -Name MioProxy -ErrorAction SilentlyContinue | Where-Object Status -eq Up).Count -gt 0 -or @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | Where-Object InterfaceAlias -eq MioProxy).Count -gt 0 -or @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object InterfaceAlias -eq MioProxy).Count -gt 0) { exit 1 }"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "MioProxy TUN 路由或 DNS 尚未恢复，安装已取消。"
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\sc.exe" delete MioProxyService' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 删除失败，安装已取消。"
    Abort
  ${EndIf}
service_preinstall_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Register the exact Service and Mihomo binaries copied by this installer.
  SetShellVarContext current
  ExecWait '"$INSTDIR\mioproxy-service.exe" --install --data-dir "$APPDATA\dev.MioProxy" --mihomo-path "$INSTDIR\mihomo.exe"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 安装失败，安装未完成。请保留此错误并重试。"
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Let SCM stop the Service before files are removed. Verify only the
  ; MioProxy-owned adapter/route/DNS, never a separately owned tunnel.
  SetShellVarContext current
  IfFileExists "$INSTDIR\mioproxy-service.exe" 0 service_preuninstall_done
  ExecWait '"$SYSDIR\sc.exe" query MioProxyService' $0
  ${If} $0 == 1060
    Goto service_preuninstall_done
  ${ElseIf} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "无法查询 MioProxy Service，卸载已取消。"
    Abort
  ${EndIf}
  ; A queued SCM restart cannot be canceled by stop/delete. Disable the
  ; service first so uninstall cannot be undone by a delayed recovery.
  ExecWait '"$SYSDIR\sc.exe" config MioProxyService start= disabled' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "无法暂时禁用 MioProxy Service 自动启动，卸载已取消。"
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\sc.exe" stop MioProxyService' $0
  StrCpy $1 0
service_uninstall_stop_wait:
  Sleep 500
  ExecWait '"$SYSDIR\cmd.exe" /C ""$SYSDIR\sc.exe" query MioProxyService | "$SYSDIR\findstr.exe" /C:"STOPPED""' $0
  ${If} $0 == 0
    Goto service_uninstall_stopped
  ${EndIf}
  IntOp $1 $1 + 1
  ${If} $1 >= 20
    MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 未能在 10 秒内停止，卸载已取消。"
    Abort
  ${EndIf}
  Goto service_uninstall_stop_wait
service_uninstall_stopped:
  ExecWait '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "if (@(Get-NetAdapter -Name MioProxy -ErrorAction SilentlyContinue | Where-Object Status -eq Up).Count -gt 0 -or @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix 0.0.0.0/0 -ErrorAction SilentlyContinue | Where-Object InterfaceAlias -eq MioProxy).Count -gt 0 -or @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object InterfaceAlias -eq MioProxy).Count -gt 0) { exit 1 }"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "MioProxy TUN 路由或 DNS 尚未恢复，卸载已取消。"
    Abort
  ${EndIf}
  ExecWait '"$SYSDIR\sc.exe" delete MioProxyService' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "MioProxy Service 删除失败，卸载已取消。"
    Abort
  ${EndIf}
service_preuninstall_done:
!macroend
