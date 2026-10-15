# Service Automation script & form analysis: handoff

Status (2026-10-15): **built locally, not committed.** `js/salint.js` (rules, pure),
`js/views-scripts.js` (view "Scripts & forms", Health/Consult/All editions), import slot
`saconfig`, `test/salint.test.js` (59). The exporter adds `activity` (Elastic `sa-form*`,
`sa-audit*`, `sa-request*`, `sa-approval*`, `--log-days`, formData dropped) when the profile
has an Elastic key. The Delegation › Activities service (task state per submission) answers
401 to an API key, so the audit log is the only runtime source. Rule shapes for `sa-audit`
rows are unverified: the test tenant has none yet.

## Goal

A **Health**-edition view ("Scripts & forms") that lints a tenant's Service Automation
configuration the way a static analyser lints code. It works towards maintainable forms
with managed, shared scripts. It reads one dropped export; there are no API calls from the
browser. The API rejects the browser preflight with 405, and the page CSP forbids it anyway.

## Input: `helloid-sa-config.json` (written by `helloid-sa-export.py`)

```
{ kind: 'helloid-sa-config', version: 1, collectedAt, tenant,
  variables[]               // library; secret values masked '***'; isSystem = value is {{...}}
  dataSources[]             // list ∪ detail: dataSourceGUID, name, type (1 native, 2 static, 3 task, 4 PowerShell),
                            //   runInCloud, model[{key,type}], input[], script, value (static)
  dynamicForms[]            // dynamicFormGUID, formOriginalGUID, version, name, formSchema[]
  delegatedForms[]          // delegatedFormGUID, name, dynamicFormGUID, isEnabled, accessGroups[{groupGUID,name}],
                            //   categoryGuids[], task{id,name,script,runInCloud,agentPoolId}
  delegatedFormCategories[] // delegatedFormCategoryGuid, name{en,nl,...}
  products[]                // productId, name, code, dynamicForm{id}|null, approvalWorkflow{id}, categories[{id}],
                            //   accessGroups[{id,name}], agentPool{id}, actions[], onRequest|onApprove|onDeny|onReturn|onWithdrawn[]
                            //   each event task {id,name,script,agentPoolId,runInCloud,variables[]}
  productCategories[]       // selfServiceCategoryGUID, name
  scheduledTasks[]          // incl. disabled; automationTaskGuid, name, isEnabled, agentPoolGUID, variables[] (secrets masked)
  agentPools[] }
```

Facts worth knowing when parsing:
- A dynamic form referenced by an old GUID serves its latest version. Delegated forms keep the
  original GUID, so match forms on both `dynamicFormGUID` and `formOriginalGUID`.
- Data source references in a schema sit at `templateOptions.dataSourceConfig.dataSourceGuid`
  (any depth, including inside `formrow`/`fieldGroup`). Inputs sit at
  `dataSourceConfig.input.propertyInputs[{propertyName, otherFieldValue:{otherFieldKey}} | staticValue]`.
- Grid columns are at `templateOptions.grid.columns[{field, headerName,...}]`. Dropdown and
  duallist fields use `valueField`/`textField`/`optionKeyProperty`/`optionDisplayProperty`.
- Conditional visibility is `hideExpression`, e.g. `!model["blnExpDate"]`.
- Name lookups by URL fail for names containing `&`. That matters only for tooling that writes
  back; here everything is already in the file.
- Provisioning scripts are not readable through the API. They are out of scope.

## Rules (initial set). Each finding has severity, entity, location, why, fix

Evidence column = what the live test tenant `arnoutvandervorst.helloid.com` showed on 2026-10-15.

| id | Rule | Evidence |
|---|---|---|
| `sa.clone` | Near-duplicate scripts (normalised line-set Jaccard ≥ 0.6; exact = 1.0) across data sources/tasks. Group them into clusters, propose one shared script | 10 clones of the user wildcard search (0.64–1.0) plus 6 old-generation `AD-user-generate-table-wildcard-*`; 4 group-search variants; attribute tables 0.86–1.0 |
| `sa.clone.drift` | Within a cluster, members differ: show the diff against the most common or newest variant | the wildcard searches select different property sets |
| `sa.grid.columns` | A grid column `field` not in the data source `model` keys. Compare case-sensitively, because a mismatch is likely an empty column | Enable form grid uses `displayName`, model has `DisplayName`; Disable model emits `objectGuid` while others use `ObjectGuid` |
| `sa.grid.inconsistent` | Similar data sources (same cluster) feeding grids with different column sets or casings | per-form column sets differ (Move OU, Expire, Phone, Reset, …) |
| `sa.field.reveal.required` | A field revealed by `hideExpression` on a boolean is not `required` (tick the box, leave it empty) | Update account expires: `expireDate` hidden by `!model["blnExpDate"]`, not required |
| `sa.field.ref` | `hideExpression` / `otherFieldKey` / task `$form.<key>` references a field key that does not exist in the form | n/a yet |
| `sa.field.dropdown` | Dropdown/radio without a data source and without static options; `valueField`/`textField` not in the model | n/a yet |
| `sa.var.casing` | One library variable spelled several ways across scripts | `ADusersSearchOU` 8× / `AdUsersSearchOu` 6×; `AdGroupsSearchOU` in 3 spellings |
| `sa.var.unused` | Custom library variable no script references (system `{{…}}` ones exempt) | `ADdistributionGroupsOU` (also still points at the Enyoi domain), `Exchange*` |
| `sa.var.empty` | Library variable with an empty value (worse when it is used) | `ExchangeAdminUsername/Password/ConnectionUri` empty |
| `sa.var.undefined` | Script reads `$x` that it never assigns, that is not automatic (`$form`, `$datasource`, `$dataSource`, `$product`, `$requester`, `$_`, preference vars …) and not in the library. Parse `param()` blocks across lines, plus `foreach ($x in`, `[type]$x` and function params | copy-paste bugs: `$groupName` (AD-user-generate-table-managers-update-manager l.41), `$searchValue` (…-groupmanagers-update-manager l.29) |
| `sa.var.format` | The same variable is parsed differently by different scripts: `-split ';'` vs `ConvertFrom-Json` | older 2023 Tools4ever forms parse OU vars as JSON, current ones split on `;` |
| `sa.pattern.*` | Outdated or risky patterns: deprecated endpoints (`/selfservice/products`, `/productownership`), TLS 1.0/1.1 forcing, hardcoded domains/emails/UPN suffixes, hardcoded credentials, `Write-Host` (lost in HelloID logs), missing try/catch around AD cmdlets | createform-era scripts force TLS 1.0/1.1 |
| `sa.orphan` | A data source used by no dynamic form; a dynamic form used by no delegated form or product | old "Zoek account", "…-deactivate", several pre-2024 forms |
| `sa.access` | A delegated form or product without access groups (invisible in the Service Desk); without a category | two forms had no access group before 2026-10-15 |
| `sa.agent` | A non-cloud task or data source while the export shows no agent pool, or an agentPoolId that matches no pool | the pool was empty → "No agent online" on every dropdown |
| `sa.name.dup` | Duplicate data source names (lookups by name become ambiguous) | `ou`, `select-groups`, `memberships`, `Memberships` |

Clone similarity: normalise (strip comments and blank lines, trim, collapse whitespace), take the
set of lines, Jaccard; union-find clusters at ≥ 0.5–0.6. A 60-script tenant ran instantly in
Python, so plain JS is fine.

## Where it plugs in (from the Sidekick architecture survey)

- **Detect:** add `HR.salint.looksLikeConfig = peek => peek.kind === 'helloid-sa-config' && Array.isArray(peek.dataSources)`
  to *both* sniff chains in js/app.js (`detectKind` ~400-416, `importJsonFile` ~615-672) **before** the vault fallback.
  `'helloid-service-automation'` is already taken (products+assignments).
- **Import fn:** model it on `importAudit` (app.js ~739-752): parse, `state.saconfig` / `raw` /
  `importedAt` / `fileNames`, `saveContext`, toast, `HR.usage.imported`, `rebuild()`, `go('scripts')`.
- **Hard-coded lists to extend:** `clearSource` whitelist (app.js ~451); restore on reload (~1431, 1441, 1444-1452);
  `rebuild()` `anySource` (~1249) or the view must be in `worksEmpty`; topbar source list (~1266-1277);
  store.js published keys (~202); views.js `SOURCE_SLOTS` (~543-554), `slotState` (~556-619), `sourcesCard` (~407-466),
  `COLLECTORS`/`probeCollectors` (~637-653, add `helloid-sa-export.py`); `REQUIRES.scripts: ['saconfig']` (~222-232);
  Dockerfile COPY line (~18) for the collector.
- **View:** new `js/salint.js` (rules, pure; testable in Node) and `js/views-scripts.js`
  (`HR.views.scripts`, `HR.viewkit.tabbed` with tabs Overview · Findings · Clones · Grids · Variables · Inventory).
  Add `<script>` tags in index.html after views.js, before app.js; build.py follows index.html order.
- **Edition/nav:** add `scripts` to `EDITIONS.health` (group `model`, next to `conventions`) and `all`
  in js/edition.js; `nav.js GROUPS` fallback; `ICONS` if top-level.
- **UI kit:** `HR.util.el`, `card`, `tile`, `HR.table.make({columns, rows, search, filters, exportName})`,
  `.sev critical|high|medium|low|info|good`, `.pill`, `HR.charts.barList/heatmap`, `openDrawer` for the
  side-by-side diff of two clone variants. `findingCard` is not exported on viewkit; export it or
  mirror it.
- **i18n:** keys in both `EN` and `NL` blocks of js/i18n.js: `nav.scripts`, `src.saconfig`,
  `src.slot.saconfig.unlocks/.where`, `toast.saconfigLoaded`, `sc.*` for the view, and
  `fi.sa.<rule>.title/what/why/fix` per rule. Dutch is a full translation.
- **Tests:** `test/salint.test.js` in the vm-sandbox style of test/risk.test.js, with a small
  fixture in demo/ (anonymised; `demo/*.json` is allowed by .gitignore). Run with `NODE_OPTIONS= node test/salint.test.js`.
- **Release:** entry at the top of js/changelog.js `ENTRIES`, then `NODE_OPTIONS= node make-changelog.js`.

## Still to do on the collector side

- `helloid-sa-export.ps1`: a PowerShell twin of the .py, as with helloid-export.ps1/.py.
- Scheduled PowerShell tasks: the test tenant only has the built-in AD sync task (no script),
  so where a custom scheduled task's script lives in the response is unverified. The exporter
  keeps the whole object plus local variables (secrets masked). Confirm on a tenant that has one.

## Related tooling (outside this repo)

`~/Projects/helloid_api/sa-package/`: Export/Import-FormPackage.ps1. It packages delegated forms
into environment-neutral files: scripts as shared `.ps1`, data sources referenced by name,
`{{TOKENS}}` per environment. It imports idempotently into another tenant. That is where the
"merge clones into one shared data source" fix that this view recommends would be carried out.
