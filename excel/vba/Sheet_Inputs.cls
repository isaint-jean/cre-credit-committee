VERSION 1.0 CLASS
BEGIN
  MultiUse = -1  'True
END
Attribute VB_Name = "Sheet_Inputs"
Attribute VB_GlobalNameSpace = False
Attribute VB_Creatable = False
Attribute VB_PredeclaredId = True
Attribute VB_Exposed = True
'------------------------------------------------------------------------------
' Sheet_Inputs (class module attached to the "Inputs" worksheet)
'
' Place this code BEHIND the Inputs worksheet, not in a standard module:
'   In the VBE, double-click the "Inputs" sheet under "Microsoft Excel Objects"
'   and paste the body of Worksheet_Change there. The Attribute lines at the
'   top of this file are only used when importing the entire .cls — they bind
'   the class to the worksheet object.
'
' Behaviour: when the Asset Class cell changes, perform the strict v4 sequence:
'   1. Read assetClass from named range.
'   2. Call /render-config to obtain assetClassVariantDefaults.
'   3. Set structuralVariantKey = config.assetClassVariantDefaults[assetClass]
'      (the ONLY permitted source of a default; NO local inference).
'   4. Persist structuralVariantKey to the Input_Structural_Variant_Key named
'      range — Excel's only piece of structural-variance state.
'   5. Call modRefresh.RefreshFromBackend, which reads both named ranges and
'      hard-fails if either is empty.
'
' This is the ONLY event handler. NO underwriting math, NO variant inference.
'------------------------------------------------------------------------------
Option Explicit

Private Sub Worksheet_Change(ByVal Target As Range)
    Dim assetClassRange As Range
    On Error Resume Next
    Set assetClassRange = ThisWorkbook.Names(RNG_ASSET_CLASS).RefersToRange
    On Error GoTo 0
    If assetClassRange Is Nothing Then Exit Sub

    If Intersect(Target, assetClassRange) Is Nothing Then Exit Sub
    If Application.EnableEvents = False Then Exit Sub

    ' 1. Read the new asset class.
    Dim assetClass As String
    assetClass = CStr(GetNamedValue(RNG_ASSET_CLASS))
    If Len(assetClass) = 0 Then
        ' User cleared the cell — also clear the variant key so a stale value
        ' cannot leak into the next refresh.
        Application.EnableEvents = False
        On Error Resume Next
        modRefresh.WriteNamedValue RNG_STRUCTURAL_VARIANT_KEY, ""
        On Error GoTo 0
        Application.EnableEvents = True
        Exit Sub
    End If

    ' 2-4. Resolve the default variant via /render-config and persist it.
    '      Disable events while we write the named range so this handler does
    '      not re-enter itself.
    Application.EnableEvents = False
    On Error GoTo ResolveErr

    Dim variantKey As String
    variantKey = modRefresh.FetchDefaultVariantKey(assetClass)
    If Len(variantKey) = 0 Then
        ' HttpGetJson surfaced an error already; abort silently without
        ' touching state.
        Application.EnableEvents = True
        Exit Sub
    End If

    modRefresh.WriteNamedValue RNG_STRUCTURAL_VARIANT_KEY, variantKey
    Application.EnableEvents = True

    ' 5. Render with the (assetClass, variantKey) pair we just established.
    modRefresh.RefreshFromBackend
    Exit Sub

ResolveErr:
    Application.EnableEvents = True
    MsgBox "Could not resolve structuralVariantKey for assetClass=" & assetClass & _
           "." & vbLf & vbLf & Err.Description, vbCritical, "Variant resolution"
End Sub
