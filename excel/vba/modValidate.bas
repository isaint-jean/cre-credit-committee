Attribute VB_Name = "modValidate"
'------------------------------------------------------------------------------
' modValidate
' Strict enforcement client for the backend-declared schema. This module
' contains NO schema rules. Every policy decision (which prefixes are
' "managed", which sheets are excluded, which addresses are expected) is
' supplied by the backend payload.
'
' If you find yourself adding a string constant to this file that names a
' specific Excel range, prefix, or sheet — STOP. That decision belongs in
' apps/api/src/services/render-schema.ts.
'------------------------------------------------------------------------------
Option Explicit

Public Const ERR_VALIDATE As Long = vbObjectError + 5100

' --- Forward check: every schema address resolves to a Range ----------------
Public Sub AssertSchemaAddressesResolve(ByVal schemaAddresses As Object)
    If schemaAddresses Is Nothing Then
        Err.Raise ERR_VALIDATE, "modValidate", _
            "Payload missing schemaAddresses — backend contract violation."
    End If

    Dim missing As String, addr As Variant, count As Long
    For Each addr In schemaAddresses
        count = count + 1
        If Not RangeResolves(CStr(addr)) Then
            missing = missing & vbLf & " - " & CStr(addr)
        End If
    Next addr

    If count = 0 Then
        Err.Raise ERR_VALIDATE, "modValidate", _
            "schemaAddresses is empty — backend contract violation."
    End If
    If Len(missing) > 0 Then
        Err.Raise ERR_VALIDATE, "modValidate", _
            "Workbook missing required cells declared by schema:" & missing
    End If
End Sub

' --- Closed-system check: payload bindings == schemaAddresses ----------------
Public Sub AssertBindingsMatchSchemaAddresses( _
        ByVal cellBindings As Object, ByVal schemaAddresses As Object)
    Dim sched As Object: Set sched = CreateObject("Scripting.Dictionary")
    sched.CompareMode = vbBinaryCompare
    Dim a As Variant
    For Each a In schemaAddresses
        sched(CStr(a)) = True
    Next a

    Dim binds As Object: Set binds = CreateObject("Scripting.Dictionary")
    binds.CompareMode = vbBinaryCompare
    Dim k As Variant
    For Each k In cellBindings.Keys
        binds(CStr(k)) = True
    Next k

    Dim msgMissing As String, msgExtra As String
    For Each k In sched.Keys
        If Not binds.Exists(k) Then msgMissing = msgMissing & vbLf & " - " & CStr(k)
    Next k
    For Each k In binds.Keys
        If Not sched.Exists(k) Then msgExtra = msgExtra & vbLf & " - " & CStr(k)
    Next k

    If Len(msgMissing) > 0 Or Len(msgExtra) > 0 Then
        Err.Raise ERR_VALIDATE, "modValidate", _
            "cellBindings <> schemaAddresses (backend contract violation)." & vbLf & _
            "Missing bindings:" & IIf(Len(msgMissing) > 0, msgMissing, " (none)") & vbLf & _
            "Unexpected bindings:" & IIf(Len(msgExtra) > 0, msgExtra, " (none)")
    End If
End Sub

' --- Reverse check: workbook has no managed-namespace extras -----------------
' policy is the backend's ManagedNamespacePolicy: { prefixes, literals, excludedSheets }.
Public Sub AssertNoExtraManagedNames( _
        ByVal expectedAddresses As Object, ByVal policy As Object)
    If policy Is Nothing Then
        Err.Raise ERR_VALIDATE, "modValidate", _
            "Payload missing managedNamespace — backend contract violation."
    End If

    Dim expected As Object: Set expected = CreateObject("Scripting.Dictionary")
    expected.CompareMode = vbTextCompare
    Dim a As Variant
    For Each a In expectedAddresses
        expected(CStr(a)) = True
    Next a

    Dim excluded As Object: Set excluded = CreateObject("Scripting.Dictionary")
    excluded.CompareMode = vbTextCompare
    Dim s As Variant
    For Each s In policy("excludedSheets")
        excluded(CStr(s)) = True
    Next s

    Dim prefixes As Object: Set prefixes = policy("prefixes")
    Dim literals As Object: Set literals = policy("literals")

    Dim extras As String
    Dim ws As Worksheet, n As Object
    For Each ws In ThisWorkbook.Worksheets
        If Not excluded.Exists(ws.Name) Then
            For Each n In ws.Names
                Dim shortName As String: shortName = StripSheetPrefix(n.Name)
                If IsInManagedNamespace(shortName, prefixes, literals) Then
                    Dim address As String: address = ws.Name & "!" & shortName
                    If Not expected.Exists(address) Then
                        extras = extras & vbLf & " - " & address
                    End If
                End If
            Next n
        End If
    Next ws
    For Each n In ThisWorkbook.Names
        If IsInManagedNamespace(n.Name, prefixes, literals) Then
            extras = extras & vbLf & " - (workbook-scoped) " & n.Name
        End If
    Next n

    If Len(extras) > 0 Then
        Err.Raise ERR_VALIDATE, "modValidate", _
            "Workbook contains managed-namespace named ranges that are NOT in the schema:" & extras
    End If
End Sub

' --- Helpers (no schema decisions, only mechanical lookups) ------------------
Private Function RangeResolves(ByVal address As String) As Boolean
    Dim bangPos As Long: bangPos = InStr(address, "!")
    If bangPos = 0 Then RangeResolves = False: Exit Function
    Dim sheetName As String, rangeRef As String
    sheetName = Left$(address, bangPos - 1)
    rangeRef = Mid$(address, bangPos + 1)
    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(sheetName)
    On Error GoTo 0
    If ws Is Nothing Then RangeResolves = False: Exit Function
    Dim r As Range
    On Error Resume Next
    Set r = ws.Range(rangeRef)
    On Error GoTo 0
    RangeResolves = Not (r Is Nothing)
End Function

Private Function IsInManagedNamespace( _
        ByVal nameOrAddress As String, _
        ByVal prefixes As Object, _
        ByVal literals As Object) As Boolean
    Dim shortName As String: shortName = StripSheetPrefix(nameOrAddress)
    Dim p As Variant
    For Each p In literals
        If StrComp(shortName, CStr(p), vbTextCompare) = 0 Then
            IsInManagedNamespace = True: Exit Function
        End If
    Next p
    For Each p In prefixes
        Dim pref As String: pref = CStr(p)
        If Len(shortName) >= Len(pref) Then
            If LCase$(Left$(shortName, Len(pref))) = LCase$(pref) Then
                IsInManagedNamespace = True: Exit Function
            End If
        End If
    Next p
    IsInManagedNamespace = False
End Function

Private Function StripSheetPrefix(ByVal n As String) As String
    Dim bangPos As Long: bangPos = InStr(n, "!")
    If bangPos = 0 Then
        StripSheetPrefix = n
    Else
        StripSheetPrefix = Mid$(n, bangPos + 1)
    End If
End Function
