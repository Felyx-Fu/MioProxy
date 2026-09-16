; Maintenance: this custom template is based on the Tauri CLI 2.11.4 upstream NSIS
; template at crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi (Rust tauri
; crate locked at 2.11.5). Before any future Tauri upgrade, diff this file against
; the matching upstream template.

Unicode true
ManifestDPIAware true
; Add in `dpiAwareness` `PerMonitorV2` to manifest for Windows 10 1607+ (note this should not affect lower versions since they should be able to ignore this and pick up `dpiAware` `true` set by `ManifestDPIAware true`)
; Currently undocumented on NSIS's website but is in the Docs folder of source tree, see
; https://github.com/kichik/nsis/blob/5fc0b87b819a9eec006df4967d08e522ddd651c9/Docs/src/attributes.but#L286-L300
; https://github.com/tauri-apps/tauri/pull/10106
ManifestDPIAwareness PerMonitorV2

!if "{{compression}}" == "none"
  SetCompress off
!else
  ; Set the compression algorithm. We default to LZMA.
  SetCompressor /SOLID "{{compression}}"
!endif

; Keep above !include to stay ahead of any plugin command
{{#if signed_plugins_path}}
!addplugindir "{{signed_plugins_path}}"
{{/if}}
{{#if additional_plugins_path}}
!addplugindir "{{additional_plugins_path}}"
{{/if}}

; Keep above !include to stay ahead of any plugin command
; see https://github.com/tauri-apps/tauri/pull/15422#discussion_r3289239624

!include MUI2.nsh
!include FileFunc.nsh
!include x64.nsh
!include WordFunc.nsh
!include "utils.nsh"
!include "FileAssociation.nsh"
!include "Win\COM.nsh"
!include "Win\Propkey.nsh"
!include "StrFunc.nsh"
${StrCase}
${StrLoc}

{{#if installer_hooks}}
!include "{{installer_hooks}}"
{{/if}}

!define WEBVIEW2APPGUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

!define MANUFACTURER "{{manufacturer}}"
!define PRODUCTNAME "{{product_name}}"
!define VERSION "{{version}}"
!define VERSIONWITHBUILD "{{version_with_build}}"
!define HOMEPAGE "{{homepage}}"
!define INSTALLMODE "{{install_mode}}"
!define LICENSE "{{license}}"
!define INSTALLERICON "{{installer_icon}}"
!define SIDEBARIMAGE "{{sidebar_image}}"
!define HEADERIMAGE "{{header_image}}"
!define UNINSTALLERICON "{{uninstaller_icon}}"
!define UNINSTALLERHEADERIMAGE "{{uninstaller_header_image}}"
!define MAINBINARYNAME "{{main_binary_name}}"
!define MAINBINARYSRCPATH "{{main_binary_path}}"
!define BUNDLEID "{{bundle_id}}"
!define COPYRIGHT "{{copyright}}"
!define OUTFILE "{{out_file}}"
!define ARCH "{{arch}}"
!define ADDITIONALPLUGINSPATH "{{additional_plugins_path}}"
!define ALLOWDOWNGRADES "{{allow_downgrades}}"
!define DISPLAYLANGUAGESELECTOR "{{display_language_selector}}"
!define INSTALLWEBVIEW2MODE "{{install_webview2_mode}}"
!define WEBVIEW2INSTALLERARGS "{{webview2_installer_args}}"
!define WEBVIEW2BOOTSTRAPPERPATH "{{webview2_bootstrapper_path}}"
!define WEBVIEW2INSTALLERPATH "{{webview2_installer_path}}"
!define MINIMUMWEBVIEW2VERSION "{{minimum_webview2_version}}"
!define UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}"
!define MANUKEY "Software\${MANUFACTURER}"
!define MANUPRODUCTKEY "${MANUKEY}\${PRODUCTNAME}"
!define UNINSTALLERSIGNCOMMAND ""
!define ESTIMATEDSIZE "{{estimated_size}}"
!define STARTMENUFOLDER "{{start_menu_folder}}"

Var PassiveMode
Var UpdateMode
Var NoShortcutMode
Var WixMode
Var OldMainBinaryName
Var MioProxyExistingDetected
Var MioProxyExistingInvalid
Var MioProxyExistingVersion
Var MioProxyExistingInstallPath
Var MioProxyExistingRegistryRoot
Var MioProxyLegacyInstallPath
Var MioProxyVersionComparison
Var MioProxyDowngradeConfirmed
Var MioProxyModeTitle
Var MioProxyModeSubtitle
Var MioProxyModeBody
Var MioProxyModePrimary

Name "${PRODUCTNAME}"
BrandingText "${COPYRIGHT}"
OutFile "${OUTFILE}"

; We don't actually use this value as default install path,
; it's just for nsis to append the product name folder in the directory selector
; https://nsis.sourceforge.io/Reference/InstallDir
!define PLACEHOLDER_INSTALL_DIR "placeholder\${PRODUCTNAME}"
InstallDir "${PLACEHOLDER_INSTALL_DIR}"

VIProductVersion "${VERSIONWITHBUILD}"
VIAddVersionKey "ProductName" "${PRODUCTNAME}"
VIAddVersionKey "FileDescription" "${PRODUCTNAME}"
VIAddVersionKey "LegalCopyright" "${COPYRIGHT}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

; Uninstaller signing command
!if "${UNINSTALLERSIGNCOMMAND}" != ""
  !uninstfinalize '${UNINSTALLERSIGNCOMMAND}'
!endif

; Handle install mode, `perUser`, `perMachine` or `both`
!if "${INSTALLMODE}" == "perMachine"
  RequestExecutionLevel admin
!endif

!if "${INSTALLMODE}" == "currentUser"
  RequestExecutionLevel user
!endif

!if "${INSTALLMODE}" == "both"
  !define MULTIUSER_MUI
  !define MULTIUSER_INSTALLMODE_INSTDIR "${PRODUCTNAME}"
  !define MULTIUSER_INSTALLMODE_COMMANDLINE
  !if "${ARCH}" == "x64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !else if "${ARCH}" == "arm64"
    !define MULTIUSER_USE_PROGRAMFILES64
  !endif
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_KEY "${UNINSTKEY}"
  !define MULTIUSER_INSTALLMODE_DEFAULT_REGISTRY_VALUENAME "CurrentUser"
  !define MULTIUSER_INSTALLMODEPAGE_SHOWUSERNAME
  !define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
  !define MULTIUSER_EXECUTIONLEVEL Highest
  !include MultiUser.nsh
!endif

; Installer icon
!if "${INSTALLERICON}" != ""
  !define MUI_ICON "${INSTALLERICON}"
!endif

; Installer sidebar image
!if "${SIDEBARIMAGE}" != ""
  !define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBARIMAGE}"
!endif

; Enable header images for installer and uninstaller pages when either image is configured.
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!else if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE
!endif

; Installer header image
!if "${HEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_BITMAP "${HEADERIMAGE}"
!endif

; Uninstaller header image
!if "${UNINSTALLERHEADERIMAGE}" != ""
  !define MUI_HEADERIMAGE_UNBITMAP "${UNINSTALLERHEADERIMAGE}"
!endif

; Uninstaller icon
!if "${UNINSTALLERICON}" != ""
  !define MUI_UNICON "${UNINSTALLERICON}"
!endif

; Define registry key to store installer language
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${MANUPRODUCTKEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

; Installer pages, must be ordered as they appear
; 1. Welcome Page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_WELCOME

; 2. License Page (if defined)
!if "${LICENSE}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MUI_PAGE_LICENSE "${LICENSE}"
!endif

; 3. Install mode (if it is set to `both`)
!if "${INSTALLMODE}" == "both"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !insertmacro MULTIUSER_PAGE_INSTALLMODE
!endif

; 4. MioProxy install mode
Page custom MioProxyInstallModePage MioProxyInstallModePageLeave

; 5. Choose install directory page
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipDirectoryIfExisting
!insertmacro MUI_PAGE_DIRECTORY

; 6. Start menu shortcut page
Var AppStartMenuFolder
!if "${STARTMENUFOLDER}" != ""
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
  !define MUI_STARTMENUPAGE_DEFAULTFOLDER "${STARTMENUFOLDER}"
!else
  !define MUI_PAGE_CUSTOMFUNCTION_PRE Skip
!endif
!insertmacro MUI_PAGE_STARTMENU Application $AppStartMenuFolder

; 7. Installation page
!insertmacro MUI_PAGE_INSTFILES

; 8. Finish page
;
; Don't auto jump to finish page after installation page,
; because the installation page has useful info that can be used debug any issues with the installer.
!define MUI_FINISHPAGE_NOAUTOCLOSE
; Use show readme button in the finish page as a button create a desktop shortcut
!define MUI_FINISHPAGE_SHOWREADME
!define MUI_FINISHPAGE_SHOWREADME_TEXT "$(createDesktop)"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION CreateOrUpdateDesktopShortcut
; Show run app after installation.
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION RunMainBinary
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipIfPassive
!insertmacro MUI_PAGE_FINISH

Function RunMainBinary
  nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
FunctionEnd

; Uninstaller Pages
; 1. Confirm uninstall page
Var DeleteAppDataCheckbox
Var DeleteAppDataCheckboxState
!define /ifndef WS_EX_LAYOUTRTL         0x00400000
!define MUI_PAGE_CUSTOMFUNCTION_SHOW un.ConfirmShow
Function un.ConfirmShow ; Add add a `Delete app data` check box
  ; $1 inner dialog HWND
  ; $2 window DPI
  ; $3 style
  ; $4 x
  ; $5 y
  ; $6 width
  ; $7 height
  FindWindow $1 "#32770" "" $HWNDPARENT ; Find inner dialog
  System::Call "user32::GetDpiForWindow(p r1) i .r2"
  ${If} $(^RTL) = 1
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE} | ${WS_EX_LAYOUTRTL}"
    IntOp $4 50 * $2
  ${Else}
    StrCpy $3 "${__NSD_CheckBox_EXSTYLE}"
    IntOp $4 0 * $2
  ${EndIf}
  IntOp $5 100 * $2
  IntOp $6 400 * $2
  IntOp $7 25 * $2
  IntOp $4 $4 / 96
  IntOp $5 $5 / 96
  IntOp $6 $6 / 96
  IntOp $7 $7 / 96
  System::Call 'user32::CreateWindowEx(i r3, w "${__NSD_CheckBox_CLASS}", w "$(deleteAppData)", i ${__NSD_CheckBox_STYLE}, i r4, i r5, i r6, i r7, p r1, i0, i0, i0) i .s'
  Pop $DeleteAppDataCheckbox
  SendMessage $HWNDPARENT ${WM_GETFONT} 0 0 $1
  SendMessage $DeleteAppDataCheckbox ${WM_SETFONT} $1 1
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE un.ConfirmLeave
Function un.ConfirmLeave
  SendMessage $DeleteAppDataCheckbox ${BM_GETCHECK} 0 0 $DeleteAppDataCheckboxState
FunctionEnd
!define MUI_PAGE_CUSTOMFUNCTION_PRE un.SkipIfPassive
!insertmacro MUI_UNPAGE_CONFIRM

; 2. Uninstalling Page
!insertmacro MUI_UNPAGE_INSTFILES

;Languages
{{#each languages}}
!insertmacro MUI_LANGUAGE "{{this}}"
{{/each}}
!insertmacro MUI_RESERVEFILE_LANGDLL
{{#each language_files}}
  !include "{{this}}"
{{/each}}


Function MioProxyNormalizePath
  Exch $0
  StrCpy $1 $0 1
  StrCmp $1 "$\"" 0 mio_proxy_path_check_end
  StrCpy $0 $0 "" 1
mio_proxy_path_check_end:
  StrLen $1 $0
  ${If} $1 > 0
    IntOp $1 $1 - 1
    StrCpy $2 $0 1 $1
    StrCmp $2 "$\"" 0 mio_proxy_path_done
    StrCpy $0 $0 $1
  ${EndIf}
mio_proxy_path_done:
  Push $0
FunctionEnd

!macro MioProxyTryRegistryRoot root
  !define MioProxyRegistryUniqueId ${__LINE__}
  ${If} $MioProxyExistingDetected == 0
    ReadRegStr $0 ${root} "${UNINSTKEY}" "DisplayName"
    StrCmp $0 "${PRODUCTNAME}" 0 mio_proxy_registry_${root}_done_${MioProxyRegistryUniqueId}
    ReadRegStr $1 ${root} "${UNINSTKEY}" "Publisher"
    StrCmp $1 "${MANUFACTURER}" 0 mio_proxy_registry_${root}_done_${MioProxyRegistryUniqueId}
    ReadRegStr $2 ${root} "${UNINSTKEY}" "DisplayVersion"
    ReadRegStr $4 ${root} "${MANUPRODUCTKEY}" ""
    StrCmp $4 "" 0 mio_proxy_registry_${root}_path_ready_${MioProxyRegistryUniqueId}
    ReadRegStr $4 ${root} "${UNINSTKEY}" "InstallLocation"
    StrCmp $4 "" mio_proxy_registry_${root}_invalid_${MioProxyRegistryUniqueId}
    Push $4
    Call MioProxyNormalizePath
    Pop $4
  mio_proxy_registry_${root}_path_ready_${MioProxyRegistryUniqueId}:
    IfFileExists "$4\mioproxy.exe" mio_proxy_registry_${root}_path_valid_${MioProxyRegistryUniqueId} 0
    IfFileExists "$4\uninstall.exe" mio_proxy_registry_${root}_path_valid_${MioProxyRegistryUniqueId} 0
    Goto mio_proxy_registry_${root}_invalid_${MioProxyRegistryUniqueId}
  mio_proxy_registry_${root}_path_valid_${MioProxyRegistryUniqueId}:
    StrCmp $2 "" mio_proxy_registry_${root}_invalid_${MioProxyRegistryUniqueId}
    nsis_tauri_utils::SemverCompare "${VERSION}" "$2"
    Pop $3
    StrCmp $3 "0" mio_proxy_registry_${root}_same_${MioProxyRegistryUniqueId}
    StrCmp $3 "1" mio_proxy_registry_${root}_upgrade_${MioProxyRegistryUniqueId}
    StrCmp $3 "-1" mio_proxy_registry_${root}_downgrade_${MioProxyRegistryUniqueId}
    Goto mio_proxy_registry_${root}_invalid_${MioProxyRegistryUniqueId}
  mio_proxy_registry_${root}_same_${MioProxyRegistryUniqueId}:
    StrCpy $MioProxyVersionComparison 0
    Goto mio_proxy_registry_${root}_valid_${MioProxyRegistryUniqueId}
  mio_proxy_registry_${root}_upgrade_${MioProxyRegistryUniqueId}:
    StrCpy $MioProxyVersionComparison 1
    Goto mio_proxy_registry_${root}_valid_${MioProxyRegistryUniqueId}
  mio_proxy_registry_${root}_downgrade_${MioProxyRegistryUniqueId}:
    StrCpy $MioProxyVersionComparison -1
  mio_proxy_registry_${root}_valid_${MioProxyRegistryUniqueId}:
    StrCpy $MioProxyExistingDetected 1
    StrCpy $MioProxyExistingVersion $2
    StrCpy $MioProxyExistingInstallPath $4
    StrCpy $MioProxyExistingRegistryRoot "${root}"
    Goto mio_proxy_registry_${root}_done_${MioProxyRegistryUniqueId}
  mio_proxy_registry_${root}_invalid_${MioProxyRegistryUniqueId}:
    StrCpy $MioProxyExistingDetected 1
    StrCpy $MioProxyExistingInvalid 1
  mio_proxy_registry_${root}_done_${MioProxyRegistryUniqueId}:
  ${EndIf}
  !undef MioProxyRegistryUniqueId
!macroend

Function MioProxyDetectExistingInstall
  StrCpy $MioProxyExistingDetected 0
  StrCpy $MioProxyExistingInvalid 0
  StrCpy $MioProxyExistingVersion ""
  StrCpy $MioProxyExistingInstallPath ""
  StrCpy $MioProxyExistingRegistryRoot ""
  StrCpy $MioProxyLegacyInstallPath ""
  StrCpy $MioProxyVersionComparison 99
  !if "${INSTALLMODE}" == "perMachine"
    ${If} ${RunningX64}
      SetRegView 64
      !insertmacro MioProxyTryRegistryRoot HKLM
      ${If} $MioProxyExistingDetected == 0
        SetRegView 32
        !insertmacro MioProxyTryRegistryRoot HKLM
        SetRegView 64
      ${EndIf}
    ${Else}
      SetRegView 32
      !insertmacro MioProxyTryRegistryRoot HKLM
    ${EndIf}
  !endif
  !insertmacro MioProxyTryRegistryRoot HKCU
  !if "${INSTALLMODE}" == "perMachine"
    ${If} ${RunningX64}
      SetRegView 64
    ${EndIf}
  !endif
FunctionEnd

Function MioProxySetInstallPresentation
  ${If} $MioProxyExistingDetected == 0
    StrCpy $MioProxyModeTitle "MioProxy ${VERSION}"
    StrCpy $MioProxyModeSubtitle "安装 MioProxy"
    StrCpy $MioProxyModeBody "将把 MioProxy 安装到此电脑。"
    StrCpy $MioProxyModePrimary "安装"
  ${ElseIf} $MioProxyVersionComparison == 1
    StrCpy $MioProxyModeTitle "检测到已安装 MioProxy $MioProxyExistingVersion"
    StrCpy $MioProxyModeSubtitle "当前安装包：MioProxy ${VERSION}"
    StrCpy $MioProxyModeBody "将执行覆盖并升级。程序文件会被更新，但会保留现有用户配置，包括 profiles、subscriptions、settings 和更新恢复元数据。"
    StrCpy $MioProxyModePrimary "覆盖并升级"
  ${ElseIf} $MioProxyVersionComparison == 0
    StrCpy $MioProxyModeTitle "MioProxy $MioProxyExistingVersion 已安装"
    StrCpy $MioProxyModeSubtitle "修复 / 覆盖安装"
    StrCpy $MioProxyModeBody "重新安装将修复程序文件，不会删除 profiles、subscriptions、settings 或更新恢复元数据等用户配置。"
    StrCpy $MioProxyModePrimary "修复 / 覆盖安装"
  ${Else}
    StrCpy $MioProxyModeTitle "MioProxy ${VERSION}"
    StrCpy $MioProxyModeSubtitle "检测到较高版本"
    StrCpy $MioProxyModeBody "当前安装的 MioProxy 版本高于此安装包。$\n$\n覆盖安装会保留现有用户配置，但会把程序文件替换为 ${VERSION}。点击下一步后需要明确确认。"
    StrCpy $MioProxyModePrimary "确认覆盖安装"
  ${EndIf}
FunctionEnd

Function MioProxySetDefaultInstallPath
  !if "${INSTALLMODE}" == "perMachine"
    ${If} ${RunningX64}
      !if "${ARCH}" == "x64"
        StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
      !else if "${ARCH}" == "arm64"
        StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
      !else
        StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
      !endif
    ${Else}
      StrCpy $INSTDIR "$PROGRAMFILES\${PRODUCTNAME}"
    ${EndIf}
  !else if "${INSTALLMODE}" == "currentUser"
    StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"
  !endif
FunctionEnd

Function MioProxyInstallModePage
  ${If} $PassiveMode == 1
    Abort
  ${EndIf}
  ${If} $UpdateMode == 1
    Abort
  ${EndIf}
  Call MioProxySetInstallPresentation
  !insertmacro MUI_HEADER_TEXT "$MioProxyModeTitle" "$MioProxyModeSubtitle"
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 34u "$MioProxyModeTitle"
  Pop $1
  ${NSD_CreateLabel} 0 42u 100% 120u "$MioProxyModeBody"
  Pop $2
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:$MioProxyModePrimary"
  ${NSD_SetFocus} $1
  nsDialogs::Show
FunctionEnd

Function MioProxyInstallModePageLeave
  ${If} $MioProxyVersionComparison == -1
    ${If} $MioProxyDowngradeConfirmed != 1
      MessageBox MB_ICONEXCLAMATION|MB_YESNO "当前安装的 MioProxy 版本高于此安装包。$\n$\n确定要继续覆盖安装 MioProxy ${VERSION} 吗？现有用户配置将保留。" IDYES mio_proxy_downgrade_yes IDNO mio_proxy_downgrade_no
mio_proxy_downgrade_no:
      Abort
mio_proxy_downgrade_yes:
      StrCpy $MioProxyDowngradeConfirmed 1
    ${EndIf}
  ${EndIf}
FunctionEnd

Function MioProxyCheckAppNotRunning
mio_proxy_app_check:
  nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 != 0
    Return
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}
  MessageBox MB_RETRYCANCEL "MioProxy 当前正在运行。请先关闭 MioProxy，然后点击“重试”继续。" IDRETRY mio_proxy_app_check IDCANCEL mio_proxy_app_cancel
  Goto mio_proxy_app_check
mio_proxy_app_cancel:
  Abort
FunctionEnd

Function un.MioProxyCheckAppNotRunning
un_mio_proxy_app_check:
  nsis_tauri_utils::FindProcess "${MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 != 0
    Return
  ${EndIf}
  ${If} ${Silent}
    Abort
  ${EndIf}
  MessageBox MB_RETRYCANCEL "MioProxy 当前正在运行。请先关闭 MioProxy，然后点击“重试”继续。" IDRETRY un_mio_proxy_app_check IDCANCEL un_mio_proxy_app_cancel
  Goto un_mio_proxy_app_check
un_mio_proxy_app_cancel:
  Abort
FunctionEnd

Function SkipDirectoryIfExisting
  ${If} $PassiveMode == 1
    Abort
  ${EndIf}
  ${If} $MioProxyExistingDetected == 1
    Abort
  ${EndIf}
FunctionEnd

Function MioProxyRemoveLegacyInstall
  ${If} $MioProxyLegacyInstallPath == ""
    Return
  ${EndIf}
  ${If} $MioProxyLegacyInstallPath == $INSTDIR
    Return
  ${EndIf}

  ; Remove only files owned by the legacy installation. Keep unrelated files
  ; in a user-selected directory instead of recursively deleting the folder.
  DetailPrint "Removing legacy per-user MioProxy files from $MioProxyLegacyInstallPath"
  Delete "$MioProxyLegacyInstallPath\${MAINBINARYNAME}.exe"
  Delete "$MioProxyLegacyInstallPath\uninstall.exe"
  Delete "$MioProxyLegacyInstallPath\mihomo.exe"
  Delete "$MioProxyLegacyInstallPath\mioproxy-service.exe"
  Delete "$MioProxyLegacyInstallPath\verify-updater-signature.exe"
  Delete "$MioProxyLegacyInstallPath\binaries\GeoIP.dat"
  Delete "$MioProxyLegacyInstallPath\binaries\GeoSite.dat"
  Delete "$MioProxyLegacyInstallPath\binaries\README.md"
  Delete "$MioProxyLegacyInstallPath\binaries\THIRD_PARTY_NOTICES.txt"
  Delete "$MioProxyLegacyInstallPath\binaries\mihomo-x86_64-pc-windows-msvc.exe"
  Delete "$MioProxyLegacyInstallPath\binaries\mioproxy-service-x86_64-pc-windows-msvc.exe"
  RMDir /REBOOTOK "$MioProxyLegacyInstallPath\binaries"
  RMDir "$MioProxyLegacyInstallPath"
FunctionEnd

Function .onInit
  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/NS" $NoShortcutMode
  ${IfNot} ${Errors}
    StrCpy $NoShortcutMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !if "${DISPLAYLANGUAGESELECTOR}" == "true"
    !insertmacro MUI_LANGDLL_DISPLAY
  !endif

  !insertmacro SetContext
  Call MioProxyDetectExistingInstall
  ${If} $MioProxyExistingInvalid == 1
    MessageBox MB_ICONSTOP|MB_OK "检测到 MioProxy，但现有安装记录的版本或路径不可用。请先使用当前安装的卸载程序处理，然后重试。"
    Abort
  ${EndIf}

  ${If} $MioProxyExistingDetected == 1
    !if "${INSTALLMODE}" == "perMachine"
      ${If} $MioProxyExistingRegistryRoot == "HKCU"
        StrCpy $MioProxyLegacyInstallPath $MioProxyExistingInstallPath
        Call MioProxySetDefaultInstallPath
      ${Else}
        StrCpy $INSTDIR $MioProxyExistingInstallPath
      ${EndIf}
    !else
      StrCpy $INSTDIR $MioProxyExistingInstallPath
    !endif
  ${ElseIf} $INSTDIR == "${PLACEHOLDER_INSTALL_DIR}"
    ; Set default install location
    Call MioProxySetDefaultInstallPath
    Call RestorePreviousInstallLocation
  ${EndIf}


  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_INIT
  !endif
FunctionEnd


Section EarlyChecks
  ; A downgrade requires the interactive confirmation page. Passive and
  ; silent invocations must not bypass that explicit confirmation.
  ${If} $MioProxyVersionComparison = -1
    ${If} $PassiveMode = 1
      Abort
    ${EndIf}
    ${If} ${Silent}
      Abort
    ${EndIf}
  ${EndIf}

  ; Abort silent installer if downgrades is disabled
  !if "${ALLOWDOWNGRADES}" == "false"
  ${If} ${Silent}
    ; If downgrading
    ${If} $MioProxyVersionComparison = -1
      System::Call 'kernel32::AttachConsole(i -1)i.r0'
      ${If} $0 <> 0
        System::Call 'kernel32::GetStdHandle(i -11)i.r0'
        System::call 'kernel32::SetConsoleTextAttribute(i r0, i 0x0004)' ; set red color
        FileWrite $0 "$(silentDowngrades)"
      ${EndIf}
      Abort
    ${EndIf}
  ${EndIf}
  !endif

SectionEnd

Section WebView2
  ; Check if Webview2 is already installed and skip this section
  ${If} ${RunningX64}
    ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${Else}
    ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}
  ${If} $4 == ""
    ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2APPGUID}" "pv"
  ${EndIf}

  ${If} $4 == ""
    ; Webview2 installation
    ;
    ; Skip if updating
    ${If} $UpdateMode <> 1
      !if "${INSTALLWEBVIEW2MODE}" == "downloadBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        DetailPrint "$(webview2Downloading)"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Pop $0
        ${If} $0 == "success"
          DetailPrint "$(webview2DownloadSuccess)"
        ${Else}
          DetailPrint "$(webview2DownloadError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "embedBootstrapper"
        Delete "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebview2Setup.exe" "${WEBVIEW2BOOTSTRAPPERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        Goto install_webview2
      !endif

      !if "${INSTALLWEBVIEW2MODE}" == "offlineInstaller"
        Delete "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        File "/oname=$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe" "${WEBVIEW2INSTALLERPATH}"
        DetailPrint "$(installingWebview2)"
        StrCpy $6 "$TEMP\MicrosoftEdgeWebView2RuntimeInstaller.exe"
        Goto install_webview2
      !endif

      Goto webview2_done

      install_webview2:
        DetailPrint "$(installingWebview2)"
        ; $6 holds the path to the webview2 installer
        ExecWait "$6 ${WEBVIEW2INSTALLERARGS} /install" $1
        ${If} $1 = 0
          DetailPrint "$(webview2InstallSuccess)"
        ${Else}
          DetailPrint "$(webview2InstallError)"
          Abort "$(webview2AbortError)"
        ${EndIf}
      webview2_done:
    ${EndIf}
  ${Else}
    !if "${MINIMUMWEBVIEW2VERSION}" != ""
      ${VersionCompare} "${MINIMUMWEBVIEW2VERSION}" "$4" $R0
      ${If} $R0 = 1
        update_webview:
          DetailPrint "$(installingWebview2)"
          ${If} ${RunningX64}
            ReadRegStr $R1 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate" "path"
          ${Else}
            ReadRegStr $R1 HKLM "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 == ""
            ReadRegStr $R1 HKCU "SOFTWARE\Microsoft\EdgeUpdate" "path"
          ${EndIf}
          ${If} $R1 != ""
            ; Chromium updater docs: https://source.chromium.org/chromium/chromium/src/+/main:docs/updater/user_manual.md
            ; Modified from "HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Microsoft EdgeWebView\ModifyPath"
            ExecWait `"$R1" /install appguid=${WEBVIEW2APPGUID}&needsadmin=true` $1
            ${If} $1 = 0
              DetailPrint "$(webview2InstallSuccess)"
            ${Else}
              MessageBox MB_ICONEXCLAMATION|MB_ABORTRETRYIGNORE "$(webview2InstallError)" IDIGNORE ignore IDRETRY update_webview
              Quit
              ignore:
            ${EndIf}
          ${EndIf}
      ${EndIf}
    !endif
  ${EndIf}
SectionEnd

Section Install
  SetOutPath $INSTDIR

  Call MioProxyCheckAppNotRunning

  !ifmacrodef NSIS_HOOK_PREINSTALL
    !insertmacro NSIS_HOOK_PREINSTALL
  !endif

  ; Copy main executable
  File "${MAINBINARYSRCPATH}"

  ; Copy resources
  {{#each resources_dirs}}
    CreateDirectory "$INSTDIR\\{{this}}"
  {{/each}}
  {{#each resources}}
    File /a "/oname={{this.[1]}}" "{{no-escape @key}}"
  {{/each}}
  ; Copy external binaries
  {{#each binaries}}
    File /a "/oname={{this}}" "{{no-escape @key}}"
  {{/each}}

  ; Create file associations

  ; Register deep links

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Save $INSTDIR in registry for future installations
  WriteRegStr SHCTX "${MANUPRODUCTKEY}" "" $INSTDIR

  !if "${INSTALLMODE}" == "both"
    ; Save install mode to be selected by default for the next installation such as updating
    ; or when uninstalling
    WriteRegStr SHCTX "${UNINSTKEY}" $MultiUser.InstallMode 1
  !endif

  ; Remove old main binary if it doesn't match new main binary name
  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"
  ${If} $OldMainBinaryName != ""
  ${AndIf} $OldMainBinaryName != "${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\$OldMainBinaryName"
  ${EndIf}

  ; Save current MAINBINARYNAME for future updates
  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "${MAINBINARYNAME}.exe"

  ; Registry information for add/remove programs
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayIcon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr SHCTX "${UNINSTKEY}" "Publisher" "${MANUFACTURER}"
  WriteRegStr SHCTX "${UNINSTKEY}" "InstallLocation" "$\"$INSTDIR$\""
  WriteRegStr SHCTX "${UNINSTKEY}" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoModify" "1"
  WriteRegDWORD SHCTX "${UNINSTKEY}" "NoRepair" "1"

  ${GetSize} "$INSTDIR" "/M=uninstall.exe /S=0K /G=0" $0 $1 $2
  IntOp $0 $0 + ${ESTIMATEDSIZE}
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD SHCTX "${UNINSTKEY}" "EstimatedSize" "$0"

  !if "${HOMEPAGE}" != ""
    WriteRegStr SHCTX "${UNINSTKEY}" "URLInfoAbout" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "URLUpdateInfo" "${HOMEPAGE}"
    WriteRegStr SHCTX "${UNINSTKEY}" "HelpLink" "${HOMEPAGE}"
  !endif

  ; Create start menu shortcut
  !insertmacro MUI_STARTMENU_WRITE_BEGIN Application
    Call CreateOrUpdateStartMenuShortcut
  !insertmacro MUI_STARTMENU_WRITE_END

  ; Create desktop shortcut for silent and passive installers
  ; because finish page will be skipped
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    Call CreateOrUpdateDesktopShortcut
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTINSTALL
    !insertmacro NSIS_HOOK_POSTINSTALL
  !endif

  ; A per-machine install supersedes a validated per-user installation only
  ; after the new Service and application files have been installed.
  Call MioProxyRemoveLegacyInstall
  !if "${INSTALLMODE}" == "perMachine"
    ${If} $MioProxyExistingRegistryRoot == "HKCU"
      DeleteRegKey HKCU "${UNINSTKEY}"
      DeleteRegValue HKCU "${MANUPRODUCTKEY}" ""
      DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    ${EndIf}
  !endif

  ; Auto close this page for passive mode
  ${If} $PassiveMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function .onInstSuccess
  ; Check for `/R` flag only in silent and passive installers because
  ; GUI installer has a toggle for the user to (re)start the app
  ${If} $PassiveMode = 1
  ${OrIf} ${Silent}
    ${GetOptions} $CMDLINE "/R" $R0
    ${IfNot} ${Errors}
      ${GetOptions} $CMDLINE "/ARGS" $R0
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "$R0"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.onInit
  !insertmacro SetContext

  !if "${INSTALLMODE}" == "both"
    !insertmacro MULTIUSER_UNINIT
  !endif

  !insertmacro MUI_UNGETLANGUAGE

  ${GetOptions} $CMDLINE "/P" $PassiveMode
  ${IfNot} ${Errors}
    StrCpy $PassiveMode 1
  ${EndIf}

  ${GetOptions} $CMDLINE "/UPDATE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Section Uninstall

  Call un.MioProxyCheckAppNotRunning

  !ifmacrodef NSIS_HOOK_PREUNINSTALL
    !insertmacro NSIS_HOOK_PREUNINSTALL
  !endif

  ; Delete the app directory and its content from disk
  ; Copy main executable
  Delete "$INSTDIR\${MAINBINARYNAME}.exe"

  ; Delete resources
    Delete "$INSTDIR\binaries\GeoIP.dat"
    Delete "$INSTDIR\binaries\GeoSite.dat"
    Delete "$INSTDIR\binaries\README.md"
    Delete "$INSTDIR\binaries\THIRD_PARTY_NOTICES.txt"
    Delete "$INSTDIR\binaries\mihomo-x86_64-pc-windows-msvc.exe"
    Delete "$INSTDIR\binaries\mioproxy-service-x86_64-pc-windows-msvc.exe"

  ; Delete external binaries
    Delete "$INSTDIR\mihomo.exe"
    Delete "$INSTDIR\mioproxy-service.exe"
    Delete "$INSTDIR\verify-updater-signature.exe"

  ; Delete app associations

  ; Delete deep links


  ; Delete uninstaller
  Delete "$INSTDIR\uninstall.exe"

  RMDir /REBOOTOK "$INSTDIR\binaries"
  RMDir "$INSTDIR"

  ; Remove shortcuts if not updating
  ${If} $UpdateMode <> 1
    !insertmacro DeleteAppUserModelId

    ; Remove start menu shortcut
    !insertmacro MUI_STARTMENU_GETFOLDER Application $AppStartMenuFolder
    !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
      RMDir "$SMPROGRAMS\$AppStartMenuFolder"
    ${EndIf}
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; Remove desktop shortcuts
    !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}
  ${EndIf}

  ; Remove registry information for add/remove programs
  !if "${INSTALLMODE}" == "both"
    DeleteRegKey SHCTX "${UNINSTKEY}"
  !else if "${INSTALLMODE}" == "perMachine"
    DeleteRegKey HKLM "${UNINSTKEY}"
  !else
    DeleteRegKey HKCU "${UNINSTKEY}"
  !endif

  ; Removes the Autostart entry for ${PRODUCTNAME} from the HKCU Run key if it exists.
  ; This ensures the program does not launch automatically after uninstallation if it exists.
  ; If it doesn't exist, it does nothing.
  ; We do this when not updating (to preserve the registry value on updates)
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
  ${EndIf}

  ; Delete app data if the checkbox is selected
  ; and if not updating
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    ; Clear the install location $INSTDIR from registry
    DeleteRegKey SHCTX "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty SHCTX "${MANUKEY}"

    ; Clear the install language from registry
    DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
    DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"

    SetShellVarContext current
    RmDir /r "$APPDATA\${BUNDLEID}"
    RmDir /r "$LOCALAPPDATA\${BUNDLEID}"
  ${EndIf}

  !ifmacrodef NSIS_HOOK_POSTUNINSTALL
    !insertmacro NSIS_HOOK_POSTUNINSTALL
  !endif

  ; Auto close if passive mode or updating
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    SetAutoClose true
  ${EndIf}
SectionEnd

Function RestorePreviousInstallLocation
  ReadRegStr $4 SHCTX "${MANUPRODUCTKEY}" ""
  StrCmp $4 "" +2 0
    StrCpy $INSTDIR $4
FunctionEnd

Function Skip
  Abort
FunctionEnd

Function SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd
Function un.SkipIfPassive
  ${IfThen} $PassiveMode = 1  ${|} Abort ${|}
FunctionEnd

Function CreateOrUpdateStartMenuShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  StrCpy $R0 0

  !insertmacro IsShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    StrCpy $R0 1
  ${EndIf}

  ${If} $R0 = 1
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  !if "${STARTMENUFOLDER}" != ""
    CreateDirectory "$SMPROGRAMS\$AppStartMenuFolder"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
  !else
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  !endif
FunctionEnd

Function CreateOrUpdateDesktopShortcut
  ; We used to use product name as MAINBINARYNAME
  ; migrate old shortcuts to target the new MAINBINARYNAME
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\$OldMainBinaryName"
  Pop $0
  ${If} $0 = 1
    !insertmacro SetShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    Return
  ${EndIf}

  ; Skip creating shortcut if in update mode or no shortcut mode
  ; but always create if migrating from wix
  ${If} $WixMode = 0
    ${If} $UpdateMode = 1
    ${OrIf} $NoShortcutMode = 1
      Return
    ${EndIf}
  ${EndIf}

  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
FunctionEnd
