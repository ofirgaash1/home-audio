param(
  [string]$Url = 'http://localhost:43117/api/debug/state',
  [int]$IntervalMs = 1000,
  [switch]$ShowDiagnostics
)

$ErrorActionPreference = 'Stop'

function Get-ClientRow {
  param($Client)

  [pscustomobject]@{
    clientId = $Client.clientId
    role = $Client.role
    connected = $Client.connected
    diagnosticsAt = $Client.diagnosticsAt
    status = $Client.diagnosticsSummary.status
    fallback = $Client.diagnosticsSummary.directFallback
    playbackPath = $Client.diagnosticsSummary.processedPlaybackPath
    processorState = $Client.diagnosticsSummary.'processor.context.state'
    processorLevel = $Client.diagnosticsSummary.'processor.level'
    inLevel = $Client.diagnosticsSummary.incomingMeterLevel
    outLevel = $Client.diagnosticsSummary.playbackMeterLevel
    sourceLevel = $Client.diagnosticsSummary.sourceMeterLevel
    monitorLevel = $Client.diagnosticsSummary.monitorMeterLevel
    rxBytes = $Client.diagnosticsSummary.'receiver.deltaBytes'
    rxPackets = $Client.diagnosticsSummary.'receiver.deltaPackets'
    pcState = $Client.diagnosticsSummary.'pc.connectionState'
    failureStage = $Client.diagnosticsSummary.'lastPlaybackFailure.stage'
    failureName = $Client.diagnosticsSummary.'lastPlaybackFailure.name'
    failureMessage = $Client.diagnosticsSummary.'lastPlaybackFailure.message'
  }
}

while ($true) {
  try {
    $state = Invoke-RestMethod $Url
    Clear-Host

    Write-Host ("Time: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Write-Host ("Server: {0}:{1}" -f $state.server.host, $state.server.port)
    Write-Host ("Broadcaster: {0}" -f $state.broadcasterId)
    Write-Host ("Participants: {0}  Active SSE Clients: {1}" -f $state.participants.Count, $state.counters.activeClientConnections)
    Write-Host ''

    $rows = @($state.clients | ForEach-Object { Get-ClientRow $_ })
    if ($rows.Count) {
      $rows |
        Sort-Object @{ Expression = 'connected'; Descending = $true }, role, clientId |
        Format-Table -AutoSize
    } else {
      Write-Host 'No clients in debug state.'
    }

    if ($ShowDiagnostics) {
      $connectedClients = @($state.clients | Where-Object { $_.connected })
      foreach ($client in $connectedClients) {
        Write-Host ''
        Write-Host ("[{0}] {1}" -f $client.clientId, $client.role)
        Write-Host $client.diagnostics
      }
    }
  } catch {
    Clear-Host
    Write-Host ("Time: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    Write-Host ("Failed to fetch debug state from {0}" -f $Url)
    Write-Host $_
  }

  Start-Sleep -Milliseconds $IntervalMs
}
