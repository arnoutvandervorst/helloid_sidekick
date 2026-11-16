<#
.SYNOPSIS
  Puts Active Directory attributes back from a HelloID Sidekick rollback pack.

.DESCRIPTION
  The field-mapping simulation in HelloID Sidekick saves, per account and per
  attribute HelloID would rewrite, the value the directory held when it was
  collected ("before") and the value the mapping produces ("after"). Once HelloID
  has gone live and written over the attributes, this script puts the collected
  values back.

  It is a dry run unless you say -Apply: the table it prints shows, per account
  and attribute, the collected value, the value the mapping predicted, the value
  the directory holds right now, and what the script would do:

    same      the live value already equals the collected one — nothing to do
    restore   the live value is what the mapping predicted: HelloID wrote it
    restore?  the live value is neither — something else changed it since the
              collection; left alone unless you pass -IncludeUnexpected

  Only attributes a HelloID AD field mapping writes are restored (an allowlist in
  this script); anything else in the pack — userAccountControl, scriptPath,
  servicePrincipalName, group membership, … — is refused with a warning, since the
  pack is a JSON file anyone could have edited. An account is found by the
  distinguished name the collector saved and must still carry the collected
  sAMAccountName (or the one the mapping predicted); it is never looked up by name
  alone, so an account that HelloID moved or renamed is reported as not found.
  Re-enabling a disabled account needs -AllowEnable: a leaver must not come back
  by accident.

  Container (OU) is restored with Move-ADObject, cn with Rename-ADObject, every
  other attribute with Set-ADUser -Replace (or -Clear when the collected value
  was empty). Password never appears in a pack. -WhatIf is honoured on top of
  -Apply.

  Requires the ActiveDirectory PowerShell module (RSAT) and an account that may
  write the attributes in question.

.PARAMETER Pack
  The rollback-ad-<date>.json downloaded from the Field mapping › Simulation tab.

.PARAMETER Apply
  Write the collected values back. Without it nothing is changed.

.PARAMETER Account
  Only these accounts (sAMAccountName or UPN); default: every account in the pack.

.PARAMETER Attribute
  Only these attributes (as named in the pack: description, title, container, …).

.PARAMETER IncludeUnexpected
  Also restore attributes whose live value is neither the collected nor the
  predicted one. Without it they are left alone.

.PARAMETER AllowEnable
  Allow enabled = true to be restored, i.e. re-enable accounts that are disabled
  now. Without it disabled accounts stay disabled.

.PARAMETER SkipUnexpected
  Accepted for older command lines; skipping unexpected values is now the default.

.EXAMPLE
  .\restore-ad.ps1 -Pack rollback-ad-2026-09-07.json
  .\restore-ad.ps1 -Pack rollback-ad-2026-09-07.json -Apply
  .\restore-ad.ps1 -Pack rollback-ad-2026-09-07.json -Apply -Account jan.jansen
  .\restore-ad.ps1 -Pack rollback-ad-2026-09-07.json -Apply -Attribute description,title -IncludeUnexpected
#>
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
  Justification = 'Interactive console script; the table and the summary belong on the host, never in the pipeline.')]
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$Pack,
  [switch]$Apply,
  [string[]]$Account = @(),
  [string[]]$Attribute = @(),
  [switch]$IncludeUnexpected,
  [switch]$AllowEnable,
  [switch]$SkipUnexpected
)

$ErrorActionPreference = 'Stop'
$sw = [System.Diagnostics.Stopwatch]::StartNew()
function Write-Step([string]$Message) {
  Write-Host ("[{0:hh\:mm\:ss}] {1}" -f $sw.Elapsed, $Message)
}

# ---- the pack -----------------------------------------------------------------
$data = Get-Content -LiteralPath $Pack -Raw -Encoding UTF8 | ConvertFrom-Json
if ($data.kind -ne 'helloid-sidekick-rollback') { throw "Not a HelloID Sidekick rollback pack: $Pack" }
if ($data.source -ne 'ad') { throw "This pack was made from a $($data.source) directory; use restore-$($data.source).ps1" }
$accounts = @($data.accounts)
Write-Step "Pack: $($accounts.Count) accounts, $(($accounts | ForEach-Object { @($_.fields).Count } | Measure-Object -Sum).Sum) attribute values, saved $($data.savedAt)"
if ($data.collectedAt) {
  $age = [int]((Get-Date) - [datetime]$data.collectedAt).TotalDays
  Write-Step "Collected values are $age day(s) old ($($data.collectedAt))"
  if ($age -gt 30) { Write-Warning "The collected values are over a month old: anything changed since then is restored to its older state too." }
}
if (@($data.skipped).Count) {
  Write-Host "Not in the pack (no collected value): $((@($data.skipped) | ForEach-Object { $_.field }) -join ', ')"
}
if ($SkipUnexpected) { Write-Host '-SkipUnexpected is the default now; -IncludeUnexpected opts in.' }
if (-not $Apply) { Write-Host "DRY RUN — nothing is written. Add -Apply to restore." -ForegroundColor Yellow }

Write-Step "Importing ActiveDirectory module..."
Import-Module ActiveDirectory
Write-Step "Domain: $((Get-ADDomain).DNSRoot)"

# ---- helpers ------------------------------------------------------------------
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
function Get-LiveValue($adUser, $field) {
  switch ($field.op) {
    'move'   { return ($adUser.DistinguishedName -replace '^[^,]+,', '') }
    'rename' { return [string]$adUser.Name }
    default  {
      $v = $adUser.($field.attribute)
      if ($null -eq $v) { return '' }
      # multi-valued attributes come back as ADPropertyValueCollection: flatten to strings
      if ($v -is [System.Collections.IEnumerable] -and $v -isnot [string]) { return @($v | ForEach-Object { [string]$_ }) }
      return $v
    }
  }
}

# What a HelloID AD field mapping can write (js/fieldmap.js ATTR_ALIASES, by LDAP name). Never
# security-relevant ones: userAccountControl, servicePrincipalName, msDS-AllowedToDelegateTo,
# scriptPath, profilePath, member/memberOf, adminCount, sIDHistory, primaryGroupID, …
$restorable = @('sAMAccountName', 'userPrincipalName', 'sn', 'givenName', 'displayName', 'initials',
  'mail', 'mailNickname', 'proxyAddresses', 'employeeID', 'employeeNumber', 'employeeType',
  'title', 'department', 'company', 'physicalDeliveryOfficeName', 'telephoneNumber', 'mobile',
  'streetAddress', 'l', 'st', 'postalCode', 'c', 'info', 'description', 'wWWHomePage',
  'preferredLanguage', 'homeDirectory', 'homeDrive', 'container', 'cn', 'enabled', 'accountEnabled') +
  @(1..15 | ForEach-Object { "extensionAttribute$_" })

$wantedAccounts = @($Account | ForEach-Object { $_.ToLower() })
$wantedAttrs = @($Attribute | ForEach-Object { $_.ToLower() })

# ---- the run ------------------------------------------------------------------
$rows = [System.Collections.Generic.List[object]]::new()
$done = 0; $failed = 0; $skipped = 0; $same = 0
$n = 0
foreach ($acc in $accounts) {
  $n++
  if ($wantedAccounts.Count -and $wantedAccounts -notcontains ([string]$acc.userName).ToLower() -and $wantedAccounts -notcontains ([string]$acc.upn).ToLower()) { continue }
  $adUser = $null
  # By the saved DN only: a name lookup could land on someone who reused the sAMAccountName
  try { $adUser = Get-ADUser -Identity $acc.id -Properties * } catch { $adUser = $null }
  if ($adUser) {
    $names = @([string]$acc.userName) + @($acc.fields | Where-Object { $_.attribute -ieq 'sAMAccountName' } | ForEach-Object { [string]$_.before; [string]$_.after })
    if ($names -notcontains [string]$adUser.SamAccountName) {
      Write-Warning "$($acc.userName): the object at $($acc.id) is now '$($adUser.SamAccountName)', not the collected account; skipped."
      $rows.Add([pscustomobject]@{ account = $acc.userName; attribute = '*'; before = ''; predicted = ''; live = ''; status = 'other account'; result = 'skipped' })
      $skipped++; continue
    }
  } else {
    Write-Warning "$($acc.userName): no account at $($acc.id) (moved, renamed or deleted); skipped. It is never looked up by name."
  }
  if (-not $adUser) {
    $rows.Add([pscustomobject]@{ account = $acc.userName; attribute = '*'; before = ''; predicted = ''; live = ''; status = 'not found'; result = 'skipped' })
    $skipped++; continue
  }
  foreach ($f in @($acc.fields)) {
    if ($wantedAttrs.Count -and $wantedAttrs -notcontains ([string]$f.attribute).ToLower() -and $wantedAttrs -notcontains ([string]$f.field).ToLower()) { continue }
    $live = Get-LiveValue $adUser $f
    $status = if (Test-Same $live $f.before) { 'same' } elseif (Test-Same $live $f.after) { 'restore' } else { 'restore?' }
    $row = [pscustomobject]@{
      account = $acc.userName; attribute = $f.attribute
      before = Format-Value $f.before; predicted = Format-Value $f.after; live = Format-Value $live
      status = $status; result = ''
    }
    $rows.Add($row)
    if ($restorable -notcontains [string]$f.attribute) {
      Write-Warning "$($acc.userName): '$($f.attribute)' is not an attribute a HelloID mapping restores here; refused."
      $skipped++; $row.result = 'refused (not restorable)'; continue
    }
    if ($status -eq 'same') { $same++; $row.result = '-'; continue }
    if ($status -eq 'restore?' -and -not $IncludeUnexpected) { $skipped++; $row.result = 'skipped (unexpected; -IncludeUnexpected)'; continue }
    if (($f.attribute -ieq 'enabled' -or $f.attribute -ieq 'accountEnabled') -and (Format-Value $f.before) -eq 'true' -and -not $AllowEnable) {
      $skipped++; $row.result = 'skipped (re-enable needs -AllowEnable)'; continue
    }
    if (-not $Apply) { $row.result = 'would restore'; continue }
    $target = "$($acc.userName) $($f.attribute)"
    try {
      if ($PSCmdlet.ShouldProcess($target, "restore to '$(Format-Value $f.before)'")) {
        switch ($f.op) {
          'move' {
            Move-ADObject -Identity $adUser.DistinguishedName -TargetPath ([string]$f.before)
            # the DN changed: later attributes of this account need the new one
            $adUser = Get-ADUser -Identity $adUser.ObjectGUID -Properties *
          }
          'rename' {
            Rename-ADObject -Identity $adUser.DistinguishedName -NewName ([string]$f.before)
            $adUser = Get-ADUser -Identity $adUser.ObjectGUID -Properties *
          }
          default {
            $before = $f.before
            $empty = ($null -eq $before) -or (($before -is [string]) -and $before.Trim() -eq '') -or (($before -is [System.Array]) -and @($before).Count -eq 0)
            if ($f.attribute -ieq 'enabled' -or $f.attribute -ieq 'accountEnabled') {
              if ((Format-Value $before) -eq 'true') { Enable-ADAccount -Identity $adUser } else { Disable-ADAccount -Identity $adUser }
            } elseif ($empty) {
              Set-ADUser -Identity $adUser -Clear $f.attribute
            } elseif ($f.array -or $before -is [System.Array]) {
              Set-ADUser -Identity $adUser -Replace @{ $f.attribute = [string[]]@($before) }
            } else {
              Set-ADUser -Identity $adUser -Replace @{ $f.attribute = [string]$before }
            }
          }
        }
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
