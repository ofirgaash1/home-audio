param(
  [string]$BaseUrl = 'http://localhost:43117',
  [ValidateSet('status', 'watch', 'events', 'start', 'stop', 'restart', 'refresh', 'rejoin', 'leave', 'refresh-all', 'rejoin-all', 'leave-all', 'smoke')]
  [string]$Action = 'status',
  [string]$ListenerId = '*',
  [int]$IntervalMs = 1000,
  [int]$Tail = 40
)

$ErrorActionPreference = 'Stop'

function Invoke-JsonGet {
  param([string]$Url)
  Invoke-RestMethod -Uri $Url -Method Get
}

function Invoke-JsonPost {
  param(
    [string]$Url,
    [hashtable]$Payload
  )

  $json = $Payload | ConvertTo-Json -Depth 12
  Invoke-RestMethod -Uri $Url -Method Post -ContentType 'application/json' -Body $json
}

function Get-DebugState {
  Invoke-JsonGet "$BaseUrl/api/debug/state"
}

function Get-Status {
  Invoke-JsonGet "$BaseUrl/api/status"
}

function Get-ActiveHostSession {
  $state = Get-DebugState
  $hostClient = @($state.clients | Where-Object { $_.role -eq 'broadcaster' }) | Select-Object -First 1

  if (-not $hostClient) {
    throw 'No broadcaster is currently active.'
  }

  if (-not $state.broadcasterSessionId) {
    throw 'Broadcaster sessionId is missing in debug state.'
  }

  [pscustomobject]@{
    state = $state
    clientId = $hostClient.clientId
    sessionId = $state.broadcasterSessionId
  }
}

function Invoke-ListenerCommand {
  param(
    [string]$Command,
    [string]$TargetClientId
  )

  $hostSession = Get-ActiveHostSession
  $response = Invoke-JsonPost "$BaseUrl/api/listener-command" @{
    clientId = $hostSession.clientId
    sessionId = $hostSession.sessionId
    targetClientId = $TargetClientId
    command = $Command
  }

  Write-Host ("Listener command sent: {0} target={1} delivered={2}" -f $Command, $TargetClientId, $response.deliveredCount)
}

function Invoke-ServerControl {
  param([string]$ActionName)

  $response = Invoke-JsonPost "$BaseUrl/api/server-control" @{ action = $ActionName }
  Write-Host ("Server action={0} running={1}" -f $ActionName, $response.serverRunning)
  return $response
}

function Format-ClientRow {
  param($Client)

  [pscustomobject]@{
    clientId = $Client.clientId
    role = $Client.role
    connected = $Client.connected
    disconnectedAt = $Client.disconnectedAt
    status = $Client.diagnosticsSummary.status
    fallback = $Client.diagnosticsSummary.directFallback
    inLevel = $Client.diagnosticsSummary.incomingMeterLevel
    outLevel = $Client.diagnosticsSummary.playbackMeterLevel
    sourceLevel = $Client.diagnosticsSummary.sourceMeterLevel
    monitorLevel = $Client.diagnosticsSummary.monitorMeterLevel
    rxBytes = $Client.diagnosticsSummary.'receiver.deltaBytes'
    rxPackets = $Client.diagnosticsSummary.'receiver.deltaPackets'
    pc = $Client.diagnosticsSummary.'pc.connectionState'
    ice = $Client.diagnosticsSummary.'pc.iceConnectionState'
  }
}

function Show-StateSummary {
  param($State)

  Write-Host ("Time: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
  Write-Host ("Server running: {0}  host={1}:{2}" -f $State.server.running, $State.server.host, $State.server.port)
  Write-Host ("Broadcaster: {0}  Session: {1}" -f $State.broadcasterId, $State.broadcasterSessionId)
  Write-Host ("Participants: {0}  Active clients: {1}" -f $State.participants.Count, $State.counters.activeClientConnections)
  Write-Host ("Debug log: {0}" -f $State.server.debugLogPath)
  Write-Host ''

  $rows = @($State.clients | ForEach-Object { Format-ClientRow $_ })
  if ($rows.Count) {
    $rows |
      Sort-Object @{ Expression = 'connected'; Descending = $true }, role, clientId |
      Format-Table -AutoSize
  } else {
    Write-Host 'No clients in debug state.'
  }
}

function Watch-State {
  while ($true) {
    Clear-Host
    try {
      $state = Get-DebugState
      Show-StateSummary -State $state
    } catch {
      Write-Host ("Time: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
      Write-Host ("Failed to fetch state from {0}/api/debug/state" -f $BaseUrl)
      Write-Host $_
    }

    Start-Sleep -Milliseconds $IntervalMs
  }
}

function Format-DebugEventLine {
  param($Event)

  $at = if ($Event.at) { $Event.at } else { '-' }
  $type = if ($Event.type) { $Event.type } else { '-' }
  $client = if ($Event.clientId) { $Event.clientId } else { '' }

  $detail = ''
  if ($Event.type -eq 'signal') {
    $detail = ("{0}->{1}" -f $Event.from, $Event.to)
  } elseif ($Event.type -eq 'server-control') {
    $detail = ("action={0}" -f $Event.action)
  } elseif ($Event.reason) {
    $detail = ("reason={0}" -f $Event.reason)
  } elseif ($Event.disconnectGraceMs) {
    $detail = ("graceMs={0}" -f $Event.disconnectGraceMs)
  }

  "[{0}] {1,-16} {2,-24} {3}" -f $at, $type, $client, $detail
}

function Watch-Events {
  $state = Get-DebugState
  $debugLogPath = $state.server.debugLogPath

  if (-not $debugLogPath) {
    throw 'Debug log path not provided by server.'
  }

  if (-not (Test-Path $debugLogPath)) {
    throw ("Debug log not found at {0}" -f $debugLogPath)
  }

  Write-Host ("Tailing: {0}" -f $debugLogPath)
  Write-Host ("Filter: register/unregister/sse-*/server-control/listener-command")
  Write-Host ''

  Get-Content -Path $debugLogPath -Tail $Tail -Wait | ForEach-Object {
    $line = $_
    $event = $null

    try {
      $event = $line | ConvertFrom-Json
    } catch {
      Write-Host $line
      return
    }

    $interesting = @(
      'register',
      'unregister',
      'sse-connected',
      'sse-disconnected',
      'sse-timeout',
      'server-control',
      'listener-command',
      'server-start'
    )

    if ($interesting -contains $event.type) {
      Write-Host (Format-DebugEventLine -Event $event)
    }
  }
}

switch ($Action) {
  'status' {
    $status = Get-Status
    $state = Get-DebugState
    Write-Host ("Status: running={0} hostPage={1}" -f $status.serverRunning, $status.hostPage)
    Write-Host ("Listen URLs: {0}" -f (($status.listenPages -join ', ')))
    Write-Host ''
    Show-StateSummary -State $state
  }
  'watch' {
    Watch-State
  }
  'events' {
    Watch-Events
  }
  'start' {
    Invoke-ServerControl -ActionName 'start' | Out-Null
  }
  'stop' {
    Invoke-ServerControl -ActionName 'stop' | Out-Null
  }
  'restart' {
    Invoke-ServerControl -ActionName 'stop' | Out-Null
    Start-Sleep -Milliseconds 600
    Invoke-ServerControl -ActionName 'start' | Out-Null
  }
  'refresh' {
    Invoke-ListenerCommand -Command 'refresh' -TargetClientId $ListenerId
  }
  'rejoin' {
    Invoke-ListenerCommand -Command 'join' -TargetClientId $ListenerId
  }
  'leave' {
    Invoke-ListenerCommand -Command 'leave' -TargetClientId $ListenerId
  }
  'refresh-all' {
    Invoke-ListenerCommand -Command 'refresh' -TargetClientId '*'
  }
  'rejoin-all' {
    Invoke-ListenerCommand -Command 'join' -TargetClientId '*'
  }
  'leave-all' {
    Invoke-ListenerCommand -Command 'leave' -TargetClientId '*'
  }
  'smoke' {
    $scriptPath = Join-Path $PSScriptRoot 'smoke-check.ps1'
    & $scriptPath -Url "$BaseUrl/api/debug/state"
  }
}
