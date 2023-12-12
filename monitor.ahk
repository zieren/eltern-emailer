; Read config or set defaults
EnvGet, USERPROFILE, USERPROFILE ; e.g. c:\users\johndoe
global INI_FILE, APP_NAME, SERVER_URL, EP_STALE_MINUTES, SM_STALE_MINUTES
INI_FILE := USERPROFILE "\eltern-emailer-monitor.ini"
APP_NAME := "Eltern-Emailer Monitor 0.1"
IniRead, SERVER_URL, %INI_FILE%, server, url, http://localhost:1984
IniRead, EP_STALE_MINUTES, %INI_FILE%, eltern-portal, max_stale_minutes, 60
IniRead, SM_STALE_MINUTES, %INI_FILE%, schulmanager, max_stale_minutes, 60

; main()
Menu, Tray, NoStandard
Menu, Tray, Add, Check &Now, DoTheThing
Menu, Tray, Add, &Pause, PauseMonitoring
Menu, Tray, Add, &Configure, ShowConfigForm
Menu, Tray, Add, &Exit, ExitMonitoring
Menu, Tray, Tip, % APP_NAME
Menu, Tray, Icon, icon.png,, 1 ; 1=freeze icon (don't use default icons)
Loop {
  DoTheThing(false)
  Sleep % 60 * 1000 ; check every minute
}

; --------------- Helpers ---------------

PauseMonitoring() {
  ; We have to change the icon before we pause, hence the inverted logic.
  Menu, Tray, Icon, % A_IsPaused ? "icon.png" : "icon-paused.png",, 1
  Pause ; defaults to "Toggle"
}

ExitMonitoring() {
  ExitApp
}

GetSecondsElapsed(timestampMillis) {
  now := EpochSeconds()
  return Round((now * 1000 - timestampMillis) / 1000)
}

EpochSeconds() {
  ts := A_NowUTC
  EnvSub, ts, 19700101000000, Seconds
  return ts
}

; Returns the specified seconds formatted as "hh:mm:ss".
FormatSeconds(seconds) {
  hours := Floor(seconds / (60 * 60))
  seconds -= hours * 60 * 60
  minutes := Floor(seconds / 60)
  seconds -= minutes * 60
  return Format("{:i}:{:02i}:{:02i}", hours, minutes, seconds)
}

ExceptionToString(exception) {
  msg := exception.Message
  if (exception.Extra)
    msg .= " (" exception.Extra ")"
  return exception.Line " " msg
}

; --------------- GUI ---------------

ShowConfigForm() {
  Gui, ConfigForm:New,, % APP_NAME
  Gui, Add, Text, w200 x10 y13, Server address and port:
  Gui, Add, Edit, w200 x130 y10 vSERVER_URL, % SERVER_URL
  Gui, Add, Text, x10 y45 Multi, Enter maximum staleness in minutes.`nA value of 0 (zero) disables the respective check.
  Gui, Add, Text, w200 x10 y83, Eltern-Portal:
  Gui, Add, Edit, w40 x85 y80 vEP_STALE_MINUTES, % EP_STALE_MINUTES
  Gui, Add, Text, w200 x10 y105, Schulmanager:
  Gui, Add, Edit, w40 x85 y102 vSM_STALE_MINUTES, % SM_STALE_MINUTES
  Gui, Add, Button, Default w80 x10 y140 gConfigFormOK, &OK
  Gui, Add, Button, w80 x250 y140 gConfigFormCancel, &Cancel
  Gui, Show
}

HandleConfigOK() {
  Gui, Submit, NoHide
  StringLower, SERVER_URL, % Trim(SERVER_URL)
  EP_STALE_MINUTES := Trim(EP_STALE_MINUTES)
  SM_STALE_MINUTES := Trim(SM_STALE_MINUTES)
  if (!RegExMatch(SERVER_URL, "^https?://")) {
    MsgBox, % "Invalid server address: " SERVER_URL
    return
  }
  if (!RegExMatch(EP_STALE_MINUTES, "^\d+$")) {
    MsgBox, % "Invalid value: " EP_STALE_MINUTES
    return
  }
  if (!RegExMatch(SM_STALE_MINUTES, "^\d+$")) {
    MsgBox, % "Invalid value: " SM_STALE_MINUTES
    return
  }
  Gui, Destroy
  IniWrite, %SERVER_URL%, %INI_FILE%, server, url
  IniWrite, %EP_STALE_MINUTES%, %INI_FILE%, eltern-portal, max_stale_minutes
  IniWrite, %SM_STALE_MINUTES%, %INI_FILE%, schulmanager, max_stale_minutes
  MsgBox,, Configuration Updated, % "Configuration written to: " INI_FILE
}

ConfigFormOK:
HandleConfigOK()
return

ConfigFormCancel:
ConfigFormGuiEscape:
Gui, Destroy
return

; --------------- Check ---------------

DoTheThing(forceMessage = true) {
  try {
    http := ComObjCreate("WinHTTP.WinHTTPRequest.5.1")
    http.Open("GET", SERVER_URL, false)

    ; We really really want no caching.
    http.SetRequestHeader("Cache-Control", "no-cache, no-store, must-revalidate")
    http.SetRequestHeader("Pragma", "no-cache")
    http.SetRequestHeader("Expires", "0")

    http.Send()
  } catch exception {
    MsgBox,, %APP_NAME% - ERROR, % "Server unreachable:`n`n" ExceptionToString(exception)
    return
  }

  responseLines := StrSplit(http.ResponseText, "`n")
  epSeconds := GetSecondsElapsed(responseLines[1])
  smSeconds := GetSecondsElapsed(responseLines[2])

  message := ""
  epStale := EP_STALE_MINUTES > 0 && epSeconds > 60 * EP_STALE_MINUTES
  if (epStale || forceMessage) {
    hhmmss := FormatSeconds(epSeconds)
    message := message "Eltern-Portal: Last successful login was " hhmmss " ago"
  }
  smStale := SM_STALE_MINUTES > 0 && smSeconds > 60 * SM_STALE_MINUTES
  if (smStale || forceMessage) {
    if (message) {
      message := message "`n"
    }
    hhmmss := FormatSeconds(smSeconds)
    message := message "Schulmanager: Last successful login was " hhmmss " ago"
  }
  level := (epStale || smStale) ? "WARNING" : "INFO"
  if (message) {
    MsgBox,, %APP_NAME% - %level%, % message
  }  
}
