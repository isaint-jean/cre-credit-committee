Attribute VB_Name = "modMigrations"
'------------------------------------------------------------------------------
' modMigrations
' Surfaces backend-supplied migration steps to the user. NEVER applies a
' structural change silently — even autoApplicable migrations are presented
' first and only proceed on explicit user confirmation.
'
' This module contains NO schema rules. It only renders what the backend
' ships in `migrationsFromClient`.
'------------------------------------------------------------------------------
Option Explicit

Public Const ERR_VERSION_MISMATCH As Long = vbObjectError + 5200

' Returns True if the caller should proceed with rendering, False if the
' workbook is incompatible and refresh should abort.
Public Function HandleMigrationDrift(ByVal manifest As Object) As Boolean
    If manifest Is Nothing Then
        HandleMigrationDrift = True
        Exit Function
    End If

    Dim fromV As Long: fromV = CLng(manifest("fromVersion"))
    Dim toV As Long:   toV = CLng(manifest("toVersion"))
    Dim auto As Boolean: auto = CBool(manifest("autoApplicable"))
    Dim steps As Object: Set steps = manifest("steps")

    Dim msg As String
    msg = "Render contract has changed since this workbook was built." & vbLf & _
          "Workbook version: v" & fromV & vbLf & _
          "Backend version:  v" & toV & vbLf & vbLf & _
          "Migration steps:" & vbLf & FormatSteps(steps) & vbLf

    If auto Then
        msg = msg & "These changes are auto-applicable, but THIS WORKBOOK does not " & _
              "auto-apply structural migrations. Continue rendering anyway? " & vbLf & _
              "(Cells whose addresses changed will fail validation.)"
    Else
        msg = msg & "These changes are NOT auto-applicable. The workbook must be " & _
              "rebuilt against the new contract version (see excel/README.md). " & vbLf & _
              "Continue rendering anyway? (Validation will likely fail.)"
    End If

    Dim resp As VbMsgBoxResult
    resp = MsgBox(msg, vbExclamation + vbYesNo, "Schema migration required")
    HandleMigrationDrift = (resp = vbYes)
End Function

Private Function FormatSteps(ByVal steps As Object) As String
    If steps Is Nothing Then
        FormatSteps = "  (none)"
        Exit Function
    End If
    Dim out As String, s As Variant
    For Each s In steps
        out = out & "  v" & CLng(s("fromVersion")) & " → v" & CLng(s("toVersion")) & _
              ": " & CStr(s("description")) & vbLf
        out = out & FormatChangeSet("addresses", s("addresses"))
        out = out & FormatChangeSet("tables", s("tables"))
        out = out & FormatChangeSet("managedNamespace", s("managedNamespace"))
        out = out & FormatChangeSet("visibility", s("visibility"))
        out = out & FormatChangeSet("wire", s("wire"))
    Next s
    FormatSteps = out
End Function

Private Function FormatChangeSet(ByVal label As String, ByVal items As Object) As String
    If items Is Nothing Then Exit Function
    Dim count As Long: count = 0
    Dim it As Variant
    For Each it In items
        count = count + 1
    Next it
    If count = 0 Then Exit Function
    Dim out As String: out = "    [" & label & "]" & vbLf
    For Each it In items
        out = out & "      - " & CStr(it("kind"))
        ' Append commonly named fields if present.
        out = out & AppendIfPresent(it, "address")
        out = out & AppendIfPresent(it, "field")
        out = out & AppendIfPresent(it, "name")
        out = out & AppendIfPresent(it, "from")
        out = out & AppendIfPresent(it, "to")
        out = out & AppendIfPresent(it, "prefix")
        out = out & AppendIfPresent(it, "literal")
        out = out & AppendIfPresent(it, "sheet")
        out = out & AppendIfPresent(it, "tab")
        out = out & AppendIfPresent(it, "assetClass")
        out = out & AppendIfPresent(it, "reason")
        out = out & vbLf
    Next it
    FormatChangeSet = out
End Function

Private Function AppendIfPresent(ByVal d As Object, ByVal key As String) As String
    Dim v As Variant
    On Error Resume Next
    v = d(key)
    On Error GoTo 0
    If IsEmpty(v) Or IsNull(v) Then Exit Function
    AppendIfPresent = " " & key & "=" & CStr(v)
End Function
