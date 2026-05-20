Attribute VB_Name = "modBindings"
'------------------------------------------------------------------------------
' modBindings
' Writes payload values into Excel cells. NO underwriting math, NO derivation,
' NO schema decisions. Every layout question — which sheet, which columns,
' which header row, which named ranges — is answered by the backend payload.
'
' If you find yourself adding a hardcoded sheet name, named range, or column
' index here, STOP. That belongs in apps/api/src/services/render-schema.ts.
'------------------------------------------------------------------------------
Option Explicit

' --- cellBindings ------------------------------------------------------------
Public Sub WriteCellBindings(ByVal bindings As Object)
    If bindings Is Nothing Then Exit Sub
    Dim k As Variant
    For Each k In bindings.Keys
        WriteOneBinding CStr(k), bindings(k)
    Next k
End Sub

Private Sub WriteOneBinding(ByVal address As String, ByVal value As Variant)
    Dim bangPos As Long: bangPos = InStr(address, "!")
    If bangPos = 0 Then
        Err.Raise vbObjectError + 5101, "modBindings", _
            "Unqualified binding (no Sheet!Range): " & address
    End If
    Dim sheetName As String, rangeRef As String
    sheetName = Left$(address, bangPos - 1)
    rangeRef = Mid$(address, bangPos + 1)

    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(sheetName)
    On Error GoTo 0
    If ws Is Nothing Then
        Err.Raise vbObjectError + 5102, "modBindings", _
            "Binding references missing sheet: " & sheetName & " (address=" & address & ")"
    End If

    Dim r As Range
    On Error Resume Next
    Set r = ws.Range(rangeRef)
    On Error GoTo 0
    If r Is Nothing Then
        Err.Raise vbObjectError + 5103, "modBindings", _
            "Binding references missing range: " & address
    End If

    If IsNull(value) Then
        r.value = ""
    Else
        r.value = value
    End If
End Sub

' --- Tab visibility ----------------------------------------------------------
' visibleTabs is the backend-declared visible-set. Sheets not in the set are
' hidden. The "_Config" sheet is workbook-local infrastructure — kept very-
' hidden by ThisWorkbook on open and untouched here.
Public Sub ApplyVisibleTabs(ByVal visibleTabs As Object)
    If visibleTabs Is Nothing Then Exit Sub
    Dim shown As Object: Set shown = CreateObject("Scripting.Dictionary")
    shown.CompareMode = vbTextCompare
    Dim t As Variant
    For Each t In visibleTabs
        shown(CStr(t)) = True
    Next t

    Dim ws As Worksheet
    For Each ws In ThisWorkbook.Worksheets
        If LCase$(ws.Name) = LCase$(SHEET_CONFIG) Then
            ws.Visible = xlSheetVeryHidden    ' workbook-local infra; never user-visible
        ElseIf shown.Exists(ws.Name) Then
            ws.Visible = xlSheetVisible
        Else
            ws.Visible = xlSheetHidden
        End If
    Next ws
End Sub

' --- Tables (layout supplied by backend) -------------------------------------
' tables is an array of { layout, rows }. layout = { name, sheetName, headerRow,
' dataStartRow, columns: [{ header, sourceField }, ...] }. The backend OWNS
' which columns appear, in which order, and on which sheet. VBA only writes.
Public Sub WriteTables(ByVal tables As Object)
    If tables Is Nothing Then Exit Sub
    Dim t As Variant
    For Each t In tables
        WriteOneTable t
    Next t
End Sub

Private Sub WriteOneTable(ByVal table As Object)
    Dim layout As Object: Set layout = table("layout")
    Dim rows As Object: Set rows = table("rows")
    If layout Is Nothing Then Exit Sub

    Dim sheetName As String: sheetName = CStr(layout("sheetName"))
    Dim headerRow As Long:    headerRow = CLng(layout("headerRow"))
    Dim dataRow As Long:      dataRow = CLng(layout("dataStartRow"))
    Dim columns As Object: Set columns = layout("columns")
    If columns Is Nothing Then Exit Sub

    Dim ws As Worksheet
    On Error Resume Next
    Set ws = ThisWorkbook.Worksheets(sheetName)
    On Error GoTo 0
    If ws Is Nothing Then
        Err.Raise vbObjectError + 5104, "modBindings", _
            "Table layout references missing sheet: " & sheetName & " (table=" & layout("name") & ")"
    End If

    ' Headers — backend declares them. Excel does not invent column titles.
    Dim col As Long: col = 1
    Dim c As Variant
    For Each c In columns
        ws.Cells(headerRow, col).value = CStr(c("header"))
        col = col + 1
    Next c

    ' Clear prior data rows below the header.
    Dim lastRow As Long
    lastRow = ws.Cells(ws.Rows.Count, 1).End(xlUp).Row
    If lastRow >= dataRow Then ws.Range(ws.Rows(dataRow), ws.Rows(lastRow)).ClearContents

    ' Data — read fields named by layout.columns[i].sourceField.
    If rows Is Nothing Then Exit Sub
    Dim r As Long: r = dataRow
    Dim row As Variant
    For Each row In rows
        col = 1
        For Each c In columns
            Dim v As Variant: v = SafeGet(row, CStr(c("sourceField")))
            If IsNull(v) Then
                ws.Cells(r, col).value = ""
            Else
                ws.Cells(r, col).value = v
            End If
            col = col + 1
        Next c
        r = r + 1
    Next row
End Sub

Private Function SafeGet(ByVal d As Object, ByVal key As String) As Variant
    On Error Resume Next
    SafeGet = d(key)
    On Error GoTo 0
End Function
