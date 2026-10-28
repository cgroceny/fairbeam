; Windows .fb registration: preserve existing choices and remove only our current command.
; Loaded after FileAssociation.nsh; template definitions become available only
; later, so validate identity/scope when the standard macros expand.
!macroundef APP_ASSOCIATE
!macroundef APP_UNASSOCIATE

!macro FairbeamAssertAssociation EXT FILECLASS
  !if "${BUNDLEID}" != "org.fairbeam.desktop"
    !error "Unexpected bundle identity for Fairbeam file association"
  !endif
  !if "${INSTALLMODE}" != "currentUser"
    !error "Review association ownership before changing installation scope"
  !endif
  !if "${EXT}" != "fb"
    !error "Unexpected Fairbeam file extension"
  !endif
  !if "${FILECLASS}" != "Fairbeam document"
    !error "Unexpected Fairbeam file class"
  !endif
!macroend

; Query presence, not contents. No buffer or string-length interpretation.
; RRF_RT_ANY|RRF_NOEXPAND plus the view used by pinned Tauri SetContext.
; RegGetValueW returns 2 only for missing value; any other result prevents claim.
; Predefined keys are passed as pointer-sized signed constants, as HKEY defines.
!macro FairbeamQueryAssociationValue ROOT SUBKEY
  StrCpy $R0 "0"
  !if "${ARCH}" == "x64"
    System::Call 'advapi32::RegGetValueW(p ${ROOT}, w "${SUBKEY}", w "", i 0x1001ffff, p 0, p 0, p 0) i .R0'
  !else if "${ARCH}" == "arm64"
    System::Call 'advapi32::RegGetValueW(p ${ROOT}, w "${SUBKEY}", w "", i 0x1001ffff, p 0, p 0, p 0) i .R0'
  !else
    System::Call 'advapi32::RegGetValueW(p ${ROOT}, w "${SUBKEY}", w "", i 0x1002ffff, p 0, p 0, p 0) i .R0'
  !endif
!macroend

!macro APP_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
  !insertmacro FairbeamAssertAssociation "${EXT}" "${FILECLASS}"
  Push $R0
  ; HKEY_CURRENT_USER=-2147483647, HKEY_CLASSES_ROOT=-2147483648.
  ; Defined empty defaults also count as choices. Never claim on query failure.
  !insertmacro FairbeamQueryAssociationValue -2147483647 "Software\Classes\.${EXT}"
  StrCmp $R0 "2" 0 fb_associate_register_class
  !insertmacro FairbeamQueryAssociationValue -2147483648 ".${EXT}"
  StrCmp $R0 "2" 0 fb_associate_register_class
  ; An existing registration indicates update/reinstall, even if the user
  ; deleted the extension default. Refresh the command without retaking default.
  !insertmacro FairbeamQueryAssociationValue -2147483647 "Software\Classes\${FILECLASS}\shell\open\command"
  StrCmp $R0 "2" 0 fb_associate_register_class
  !insertmacro FairbeamQueryAssociationValue -2147483648 "${FILECLASS}\shell\open\command"
  StrCmp $R0 "2" 0 fb_associate_register_class
  WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "${FILECLASS}"

fb_associate_register_class:
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}" "" `${DESCRIPTION}`
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\DefaultIcon" "" `${ICON}`
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\shell\open" "" `${COMMANDTEXT}`
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}" ""
  ; Register the executable candidate as well as the document ProgID. Windows
  ; may store an explicit Open With choice as Applications\fairbeam.exe.
  ; This metadata makes that registration installer-owned; it does not set or
  ; rewrite UserChoice, and does not prove Explorer picker discovery on its own.
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "Fairbeam"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  !insertmacro UPDATEFILEASSOC
  Pop $R0
!macroend

!macro APP_UNASSOCIATE EXT FILECLASS
  !insertmacro FairbeamAssertAssociation "${EXT}" "${FILECLASS}"
  Push $R0
  ReadRegStr $R0 SHCTX "Software\Classes\${FILECLASS}\shell\open\command" ""
  StrCmp $R0 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"' 0 fb_unassociate_application
  ; Microsoft recommends leaving extension defaults; an unregistered ProgID
  ; is ignored. Remove only our candidate value and this command-owned class.
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}"
  DeleteRegKey SHCTX "Software\Classes\${FILECLASS}"
  !insertmacro UPDATEFILEASSOC
fb_unassociate_application:
  ; The executable registration can exist independently of our ProgID after
  ; the user selects an executable in Open With. Verify its command separately
  ; so an old uninstall cannot remove a newer installation's candidate.
  ReadRegStr $R0 SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" ""
  StrCmp $R0 '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"' 0 fb_unassociate_done
  ; Applications can also carry user-added verbs/types. Remove our values,
  ; then prune empty keys only; do not delete those independent additions.
  DeleteRegValue SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" ""
  DeleteRegValue SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}"
  ReadRegStr $R0 SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName"
  StrCmp $R0 "Fairbeam" 0 fb_unassociate_application_prune
  DeleteRegValue SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName"
fb_unassociate_application_prune:
  DeleteRegKey /ifempty SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command"
  DeleteRegKey /ifempty SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open"
  DeleteRegKey /ifempty SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell"
  DeleteRegKey /ifempty SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes"
  DeleteRegKey /ifempty SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  !insertmacro UPDATEFILEASSOC
fb_unassociate_done:
  Pop $R0
!macroend
