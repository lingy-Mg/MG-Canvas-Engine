; Keep Tauri's file association metadata and always provide an Open With
; choice. Use the extension default only when Windows has no other choice.
!macroundef APP_ASSOCIATE
!macro APP_ASSOCIATE EXT FILECLASS DESCRIPTION ICON COMMANDTEXT COMMAND
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}" "" `${DESCRIPTION}`
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\DefaultIcon" "" `${ICON}`
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\shell" "" "open"
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\shell\open" "" `${COMMANDTEXT}`
  WriteRegStr SHCTX "Software\Classes\${FILECLASS}\shell\open\command" "" `${COMMAND}`
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}" ""
  Push $R0
  Push $R1
  Push $R2
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.${EXT}\UserChoice" "ProgId"
  ReadRegStr $R1 HKCU "Software\Classes\.${EXT}" ""
  ReadRegStr $R2 HKLM "Software\Classes\.${EXT}" ""
  ${If} $R0 == ""
  ${AndIf} $R1 == ""
  ${AndIf} $R2 == ""
    WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "${FILECLASS}"
    WriteRegStr SHCTX "Software\Classes\.${EXT}" "${FILECLASS}.fallback" "$INSTDIR"
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R0
  ClearErrors
  !insertmacro UPDATEFILEASSOC
!macroend

!macroundef APP_UNASSOCIATE
!macro APP_UNASSOCIATE EXT FILECLASS
  Push $R0
  Push $R1
  ReadRegStr $R0 SHCTX "Software\Classes\${FILECLASS}\shell\open\command" ""
  ${If} $R0 == '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\"'
    ReadRegStr $R1 SHCTX "Software\Classes\.${EXT}" "${FILECLASS}.fallback"
    ${If} $R1 == "$INSTDIR"
      ReadRegStr $R0 SHCTX "Software\Classes\.${EXT}" ""
      ${If} $R0 == "${FILECLASS}"
        DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
      ${EndIf}
      DeleteRegValue SHCTX "Software\Classes\.${EXT}" "${FILECLASS}.fallback"
    ${EndIf}
    DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${FILECLASS}"
    DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
    DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}"
    DeleteRegKey SHCTX "Software\Classes\${FILECLASS}"
    !insertmacro UPDATEFILEASSOC
  ${EndIf}
  Pop $R1
  Pop $R0
  ClearErrors
!macroend
