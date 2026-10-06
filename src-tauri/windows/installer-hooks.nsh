; NSIS installer hooks (bundle.windows.nsis.installerHooks in tauri.windows.conf.json).
;
; The uninstaller Tauri generates deletes only the files of its own version, and the installer
; only adds and overwrites files. The viewer's bundles have hashed names, so every update left the
; previous version's ui\assets behind, and the uninstall then kept the install folder.
;
; ui, python, models, templates, projects and runtime hold the app's resources. They are replaced
; as a whole on an update and removed on uninstall, but only where they are known to be ours. The
; installer can put the app into any folder, and it reuses the last folder on the next install, so
; the first install leaves a marker that says what belongs to the app:
;   .fairbeam-resources  all six subfolders are the app's own: replace on update, remove on uninstall
;   .fairbeam-shared     the folder had its own subfolders of these names: never remove them

; 0 shared, 1 resources
Var FairbeamOwnsResources

!macro FairbeamRemoveResources
  RMDir /r "$INSTDIR\ui"
  RMDir /r "$INSTDIR\python"
  RMDir /r "$INSTDIR\models"
  RMDir /r "$INSTDIR\templates"
  RMDir /r "$INSTDIR\projects"
  RMDir /r "$INSTDIR\runtime"
!macroend

!macro NSIS_HOOK_PREINSTALL
  StrCpy $FairbeamOwnsResources 0
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ; an update or a reinstall: nothing may run from the folder while it is cleared
    !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    ${If} ${FileExists} "$INSTDIR\.fairbeam-resources"
      !insertmacro FairbeamRemoveResources
      StrCpy $FairbeamOwnsResources 1
    ${EndIf}
  ; no app in the folder: a first install, or an update whose /UPDATE uninstall ran already (it
  ; keeps the marker)
  ${ElseIf} ${FileExists} "$INSTDIR\.fairbeam-resources"
    StrCpy $FairbeamOwnsResources 1
  ${ElseIf} ${FileExists} "$INSTDIR\.fairbeam-shared"
  ${ElseIf} ${FileExists} "$INSTDIR\ui\*.*"
  ${OrIf} ${FileExists} "$INSTDIR\python\*.*"
  ${OrIf} ${FileExists} "$INSTDIR\models\*.*"
  ${OrIf} ${FileExists} "$INSTDIR\templates\*.*"
  ${OrIf} ${FileExists} "$INSTDIR\projects\*.*"
  ${OrIf} ${FileExists} "$INSTDIR\runtime\*.*"
    ; a first install into a folder that already has one of these: not ours
  ${Else}
    StrCpy $FairbeamOwnsResources 1
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\.fairbeam-resources"
  Delete "$INSTDIR\.fairbeam-shared"
  ${If} $FairbeamOwnsResources = 1
    FileOpen $0 "$INSTDIR\.fairbeam-resources" w
    FileWrite $0 "fairbeam: ui, python, models, templates, projects and runtime in this folder are the app's own. They are replaced on update and removed on uninstall.$\r$\n"
  ${Else}
    FileOpen $0 "$INSTDIR\.fairbeam-shared" w
    FileWrite $0 "fairbeam: this folder also holds other files. The app's installer and uninstaller never remove its subfolders as a whole.$\r$\n"
  ${EndIf}
  FileClose $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} ${FileExists} "$INSTDIR\.fairbeam-resources"
    !insertmacro FairbeamRemoveResources
  ${EndIf}
  ${If} $UpdateMode <> 1
    ; an /UPDATE uninstall keeps the marker for the install that follows
    Delete "$INSTDIR\.fairbeam-resources"
    Delete "$INSTDIR\.fairbeam-shared"
  ${EndIf}
  ; only when nothing else is left in it
  RMDir "$INSTDIR"
!macroend
