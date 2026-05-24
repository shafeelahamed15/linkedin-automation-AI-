' Hidden launcher for scheduled tasks. Eliminates the brief console flash that
' -WindowStyle Hidden alone leaves behind on Windows.
'
' Why this exists: powershell.exe with -WindowStyle Hidden still allocates a
' console window for ~100-300ms before hiding it — visible on every fire.
' wscript.exe (this script's host) is a Windows GUI subsystem binary that never
' creates a console. It can launch PowerShell with WindowStyle=0 (truly hidden)
' from the start.
'
' Usage:  wscript.exe "D:\linkedin leads\scripts\run_job_hidden.vbs" <job-name>
' Forwards <job-name> through to run_job.ps1.

If WScript.Arguments.Count < 1 Then
    WScript.Quit 1
End If

Dim job, cmd, shell
job = WScript.Arguments(0)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""D:\linkedin leads\scripts\run_job.ps1"" " & job

Set shell = CreateObject("WScript.Shell")
' Run(command, windowStyle=0 [hidden], waitOnReturn=true so we forward exit code)
WScript.Quit shell.Run(cmd, 0, True)
