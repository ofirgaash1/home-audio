param(
  [string]$Url = 'http://localhost:43117/api/debug/state'
)

$ErrorActionPreference = 'Stop'

$state = Invoke-RestMethod $Url
$hostClient = @($state.clients | Where-Object { $_.role -eq 'broadcaster' -and $_.connected }) | Select-Object -First 1
$listenerClients = @($state.clients | Where-Object { $_.role -eq 'listener' -and $_.connected })

if (-not $hostClient) {
  Write-Error 'No connected host found in debug state.'
}

if (-not $listenerClients.Count) {
  Write-Error 'No connected listeners found in debug state.'
}

$rows = foreach ($listener in $listenerClients) {
  [pscustomobject]@{
    listener = $listener.label
    status = $listener.diagnosticsSummary.status
    directMode = $listener.diagnosticsSummary.processedPlaybackPath
    rxBytes = $listener.diagnosticsSummary.'receiver.deltaBytes'
    rxPackets = $listener.diagnosticsSummary.'receiver.deltaPackets'
    pcState = $listener.diagnosticsSummary.'pc.connectionState'
    playbackLevel = $listener.diagnosticsSummary.playbackMeterLevel
    failure = $listener.diagnosticsSummary.'lastPlaybackFailure.message'
  }
}

Write-Host ("Host: {0}" -f $hostClient.label)
Write-Host ("Status: {0}" -f $hostClient.diagnosticsSummary.status)
Write-Host ''
$rows | Format-Table -AutoSize

$unstable = @($listenerClients | Where-Object {
  $_.diagnosticsSummary.'pc.connectionState' -ne 'connected' -or
  [int]($_.diagnosticsSummary.'receiver.deltaBytes' -as [int]) -le 0
})

if ($unstable.Count) {
  Write-Error 'One or more listeners are not in a stable connected/audio-receiving state.'
}
