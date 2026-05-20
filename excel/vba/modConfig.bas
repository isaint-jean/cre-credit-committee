Attribute VB_Name = "modConfig"
'------------------------------------------------------------------------------
' modConfig
' Workbook-local infrastructure constants ONLY. No schema decisions live here.
'
' Allowed:
'   - API base URL (transport configuration).
'   - Named ranges on the Inputs sheet that capture USER input (deal id,
'     asset class selection, auth token). These are write-targets for the
'     human, not part of the projection schema.
'   - The infrastructure sheet name (_Config) used to override the API URL.
'
' Forbidden:
'   - Sheet names referenced by the rendered schema (Cover, CrossCheck, ...).
'   - Named ranges referenced by cellBindings.
'   - Managed-namespace prefixes/literals.
' All of those come from the backend payload.
'------------------------------------------------------------------------------
Option Explicit

' --- Workbook identity (workbook-local infra, not schema) -------------------
' The contract version this workbook was BUILT against. Bumped only as part
' of a coordinated workbook rebuild against a new RENDER_CONTRACT_VERSION.
' The backend uses this to compute migrationsFromClient.
Public Const EMBEDDED_CONTRACT_VERSION As Long = 4

' --- API endpoint configuration ---------------------------------------------
Public Const DEFAULT_API_BASE_URL As String = "http://localhost:3000/api"

' Workbook-local infrastructure: a hidden sheet whose B2 cell can override
' DEFAULT_API_BASE_URL at runtime. NOT a schema concern.
Public Const SHEET_CONFIG As String = "_Config"

' --- Inputs-side named ranges (USER input, not schema output) ----------------
Public Const RNG_DEAL_ID                As String = "Input_Deal_Id"
Public Const RNG_ASSET_CLASS            As String = "Input_Asset_Class"
Public Const RNG_AUTH_TOKEN             As String = "Input_Auth_Token"
' Sole persisted Excel-side state for structural variance. Set by
' Sheet_Inputs on assetClass change, read by modRefresh on every /render call.
' NEVER inferred or defaulted in VBA — populated from
' /render-config.assetClassVariantDefaults[assetClass].
Public Const RNG_STRUCTURAL_VARIANT_KEY As String = "Input_Structural_Variant_Key"

' --- Helpers -----------------------------------------------------------------
Public Function ApiBaseUrl() As String
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(SHEET_CONFIG)
    On Error GoTo 0
    If ws Is Nothing Then ApiBaseUrl = DEFAULT_API_BASE_URL: Exit Function
    Dim v As Variant: v = ws.Range("B2").value
    If Len(CStr(v)) = 0 Then ApiBaseUrl = DEFAULT_API_BASE_URL Else ApiBaseUrl = CStr(v)
End Function

Public Function GetNamedValue(ByVal rangeName As String) As Variant
    On Error Resume Next
    GetNamedValue = ThisWorkbook.Names(rangeName).RefersToRange.value
    On Error GoTo 0
End Function

Public Function AuthHeaderValue() As String
    Dim t As String: t = CStr(GetNamedValue(RNG_AUTH_TOKEN))
    If Len(t) = 0 Then AuthHeaderValue = "" Else AuthHeaderValue = "Bearer " & t
End Function
