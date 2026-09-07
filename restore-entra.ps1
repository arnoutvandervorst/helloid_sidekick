<#
.SYNOPSIS
  Puts Microsoft Entra ID user properties back from a HelloID Sidekick rollback pack.

.DESCRIPTION
  The field-mapping simulation in HelloID Sidekick saves, per account and per
  property HelloID would rewrite, the value the directory held when it was
  collected ("before") and the value the mapping produces ("after"). Once HelloID
  has gone live and written over the properties, this script puts the collected
  values back.

  It is a dry run unless you say -Apply: the table it prints shows, per account
  and property, the collected value, the value the mapping predicted, the value
  Entra holds right now, and what the script would do:

    same      the live value already equals the collected one — nothing to do
    restore   the live value is what the mapping predicted: HelloID wrote it
    restore?  the live value is neither — something else changed it since the
              collection; still restored, unless you pass -SkipUnexpected

  Users synced from on-premises AD are skipped: their properties are owned by AD
  (restore them there with restore-ad.ps1; Entra Connect syncs them). proxyAddresses
  is read-only through Graph and skipped too. Every other property goes through
  Update-MgUser. -WhatIf is honoured on top of -Apply.

  WHAT THIS SCRIPT ASKS CONSENT FOR: User.ReadWrite.All (delegated, interactive)
  — it has to write. With -AppOnly it signs in as the app registration saved in
  helloid-config.json (profile kind "entra", shared with collect-entra.ps1), which
  then needs User.ReadWrite.All as an application permission.

  Requires: Microsoft.Graph.Authentication, Microsoft.Graph.Users
  (Install-Module Microsoft.Graph -Scope CurrentUser)

.PARAMETER Pack
  The rollback-entra-<date>.json downloaded from the Field mapping › Simulation tab.

.PARAMETER Apply
  Write the collected values back. Without it nothing is changed.

.PARAMETER Account
  Only these accounts (UPN or on-premises sAMAccountName); default: every account in the pack.

.PARAMETER Attribute
  Only these properties (as named in the pack: jobTitle, department, …).

.PARAMETER SkipUnexpected
  Leave properties alone whose live value is neither the collected nor the
  predicted one.

.PARAMETER AppOnly
  Sign in as the saved app registration instead of interactively.

.PARAMETER ProfileName
  Which saved profile holds the app registration (default: the file's default).

.EXAMPLE
  .\restore-entra.ps1 -Pack rollback-entra-2026-09-07.json
  .\restore-entra.ps1 -Pack rollback-entra-2026-09-07.json -Apply
  .\restore-entra.ps1 -Pack rollback-entra-2026-09-07.json -Apply -Account jan.jansen@corp.nl
  .\restore-entra.ps1 -Pack rollback-entra-2026-09-07.json -Apply -Attribute jobTitle,department -SkipUnexpected
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
  Justification = 'Interactive console script; the table and the summary belong on the host, never in the pipeline.')]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingConvertToSecureStringWithPlainText', '',
  Justification = 'The client secret comes from the saved profile and is wrapped for Connect-MgGraph in memory only.')]
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$Pack,
  [switch]$Apply,
  [string[]]$Account = @(),
  [string[]]$Attribute = @(),
  [switch]$SkipUnexpected,
  [switch]$AppOnly,
  [string]$ProfileName = ''
)

$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
function Write-Step([string]$Message) {
  Write-Host ("[{0:hh\:mm\:ss}] {1}" -f $sw.Elapsed, $Message)
}

# ---- the pack -----------------------------------------------------------------
$data = Get-Content -LiteralPath $Pack -Raw -Encoding UTF8 | ConvertFrom-Json
if ($data.kind -ne 'helloid-sidekick-rollback') { throw "Not a HelloID Sidekick rollback pack: $Pack" }
if ($data.source -ne 'entra') { throw "This pack was made from a $($data.source) directory; use restore-$($data.source).ps1" }
$accounts = @($data.accounts)
Write-Step "Pack: $($accounts.Count) accounts, $(($accounts | ForEach-Object { @($_.fields).Count } | Measure-Object -Sum).Sum) property values, saved $($data.savedAt)"
if ($data.collectedAt) {
  $age = [int]((Get-Date) - [datetime]$data.collectedAt).TotalDays
  Write-Step "Collected values are $age day(s) old ($($data.collectedAt))"
  if ($age -gt 30) { Write-Warning "The collected values are over a month old: anything changed since then is restored to its older state too." }
}
if (@($data.skipped).Count) {
  Write-Host "Not in the pack (no collected value): $((@($data.skipped) | ForEach-Object { $_.field }) -join ', ')"
}
if (-not $Apply) { Write-Host "DRY RUN — nothing is written. Add -Apply to restore." -ForegroundColor Yellow }

# ---- sign in ------------------------------------------------------------------
if ($AppOnly) {
  . (Join-Path $PSScriptRoot 'HelloIDCreds.ps1')
  $creds = Resolve-HelloIDCredential -Kind entra -ProfileName $ProfileName -EnvFile (Join-Path $PSScriptRoot '.env')
  Write-Host "Connecting to Microsoft Graph as app $($creds.Key) in tenant $($creds.Url) (application permissions, no user): User.ReadWrite.All"
  $secure = ConvertTo-SecureString $creds.Secret -AsPlainText -Force
  $appCred = New-Object System.Management.Automation.PSCredential($creds.Key, $secure)
  Connect-MgGraph -TenantId $creds.Url -ClientSecretCredential $appCred -NoWelcome
} else {
  Write-Host "Connecting to Microsoft Graph with the write scope this needs: User.ReadWrite.All"
  Connect-MgGraph -Scopes 'User.ReadWrite.All' -NoWelcome
}
Write-Step "Connected."

# ---- helpers ------------------------------------------------------------------
$readOnly = @('proxyAddresses', 'mail')
function Format-Value($v) {
  if ($null -eq $v) { return '' }
  if ($v -is [System.Array] -or $v -is [System.Collections.IList]) { return (@($v | ForEach-Object { [string]$_ }) -join '; ') }
  if ($v -is [bool]) { return $v.ToString().ToLower() }
  return [string]$v
}
function Test-Same($a, $b) {
  $x = Format-Value $a; $y = Format-Value $b
  if ($x -match '^(true|false)$' -or $y -match '^(true|false)$') { return $x.ToLower() -eq $y.ToLower() }
  return $x -eq $y
}
function Get-LiveValue($mgUser, [string]$attribute) {
  if ($attribute -like 'onPremisesExtensionAttributes.*') {
    $name = $attribute.Split('.')[1]
    $ext = $mgUser.OnPremisesExtensionAttributes
    if (-not $ext) { return '' }
    $v = $ext.$name
    if ($null -eq $v -and $ext.AdditionalProperties) { $v = $ext.AdditionalProperties[$name] }
    return $v
  }
  $v = $mgUser.$attribute
  if ($null -eq $v -and $mgUser.AdditionalProperties) { $v = $mgUser.AdditionalProperties[$attribute] }
  return $v
}

$wantedAccounts = @($Account | ForEach-Object { $_.ToLower() })
$wantedAttrs = @($Attribute | ForEach-Object { $_.ToLower() })

# ---- the run ------------------------------------------------------------------
$rows = [System.Collections.Generic.List[object]]::new()
$done = 0; $failed = 0; $skipped = 0; $same = 0
$n = 0
foreach ($acc in $accounts) {
  $n++
  if ($wantedAccounts.Count -and $wantedAccounts -notcontains ([string]$acc.userName).ToLower() -and $wantedAccounts -notcontains ([string]$acc.upn).ToLower()) { continue }
  $props = @('id', 'userPrincipalName', 'onPremisesSyncEnabled', 'onPremisesExtensionAttributes') + @($acc.fields | ForEach-Object { ([string]$_.attribute).Split('.')[0] }) | Select-Object -Unique
  $mgUser = $null
  try { $mgUser = Get-MgUser -UserId $acc.id -Property ($props -join ',') } catch { $mgUser = $null }
  if (-not $mgUser) {
    $rows.Add([pscustomobject]@{ account = $acc.upn; attribute = '*'; before = ''; predicted = ''; live = ''; status = 'not found'; result = 'skipped' })
    $skipped++; continue
  }
  if ($mgUser.OnPremisesSyncEnabled) {
    $rows.Add([pscustomobject]@{ account = $acc.upn; attribute = '*'; before = ''; predicted = ''; live = ''; status = 'synced from AD'; result = 'skipped (restore in AD)' })
    $skipped++; continue
  }
  foreach ($f in @($acc.fields)) {
    if ($wantedAttrs.Count -and $wantedAttrs -notcontains ([string]$f.attribute).ToLower() -and $wantedAttrs -notcontains ([string]$f.field).ToLower()) { continue }
    $live = Get-LiveValue $mgUser ([string]$f.attribute)
    $status = if (Test-Same $live $f.before) { 'same' } elseif (Test-Same $live $f.after) { 'restore' } else { 'restore?' }
    $row = [pscustomobject]@{
      account = $acc.upn; attribute = $f.attribute
      before = Format-Value $f.before; predicted = Format-Value $f.after; live = Format-Value $live
      status = $status; result = ''
    }
    $rows.Add($row)
    if ($status -eq 'same') { $same++; $row.result = '-'; continue }
    if ($readOnly -contains $f.attribute) { $skipped++; $row.result = 'skipped (read-only in Graph)'; continue }
    if ($status -eq 'restore?' -and $SkipUnexpected) { $skipped++; $row.result = 'skipped (unexpected)'; continue }
    if ($f.unverified) { Write-Warning "$($acc.upn): '$($f.attribute)' is not a property Sidekick knows; it is sent verbatim." }
    if (-not $Apply) { $row.result = 'would restore'; continue }
    $target = "$($acc.upn) $($f.attribute)"
    try {
      if ($PSCmdlet.ShouldProcess($target, "restore to '$(Format-Value $f.before)'")) {
        $before = $f.before
        $empty = ($null -eq $before) -or (($before -is [string]) -and $before.Trim() -eq '') -or (($before -is [System.Array]) -and @($before).Count -eq 0)
        $body = @{}
        if ([string]$f.attribute -like 'onPremisesExtensionAttributes.*') {
          $body['onPremisesExtensionAttributes'] = @{ ([string]$f.attribute).Split('.')[1] = $(if ($empty) { $null } else { [string]$before }) }
        } elseif ($f.array -or $before -is [System.Array]) {
          $body[[string]$f.attribute] = [string[]]@($before)
        } elseif ($f.attribute -ieq 'accountEnabled') {
          $body[[string]$f.attribute] = ((Format-Value $before) -eq 'true')
        } else {
          $body[[string]$f.attribute] = $(if ($empty) { $null } else { [string]$before })
        }
        Update-MgUser -UserId $mgUser.Id -BodyParameter $body
        $row.result = 'restored'; $done++
      } else {
        $row.result = 'what if'
      }
    } catch {
      $row.result = "FAILED: $($_.Exception.Message)"; $failed++
    }
  }
  if ($n % 50 -eq 0) { Write-Step "  $n / $($accounts.Count) accounts" }
}

# ---- the table and the summary ------------------------------------------------
$rows | Format-Table -AutoSize -Wrap account, attribute, before, predicted, live, status, result | Out-String -Width 220 | Write-Host
$verb = if ($Apply) { 'restored' } else { 'would restore' }
$todo = @($rows | Where-Object { $_.result -in @('would restore', 'restored', 'what if') }).Count
Write-Step "$verb $todo value(s); $same already as collected; $skipped skipped; $failed failed"
if ($failed) { exit 1 }
