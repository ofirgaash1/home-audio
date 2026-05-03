param(
  [string]$Url = 'http://localhost:43117/api/debug/state',
  [int]$Samples = 3,
  [int]$IntervalMs = 900
)

$ErrorActionPreference = 'Stop'

function Parse-IntOrZero {
  param($Value)

  $parsed = 0
  if ([int]::TryParse([string]$Value, [ref]$parsed)) {
    return $parsed
  }
  return 0
}

$sampleCount = [Math]::Max(1, $Samples)
$state = $null
$snapshots = @()

for ($index = 0; $index -lt $sampleCount; $index += 1) {
  $state = Invoke-RestMethod $Url
  $snapshots += ,$state

  if ($index -lt ($sampleCount - 1)) {
    Start-Sleep -Milliseconds $IntervalMs
  }
}

$latest = $snapshots[-1]
$hostClient = @($latest.clients | Where-Object { $_.role -eq 'broadcaster' -and $_.connected }) | Select-Object -First 1
$listenerClients = @($latest.clients | Where-Object { $_.role -eq 'listener' -and $_.connected })

if (-not $hostClient) {
  Write-Error 'No connected host found in debug state.'
}

if (-not $listenerClients.Count) {
  Write-Error 'No connected listeners found in debug state.'
}

$rows = foreach ($listener in $listenerClients) {
  $matchingSnapshots = @(
    $snapshots |
      ForEach-Object { @($_.clients | Where-Object { $_.clientId -eq $listener.clientId }) | Select-Object -First 1 } |
      Where-Object { $_ }
  )
  $maxDeltaBytes = 0
  foreach ($snapshotClient in $matchingSnapshots) {
    $candidate = Parse-IntOrZero $snapshotClient.diagnosticsSummary.'receiver.deltaBytes'
    if ($candidate -gt $maxDeltaBytes) {
      $maxDeltaBytes = $candidate
    }
  }

  [pscustomobject]@{
    listener = $listener.label
    status = $listener.diagnosticsSummary.status
    directMode = $listener.diagnosticsSummary.processedPlaybackPath
    rxBytes = $listener.diagnosticsSummary.'receiver.deltaBytes'
    rxBytesMax = $maxDeltaBytes
    rxPackets = $listener.diagnosticsSummary.'receiver.deltaPackets'
    pcState = $listener.diagnosticsSummary.'pc.connectionState'
    playbackLevel = $listener.diagnosticsSummary.playbackMeterLevel
    failure = $listener.diagnosticsSummary.'lastPlaybackFailure.message'
  }
}

$listenerMaxBytesByLabel = @{}
foreach ($row in $rows) {
  $listenerMaxBytesByLabel[$row.listener] = [int]$row.rxBytesMax
}

Write-Host ("Host: {0}" -f $hostClient.label)
Write-Host ("Status: {0}" -f $hostClient.diagnosticsSummary.status)
Write-Host ''
$rows | Format-Table -AutoSize

$unstable = @($listenerClients | Where-Object {
  $label = [string]$_.label
  $maxBytes = if ($listenerMaxBytesByLabel.ContainsKey($label)) {
    [int]$listenerMaxBytesByLabel[$label]
  } else {
    0
  }

  $_.diagnosticsSummary.'pc.connectionState' -ne 'connected' -or $maxBytes -le 0
})

if ($unstable.Count) {
  Write-Error 'One or more listeners are not in a stable connected/audio-receiving state.'
}
