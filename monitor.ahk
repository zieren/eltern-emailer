#Requires AutoHotkey v2.0

; Read config or set defaults
USERPROFILE := EnvGet("USERPROFILE") ; e.g. c:\users\johndoe
global INI_FILE, APP_NAME, SERVER_URL, MAX_STALE_MINUTES, GUI_CONFIG
INI_FILE := USERPROFILE "\eltern-emailer-monitor.ini"
APP_NAME := "Eltern-Emailer Monitor 0.3"
SERVER_URL := IniRead(INI_FILE, "server", "url", "http://localhost:1984")
MAX_STALE_MINUTES := IniRead(INI_FILE, "options", "max_stale_minutes", 60)

; main()
BuildTrayIcon()
Loop {
  DoTheThing(false)
  Sleep 1000 * 60 * 5 ; check every 5 minutes
}

; --------------- Helpers ---------------

PauseMonitoring(*) {
  ; We have to change the icon before we pause, hence the inverted logic.
  TraySetIcon(A_IsPaused ? "icon.png" : "icon-paused.png", 0, 1)
  Pause ; defaults to "Toggle"
}

ExitMonitoring(*) {
  ExitApp
}

GetSecondsElapsed(timestampMillis) {
  now := EpochSeconds()
  return Round((now * 1000 - timestampMillis) / 1000)
}

EpochSeconds() {
  return DateDiff(A_NowUTC, 19700101000000, "Seconds")
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
  A_TrayMenu.Delete()
  A_TrayMenu.Add("Check &Now", DoTheThingForceMessage)
  A_TrayMenu.Add("&Pause", PauseMonitoring)
  A_TrayMenu.Add("&Configuration", ShowConfigForm)
  A_TrayMenu.Add("&Exit", ExitMonitoring)
  A_IconTip := APP_NAME
  TraySetIcon("icon.png", 0, 1) ; 1=freeze icon (don't use default icons)
  A_TrayMenu.Default := "Check &Now"
}

ShowConfigForm(*) {
  global GUI_CONFIG := Gui("", APP_NAME)
  GUI_CONFIG.add("Text", "w200 x10 y13", "Server address and port:")
  GUI_CONFIG.add("Edit", "w200 x152 y10 vServerUrl", SERVER_URL)
  GUI_CONFIG.add("Text", "w200 x10 y43", "Maximum staleness (minutes):")
  GUI_CONFIG.add("Edit", "w40 x152 y40 Number vMaxStaleMinutes", MAX_STALE_MINUTES)
  b := GUI_CONFIG.add("Button", "Default w80 x10 y70", "&OK")
  b.OnEvent("Click", HandleConfigOK)
  b := GUI_CONFIG.add("Button", "w80 x250 y70", "&Cancel")
  b.OnEvent("Click", HandleConfigCancel)
  GUI_CONFIG.OnEvent("Close", HandleConfigCancel)
  GUI_CONFIG.OnEvent("Escape", HandleConfigCancel)
  GUI_CONFIG.Show()
}

HandleConfigOK(*) {
  newValues := GUI_CONFIG.Submit(false) ; don't hide the window
  serverUrl := StrLower(Trim(newValues.ServerUrl))
  maxStaleMinutes := Trim(newValues.MaxStaleMinutes)
  if (!RegExMatch(serverUrl, "^https?://")) {
    MsgBox("Invalid server address: " serverUrl)
    return
  }
  if (!RegExMatch(maxStaleMinutes, "^\d+$")) {
    MsgBox("Invalid value: " maxStaleMinutes)
    return
  }
  GUI_CONFIG.Destroy()
  global SERVER_URL := serverUrl
  global MAX_STALE_MINUTES := maxStaleMinutes
  IniWrite SERVER_URL, INI_FILE, "server", "url"
  IniWrite MAX_STALE_MINUTES, INI_FILE, "options", "max_stale_minutes"
}

HandleConfigCancel(*) {
  GUI_CONFIG.Destroy()
}

; --------------- Check ---------------

DoTheThingForceMessage(*) { 
  DoTheThing(true) 
}

DoTheThing(forceMessage) {
  exception := ""
  response := ""
  ; When waking up from OS sleep, requests may fail. We try 5x over 40s in the hope that
  ; that's enough time to wake up and be online again.
  Loop 5 {
    if (A_Index > 1) {
      Sleep 10 * 1000 ; 10 seconds
    }
    try {
      request := ComObject("WinHTTP.WinHTTPRequest.5.1")
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
      exception := "" ; previous failures are to be forgotten
      break
    } catch as e {
      ; Last exception wins, because earlier ones are more likely to be transient.
      exception := e
    }
  }
  if (exception) {
    MsgBox("Status check failed:`n`n" ExceptionToString(exception), APP_NAME " - ERROR", 0x10)
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
    MsgBox(message, APP_NAME " - " level, icon)
  }
}
