Attribute VB_Name = "modRefresh"
'------------------------------------------------------------------------------
' modRefresh
' Single entry point: RefreshFromBackend.
'
' Order of operations (no step may be skipped):
'   1. Read dealId, assetClass, structuralVariantKey from named ranges.
'   2. HTTP GET /api/underwriting/render with all three (no defaults, no
'      fallbacks — empty variant key is a hard error here, not silently
'      resolved by the workbook).
'   3. Parse JSON.
'   4. Cross-check the payload's structuralIdentity against what we requested
'      (assetClass, structuralVariantKey, top-level vs identity agreement).
'   5. modValidate.AssertBindingsMatchSchemaAddresses(payload)  ← closed-system
'   6. modValidate.AssertSchemaAddressesResolve(payload)        ← forward
'   7. modValidate.AssertNoExtraManagedNames(payload)           ← reverse
'   8. ApplyVisibleTabs / WriteCellBindings / WriteDriversTable / banner.
'
' Any validation failure raises ERR_VALIDATE BEFORE any cell is written.
' The refresh aborts cleanly with a single dialog explaining the drift.
'
' DEPENDENCY: VBA-JSON (Tim Hall) — import JsonConverter.bas as a module.
'------------------------------------------------------------------------------
Option Explicit

Public Const ERR_REFRESH As Long = vbObjectError + 5300

Public Sub RefreshFromBackend()
    Dim dealId As String, assetClass As String, variantKey As String
    dealId = CStr(GetNamedValue(RNG_DEAL_ID))
    assetClass = CStr(GetNamedValue(RNG_ASSET_CLASS))
    variantKey = CStr(GetNamedValue(RNG_STRUCTURAL_VARIANT_KEY))

    If Len(dealId) = 0 Then
        MsgBox "Please enter a Deal ID on the Inputs sheet.", vbExclamation, "Refresh"
        Exit Sub
    End If
    If Len(assetClass) = 0 Then
        MsgBox "Please choose an Asset Class on the Inputs sheet.", vbExclamation, "Refresh"
        Exit Sub
    End If
    ' structuralVariantKey is REQUIRED. NO local inference, NO default. The
    ' Sheet_Inputs change handler is responsible for populating it from
    ' /render-config.assetClassVariantDefaults whenever assetClass changes.
    If Len(variantKey) = 0 Then
        Err.Raise ERR_REFRESH, "modRefresh", _
            "structuralVariantKey is empty (named range " & _
            RNG_STRUCTURAL_VARIANT_KEY & "). Re-select the Asset Class on the " & _
            "Inputs sheet to repopulate it from /render-config. The workbook " & _
            "MUST NOT infer a variant locally."
    End If

    Dim url As String
    url = ApiBaseUrl() & "/underwriting/render?dealId=" & UrlEncode(dealId) & _
          "&assetClass=" & UrlEncode(assetClass) & _
          "&structuralVariantKey=" & UrlEncode(variantKey) & _
          "&clientContractVersion=" & EMBEDDED_CONTRACT_VERSION

    Dim raw As String
    raw = HttpGetJson(url)
    If Len(raw) = 0 Then Exit Sub  ' HttpGetJson surfaced an error already

    Dim payload As Object
    On Error GoTo ParseErr
    Set payload = JsonConverter.ParseJson(raw)
    On Error GoTo 0

    ' --- Migration drift gate (before any writes) ----------------------------
    Dim manifest As Object
    On Error Resume Next
    Set manifest = payload("migrationsFromClient")
    On Error GoTo 0
    If Not manifest Is Nothing Then
        If Not modMigrations.HandleMigrationDrift(manifest) Then
            Exit Sub  ' user declined; safe abort, no writes
        End If
    End If

    Dim cellBindings As Object, schemaAddresses As Object, policy As Object
    Set cellBindings = payload("cellBindings")
    Set schemaAddresses = payload("schemaAddresses")
    Set policy = payload("managedNamespace")

    Application.ScreenUpdating = False
    Application.EnableEvents = False
    On Error GoTo Restore

    ' --- StructuralIdentity cross-check (request vs payload) ----------------
    AssertStructuralIdentityMatchesRequest payload, assetClass, variantKey

    ' --- Validation gates (all three must pass before any write) -------------
    modValidate.AssertBindingsMatchSchemaAddresses cellBindings, schemaAddresses
    modValidate.AssertSchemaAddressesResolve schemaAddresses
    modValidate.AssertNoExtraManagedNames schemaAddresses, policy

    ' --- Writes (only reached if validation succeeded) -----------------------
    ApplyVisibleTabs payload("visibleTabs")
    WriteCellBindings cellBindings
    WriteTables payload("tables")

Restore:
    Application.EnableEvents = True
    Application.ScreenUpdating = True
    If Err.Number <> 0 Then
        MsgBox "Refresh aborted." & vbLf & vbLf & Err.Description, _
               vbCritical, "Schema integrity error"
    End If
    Exit Sub

ParseErr:
    MsgBox "Could not parse render payload as JSON. Raw: " & Left$(raw, 200), _
           vbCritical, "Refresh"
End Sub

' --- StructuralIdentity assertion -------------------------------------------
' Hard-fails if the backend payload's (assetClass, structuralVariantKey)
' diverge from what we requested, OR if the top-level structuralVariantKey
' disagrees with structuralIdentity.structuralVariantKey. This catches:
'   - server-side variant remapping
'   - client/server variant key drift
'   - mis-encoded URL params
' The backend already enforces these invariants; this is defense in depth so
' the workbook never writes cells from a payload whose identity it has not
' verified.
Private Sub AssertStructuralIdentityMatchesRequest( _
        ByVal payload As Object, _
        ByVal expectedAssetClass As String, _
        ByVal expectedVariantKey As String)

    Dim payloadAssetClass As String, payloadVariantKey As String
    payloadAssetClass = CStr(payload("assetClass"))
    payloadVariantKey = CStr(payload("structuralVariantKey"))

    If StrComp(payloadAssetClass, expectedAssetClass, vbBinaryCompare) <> 0 Then
        Err.Raise ERR_REFRESH, "modRefresh", _
            "Payload assetClass=" & payloadAssetClass & " disagrees with " & _
            "request assetClass=" & expectedAssetClass & "."
    End If
    If StrComp(payloadVariantKey, expectedVariantKey, vbBinaryCompare) <> 0 Then
        Err.Raise ERR_REFRESH, "modRefresh", _
            "Payload structuralVariantKey=" & payloadVariantKey & " disagrees " & _
            "with request structuralVariantKey=" & expectedVariantKey & "."
    End If

    Dim identity As Object
    On Error Resume Next
    Set identity = payload("structuralIdentity")
    On Error GoTo 0
    If identity Is Nothing Then
        Err.Raise ERR_REFRESH, "modRefresh", _
            "Payload missing structuralIdentity — backend contract violation."
    End If

    Dim identityAssetClass As String, identityVariantKey As String
    identityAssetClass = CStr(identity("assetClass"))
    identityVariantKey = CStr(identity("structuralVariantKey"))

    If StrComp(identityAssetClass, payloadAssetClass, vbBinaryCompare) <> 0 Then
        Err.Raise ERR_REFRESH, "modRefresh", _
            "structuralIdentity.assetClass=" & identityAssetClass & " disagrees " & _
            "with top-level assetClass=" & payloadAssetClass & "."
    End If
    If StrComp(identityVariantKey, payloadVariantKey, vbBinaryCompare) <> 0 Then
        Err.Raise ERR_REFRESH, "modRefresh", _
            "structuralIdentity.structuralVariantKey=" & identityVariantKey & _
            " disagrees with top-level structuralVariantKey=" & payloadVariantKey & "."
    End If
End Sub

' --- Variant default lookup --------------------------------------------------
' Fetches /render-config and returns
' assetClassVariantDefaults[assetClass]. The ONLY permitted source for the
' default variant — Sheet_Inputs uses this on assetClass change. Hard-fails
' if the asset class has no registered default; the workbook NEVER infers.
'
' Returns "" only when HttpGetJson surfaced its own error dialog so the
' caller can abort silently.
Public Function FetchDefaultVariantKey(ByVal assetClass As String) As String
    Dim url As String
    url = ApiBaseUrl() & "/underwriting/render-config?clientContractVersion=" & _
          EMBEDDED_CONTRACT_VERSION

    Dim raw As String
    raw = HttpGetJson(url)
    If Len(raw) = 0 Then
        FetchDefaultVariantKey = ""
        Exit Function
    End If

    Dim cfg As Object
    On Error GoTo ParseErr
    Set cfg = JsonConverter.ParseJson(raw)
    On Error GoTo 0

    Dim defaults As Object
    On Error Resume Next
    Set defaults = cfg("assetClassVariantDefaults")
    On Error GoTo 0
    If defaults Is Nothing Then
        Err.Raise ERR_REFRESH, "modRefresh", _
            "/render-config response missing assetClassVariantDefaults — backend " & _
            "contract violation (expected at v" & EMBEDDED_CONTRACT_VERSION & ")."
    End If

    Dim k As Variant, found As Boolean: found = False
    For Each k In defaults.Keys
        If StrComp(CStr(k), assetClass, vbBinaryCompare) = 0 Then
            FetchDefaultVariantKey = CStr(defaults(k))
            found = True
            Exit For
        End If
    Next k
    If Not found Then
        Err.Raise ERR_REFRESH, "modRefresh", _
            "/render-config has no assetClassVariantDefaults entry for " & _
            "assetClass=" & assetClass & ". The workbook MUST NOT pick a " & _
            "variant locally; the backend MUST register a default."
    End If
    If Len(FetchDefaultVariantKey) = 0 Then
        Err.Raise ERR_REFRESH, "modRefresh", _
            "assetClassVariantDefaults[" & assetClass & "] is empty — backend " & _
            "contract violation."
    End If
    Exit Function

ParseErr:
    Err.Raise ERR_REFRESH, "modRefresh", _
        "Could not parse /render-config response while resolving variant default."
End Function

Public Sub WriteNamedValue(ByVal rangeName As String, ByVal value As Variant)
    Dim r As Range
    On Error Resume Next
    Set r = ThisWorkbook.Names(rangeName).RefersToRange
    On Error GoTo 0
    If r Is Nothing Then
        Err.Raise ERR_REFRESH, "modRefresh", _
            "Named range " & rangeName & " is not defined in this workbook. " & _
            "Workbook needs to be rebuilt against contract v" & _
            EMBEDDED_CONTRACT_VERSION & "."
    End If
    r.value = value
End Sub

' --- HTTP --------------------------------------------------------------------
Private Function HttpGetJson(ByVal url As String) As String
    Dim http As Object
    On Error GoTo HttpErr
    Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", url, False
    http.setRequestHeader "Accept", "application/json"
    Dim auth As String
    auth = AuthHeaderValue()
    If Len(auth) > 0 Then http.setRequestHeader "Authorization", auth
    http.send

    If http.Status >= 200 And http.Status < 300 Then
        HttpGetJson = http.responseText
    Else
        MsgBox "Backend returned " & http.Status & " " & http.statusText & vbCrLf & _
               Left$(http.responseText, 400), vbCritical, "Refresh"
        HttpGetJson = ""
    End If
    Exit Function
HttpErr:
    MsgBox "HTTP error: " & Err.Description, vbCritical, "Refresh"
    HttpGetJson = ""
End Function

' Conservative URL encoder — alphanumerics + a few safe punctuation chars.
Public Function UrlEncode(ByVal s As String) As String
    Dim i As Long, ch As String, code As Long, out As String
    For i = 1 To Len(s)
        ch = Mid$(s, i, 1)
        code = AscW(ch)
        If (code >= 48 And code <= 57) Or _
           (code >= 65 And code <= 90) Or _
           (code >= 97 And code <= 122) Or _
           ch = "-" Or ch = "_" Or ch = "." Or ch = "~" Then
            out = out & ch
        Else
            out = out & "%" & Right$("0" & Hex(code), 2)
        End If
    Next i
    UrlEncode = out
End Function
