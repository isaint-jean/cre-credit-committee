VERSION 1.0 CLASS
BEGIN
  MultiUse = -1  'True
END
Attribute VB_Name = "ThisWorkbook"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = True
'------------------------------------------------------------------------------
' ThisWorkbook
' On open:
'   1. Hide _Config sheet.
'   2. Run a workbook integrity self-test against /render-config — if any
'      schema address fails to resolve OR the workbook contains managed-
'      namespace named ranges not in the schema, the user gets a clear error
'      message explaining the drift.
'
' The self-test is best-effort: if the API is unreachable, we surface a
' warning but do not block use (the same checks fire again on every refresh).
'------------------------------------------------------------------------------
Option Explicit

Private Sub Workbook_Open()
    On Error Resume Next
    ThisWorkbook.Worksheets(SHEET_CONFIG).Visible = xlSheetVeryHidden
    On Error GoTo 0

    On Error GoTo SkipSelfTest
    SelfTestSchema
    Exit Sub

SkipSelfTest:
    ' Self-test is advisory at open. RefreshFromBackend re-validates and
    ' will block on drift before any cell is written.
    Debug.Print "Workbook self-test skipped: " & Err.Description
End Sub

Private Sub SelfTestSchema()
    Dim url As String
    url = ApiBaseUrl() & "/underwriting/render-config?clientContractVersion=" & EMBEDDED_CONTRACT_VERSION

    Dim http As Object
    Set http = CreateObject("MSXML2.XMLHTTP")
    http.Open "GET", url, False
    http.setRequestHeader "Accept", "application/json"
    Dim auth As String
    auth = AuthHeaderValue()
    If Len(auth) > 0 Then http.setRequestHeader "Authorization", auth
    http.send
    If http.Status < 200 Or http.Status >= 300 Then Exit Sub

    Dim cfg As Object
    Set cfg = JsonConverter.ParseJson(http.responseText)
    If cfg Is Nothing Then Exit Sub

    ' Migration drift surfaces at workbook open — informational only.
    ' RefreshFromBackend re-prompts before performing any writes.
    Dim manifest As Object
    On Error Resume Next
    Set manifest = cfg("migrationsFromClient")
    On Error GoTo 0
    If Not manifest Is Nothing Then
        modMigrations.HandleMigrationDrift manifest
    End If

    ' v4 contract: addresses + managed-namespace are keyed by
    ' (assetClass, structuralVariantKey). The workbook union covers every
    ' (assetClass, variant) combination registered by the backend.
    Dim byClassVariant As Object
    Dim nsByClassVariant As Object
    Set byClassVariant = cfg("addressesByAssetClassVariant")
    Set nsByClassVariant = cfg("managedNamespaceByAssetClassVariant")
    If byClassVariant Is Nothing Or nsByClassVariant Is Nothing Then Exit Sub

    ' Flat union of every address across all (assetClass, variant) pairs.
    Dim union As Object: Set union = CreateObject("Scripting.Dictionary")
    union.CompareMode = vbBinaryCompare
    Dim ac As Variant, vk As Variant, addr As Variant
    For Each ac In byClassVariant.Keys
        Dim variantsForClass As Object: Set variantsForClass = byClassVariant(ac)
        For Each vk In variantsForClass.Keys
            For Each addr In variantsForClass(vk)
                union(CStr(addr)) = True
            Next addr
        Next vk
    Next ac

    Dim flat As Collection: Set flat = New Collection
    Dim k As Variant
    For Each k In union.Keys
        flat.Add CStr(k)
    Next k

    ' Managed-namespace policy is variant-keyed. The reverse check needs to
    ' apply EVERY registered policy (sheets/prefixes/literals) so a workbook
    ' name that's managed under any variant is caught. Iterate each policy.
    On Error GoTo Drift
    modValidate.AssertSchemaAddressesResolve flat
    For Each ac In nsByClassVariant.Keys
        Dim nsVariants As Object: Set nsVariants = nsByClassVariant(ac)
        For Each vk In nsVariants.Keys
            modValidate.AssertNoExtraManagedNames flat, nsVariants(vk)
        Next vk
    Next ac
    Exit Sub

Drift:
    MsgBox "Workbook integrity check failed at open." & vbLf & vbLf & _
           Err.Description, vbCritical, "Schema drift"
End Sub
