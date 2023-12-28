; Read config or set defaults
EnvGet, USERPROFILE, USERPROFILE ; e.g. c:\users\johndoe
global INI_FILE, APP_NAME, SERVER_URL, MAX_STALE_MINUTES
INI_FILE := USERPROFILE "\eltern-emailer-monitor.ini"
APP_NAME := "Eltern-Emailer Monitor 0.2"
IniRead, SERVER_URL, %INI_FILE%, server, url, http://localhost:1984
IniRead, MAX_STALE_MINUTES, %INI_FILE%, options, max_stale_minutes, 60

; main()
BuildTrayIcon()
Loop {
  DoTheThing(false)
  Sleep % 1000 * 60 * 5 ; check every 5 minutes
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
  return msg
}

; --------------- GUI ---------------

BuildTrayIcon() {
  Menu, Tray, NoStandard
  Menu, Tray, Add, Check &Now, DoTheThing
  Menu, Tray, Add, &Pause, PauseMonitoring
  Menu, Tray, Add, &Configuration, ShowConfigForm
  Menu, Tray, Add, &Exit, ExitMonitoring
  Menu, Tray, Tip, % APP_NAME
  Menu, Tray, Icon, icon.png,, 1 ; 1=freeze icon (don't use default icons)
}

ShowConfigForm() {
  Gui, ConfigForm:New,, % APP_NAME
  Gui, Add, Text, w200 x10 y13, Server address and port:
  Gui, Add, Edit, w200 x152 y10 vSERVER_URL, % SERVER_URL
  Gui, Add, Text, w200 x10 y43, Maximum staleness (minutes):
  Gui, Add, Edit, w40 x152 y40 vMAX_STALE_MINUTES, % MAX_STALE_MINUTES
  Gui, Add, Button, Default w80 x10 y70 gConfigFormOK, &OK
  Gui, Add, Button, w80 x250 y70 gConfigFormCancel, &Cancel
  Gui, Show
}

HandleConfigOK() {
  Gui, Submit, NoHide
  StringLower, SERVER_URL, % Trim(SERVER_URL)
  MAX_STALE_MINUTES := Trim(MAX_STALE_MINUTES)
  if (!RegExMatch(SERVER_URL, "^https?://")) {
    MsgBox, % "Invalid server address: " SERVER_URL
    return
  }
  if (!RegExMatch(MAX_STALE_MINUTES, "^\d+$")) {
    MsgBox, % "Invalid value: " MAX_STALE_MINUTES
    return
  }
  Gui, Destroy
  IniWrite, %SERVER_URL%, %INI_FILE%, server, url
  IniWrite, %MAX_STALE_MINUTES%, %INI_FILE%, options, max_stale_minutes
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
  exception := ""
  response := ""
  ; When waking up from OS sleep, requests may fail. We retry 3x over 10s in the hope that
  ; that's enough time to wake up and be online again.
  Loop, 3 {
    if (A_Index > 1) {
      Sleep, 5 * 1000
    }
    try {
      request := ComObjCreate("WinHTTP.WinHTTPRequest.5.1")
      request.Open("GET", SERVER_URL, false)

      ; We really really want no caching.
      request.SetRequestHeader("Cache-Control", "no-cache, no-store, must-revalidate")
      request.SetRequestHeader("Pragma", "no-cache")
      request.SetRequestHeader("Expires", "0")
      request.Send()
      if (request.status != 200) {
        throw Exception("HTTP " request.status ": " request.statusText)
      }
      response := Trim(request.ResponseText, " `n`t")
      if (!RegExMatch(response, "^[0-9]+$")) {
        throw Exception("Invalid server response:`n" response)
      }
      break
    } catch e {
      ; Last exception wins, because earlier ones are more likely to be transient.
      exception := e
    }
  }
  if (exception) {
    MsgBox, 0x10, %APP_NAME% - ERROR, % "Status check failed:`n`n" ExceptionToString(exception)
    return
  }

  seconds := GetSecondsElapsed(response)
  isStale := seconds > 60 * MAX_STALE_MINUTES
  if (forceMessage || isStale) {
    hhmmss := FormatSeconds(seconds)
    maxHhmmss := FormatSeconds(MAX_STALE_MINUTES * 60)
    message := "Last successful check was " hhmmss " ago`nMaximum staleness is " maxHhmmss
    level := isStale ? "WARNING" : "INFO"
    icon := isStale ? 0x30 : 0x40
    MsgBox, % icon, %APP_NAME% - %level%, % message
  }
}
