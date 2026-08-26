' Abrir Video to Contact Sheets (Windows) — doble clic para abrir la app
' SIN que quede una ventana de consola negra.
Option Explicit
Dim sh, fso, here, bat, hasPy

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

' Verifica que exista Python (py o python) sin mostrar consola.
hasPy = (sh.Run("cmd /c where py >nul 2>nul || where python >nul 2>nul", 0, True) = 0)
If Not hasPy Then
    MsgBox "Falta Python 3." & vbCrLf & vbCrLf & _
           "Instálalo desde https://www.python.org/downloads/ y marca la casilla " & _
           "'Add Python to PATH' durante la instalación. Luego vuelve a abrir.", _
           vbCritical, "Video to Contact Sheets"
    WScript.Quit 1
End If

' Aviso solo la primera vez (cuando aún no existe el entorno).
If Not fso.FolderExists(here & "\.venv") Then
    sh.Popup "Preparando por primera vez. Puede tardar 1–2 minutos; espera a que " & _
             "aparezca la ventana.", 6, "Video to Contact Sheets", 64
End If

' run.bat prepara el entorno (si hace falta) y abre la app con pythonw.exe
' (sin consola). Se ejecuta con ventana OCULTA (el 0).
bat = here & "\run.bat"
sh.Run "cmd /c """ & bat & """", 0, False
