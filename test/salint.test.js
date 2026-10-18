/* Service Automation lint tests — no dependencies.
   Run:  NODE_OPTIONS= node test/salint.test.js

   A small synthetic tenant with one planted defect per rule, plus the clean twin of
   each so a rule that fires on everything fails here too. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const sb = { console };
sb.window = sb; vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'salint.js'), 'utf8'), sb, { filename: 'salint.js' });
const L = sb.HR.salint;

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, info) => { if (cond) pass++; else { fail++; fails.push('  FAIL ' + name + (info !== undefined ? ' — ' + JSON.stringify(info) : '')); } };

const SEARCH = `try {
  $searchValue = $datasource.searchValue
  $users = Get-ADUser -Filter "Name -like '*$searchValue*'" -SearchBase $ADusersSearchOU -Properties DisplayName
  foreach ($u in $users) { Write-Output @{ DisplayName = $u.DisplayName; ObjectGuid = $u.ObjectGuid } }
} catch { Write-Error $_ }`;
const ds = (guid, name, script, extra) => Object.assign({ dataSourceGUID: guid, name, type: 4, runInCloud: false, script,
  model: [{ key: 'DisplayName' }, { key: 'ObjectGuid' }], input: [{ key: 'searchValue' }] }, extra || {});
const grid = (key, dsGuid, cols, extra) => Object.assign({ key, type: 'grid', templateOptions: { required: true,
  grid: { columns: cols.map(f => ({ field: f, headerName: f })) },
  dataSourceConfig: { dataSourceGuid: dsGuid, input: { propertyInputs: [{ propertyName: 'searchValue', otherFieldValue: { otherFieldKey: 'searchValue' } }] } } } }, extra || {});
const input = (key, extra) => Object.assign({ key, type: 'input', templateOptions: { label: key } }, extra || {});
const TASK = `try {
  $user = $form.gridUsers
  Set-ADUser -Identity $user.ObjectGuid -AccountExpirationDate $form.expireDate
  Write-Information -Tags "Audit" -MessageData @{ Action = 'UpdateAccount'; IsError = $false }
} catch { Write-Error $_ }`;

const cfg = {
  kind: 'helloid-sa-config', version: 1, tenant: 'test.helloid.com',
  variables: [
    { name: 'ADusersSearchOU', value: 'OU=Users,DC=x', secret: false },
    { name: 'NeverUsed', value: 'x', secret: false },
    { name: 'EmptyUsed', value: '', secret: false },
    { name: 'TheSecret', value: '***', secret: true },
    { name: 'portalBase', value: '{{portal.baseUrl}}', secret: false, isSystem: true },
    { name: 'OuList', value: 'OU=A;OU=B', secret: false }
  ],
  dataSources: [
    ds('d1', 'users-a', SEARCH),
    ds('d2', 'users-b', SEARCH.replace('$ADusersSearchOU', '$AdUsersSearchOu')),           // exact-ish copy, other spelling
    ds('d3', 'users-c', SEARCH.replace("'*$searchValue*'", "'*$searchValu*'"), { model: [{ key: 'displayName' }, { key: 'ObjectGuid' }] }),
    ds('d4', 'orphan', 'Write-Output @{ a = 1 }'),
    ds('d5', 'buggy', 'try { Get-ADGroup -Filter "Name -eq \'$groupName\'" -Server $EmptyUsed } catch {}'),
    ds('d6', 'optional', 'try { if (-not [string]::IsNullOrEmpty($ADServer)) { $p = @{ Server = $ADServer } }; Get-ADUser -Filter * @p } catch {}'),
    ds('d7', 'json', 'try { $ous = $OuList | ConvertFrom-Json; Get-ADUser -Filter * } catch {}'),
    ds('d8', 'split', 'try { $ous = $OuList -split ";"; Get-ADUser -SearchBase "OU=Fixed,DC=corp,DC=local" -Filter * } catch {}'),
    ds('d9', 'reads-undeclared', 'try { $x = $datasource.notDeclared; Get-ADUser -Filter * } catch {}'),
    ds('d10', 'nohandling', 'Get-ADUser -Filter * | Select-Object Name'),
    { dataSourceGUID: 'd11', name: 'Users-A', type: 2, value: [], model: [{ key: 'path' }] }
  ],
  dynamicForms: [
    { dynamicFormGUID: 'f1', formOriginalGUID: 'f1', name: 'Good form', version: 1, formSchema: [
      input('searchValue', { templateOptions: { required: true } }),
      grid('gridUsers', 'd1', ['DisplayName', 'ObjectGuid']),
      { key: 'formRow', type: 'formrow', fieldGroup: [
        { key: 'blnExpDate', type: 'boolean', templateOptions: {} },
        input('expireDate', { type: 'datetime', hideExpression: '!model["blnExpDate"]', templateOptions: { required: true } })
      ] }
    ] },
    { dynamicFormGUID: 'f2v2', formOriginalGUID: 'f2', name: 'Bad form', version: 2, formSchema: [
      { label: 'Step 1', fields: [
        input('searchValue'),
        grid('gridUsers', 'd3', ['DisplayName', 'Missing']),                                // case + missing property
        grid('gridGone', 'nope', ['X']),                                                     // data source does not exist
        { key: 'blnExpDate', type: 'boolean', templateOptions: {} },
        input('expireDate', { hideExpression: '!model["blnExpDate"]' }),                    // revealed, not required
        input('ghost', { hideExpression: '!model["noSuchField"]' }),                        // reference to nothing
        { key: 'pick', type: 'dropdown', templateOptions: { options: ['Option 1', 'Option 2'] } },
        { key: 'pick2', type: 'dropdown', templateOptions: { useDataSource: true } },
        Object.assign(grid('gridOther', 'd2', ['DisplayName']), { templateOptions: { grid: { columns: [{ field: 'DisplayName' }, { field: 'objectguid' }] },
          dataSourceConfig: { dataSourceGuid: 'd2', input: { propertyInputs: [{ propertyName: 'wrongInput', staticValue: { value: 'x' } }] } } } })
      ] }
    ] },
    { dynamicFormGUID: 'f3', formOriginalGUID: 'f3', name: 'Unlinked form', formSchema: [input('a')] }
  ],
  delegatedForms: [
    { delegatedFormGUID: 'df1', name: 'Good', dynamicFormGUID: 'f1', isEnabled: true, accessGroups: [{ name: 'SD' }], categoryGuids: ['c1'],
      task: { id: 't1', name: 'Good', script: TASK, runInCloud: false } },
    { delegatedFormGUID: 'df2', name: 'Bad', dynamicFormGUID: 'f2', isEnabled: true, accessGroups: [], categoryGuids: [],
      task: { id: 't2', name: 'Bad', script: 'Set-ADUser -Identity $form.gridUser.ObjectGuid\nWrite-Host "done"\n[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls11\n$password = "Welkom01!"', runInCloud: false } },
    { delegatedFormGUID: 'df3', name: 'Lost', dynamicFormGUID: 'gone', isEnabled: true, accessGroups: [{ name: 'SD' }], categoryGuids: ['c1'], task: null },
    { delegatedFormGUID: 'df4', name: 'good', dynamicFormGUID: 'f1', isEnabled: true, accessGroups: [{ name: 'SD' }], categoryGuids: ['c1'],
      task: { id: 't4', name: 'good', script: TASK + '\n# /api/v1/selfservice/products', runInCloud: true } }
  ],
  delegatedFormCategories: [{ delegatedFormCategoryGuid: 'c1', name: { en: 'AD' } }],
  products: [
    { productId: 'p1', name: 'Visio', visibility: 'All', accessGroups: [], categories: [{ id: 'x' }], dynamicForm: null, actions: [],
      onApprove: [{ id: 'pt1', name: 'Grant', script: 'try { Add-ADGroupMember -Identity "G" -Members $requester.userName; Invoke-RestMethod "https://x/api/v1/productownership" } catch {}', agentPoolId: 'ghost-pool', runInCloud: false, variables: [] }] },
    { productId: 'p2', name: 'Empty product', visibility: 'Disabled', accessGroups: [], categories: [], dynamicForm: { id: 'missing' }, actions: [] }
  ],
  scheduledTasks: [],
  agentPools: [{ agentPoolGUID: 'pool-1', name: 'Default' }],
  activity: { from: '2026-07-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', days: 92,
    forms: [].concat(
      Array.from({ length: 6 }, () => ({ event: 'sa-form-opened', formGUID: 'df2', formName: 'Bad', logDate: '2026-09-01T10:00:00Z' })),
      [{ event: 'sa-form-submitted', formGUID: 'df2', formName: 'Bad', logDate: '2026-09-01T10:05:00Z' },
       { event: 'sa-form-opened', formGUID: 'df1', formName: 'Good', logDate: '2026-09-02T10:00:00Z' },
       { event: 'sa-form-submitted', formGUID: 'df1', formName: 'Good', logDate: '2026-09-02T10:01:00Z' }]),
    audit: [{ event: 'sa-audit', formName: 'Bad', isError: true, message: 'Set-ADUser: Cannot find an object with identity', logDate: '2026-09-01T10:05:01Z' },
            { event: 'sa-audit', formName: 'Good', isError: false, message: 'ok', logDate: '2026-09-02T10:01:01Z' }],
    requests: [], approvals: [] }
};

ok('looksLikeConfig', L.looksLikeConfig(cfg) && !L.looksLikeConfig({ kind: 'helloid-audit' }) && !L.looksLikeConfig([]));
const a = L.analyse(cfg);
const has = (rule, name, pred) => a.findings.some(f => f.rule === rule && (!name || f.target.name === name) && (!pred || pred(f)));
const count = rule => a.findings.filter(f => f.rule === rule).length;

/* forms */
ok('script output beats a stale model: DisplayName is returned, so no finding', !has('form.model.case', 'Bad', f => f.p.prop === 'DisplayName'));
ok('ds.model.stale when the model says displayName and the script returns DisplayName', has('ds.model.stale', 'users-c', f => /displayName \u2192 DisplayName/.test(f.p.recased)));
ok('form.model.case (certain) when the column misspells a hashtable key', has('form.model.case', 'Bad', f => f.p.prop === 'objectguid' && f.p.near === 'ObjectGuid' && f.sev === 'high'));
const sel = L.analyse({ kind: 'helloid-sa-config', dataSources: [ds('s1', 'sel', 'try {\n  Get-ADUser -Filter * | Select-Object DisplayName, ObjectGuid\n} catch {}', { model: [] })],
  dynamicForms: [{ dynamicFormGUID: 'g', name: 'G', formSchema: [grid('gridUsers', 's1', ['displayName', 'Mail'])] }], delegatedForms: [], products: [], variables: [] });
ok('Select-Object casing difference is a medium check', sel.findings.some(f => f.rule === 'form.model.case' && f.sev === 'medium' && f.p.prop === 'displayName'));
ok('property no output path returns is high', sel.findings.some(f => f.rule === 'form.model' && f.sev === 'high' && f.p.prop === 'Mail'));
const out = L.outputsOf('$props = @("A","B")\n$list = [System.Collections.ArrayList]::new()\n$r = Get-ADUser -Filter * | Select-Object -Property $props\n[void]$list.AddRange($r)\n$list | Sort-Object A | ForEach-Object { $_ | Add-Member -NotePropertyName C -Value 1; Write-Output $_ }');
ok('outputsOf follows $props, AddRange, the pipe and Add-Member', out.complete && ['a', 'b', 'c'].every(k => out.props.has(k)), [...out.props.keys()]);
ok('outputsOf: a string output is not understood', !L.outputsOf('Write-Output "Valid"').complete);
ok('form.model on the column nothing returns', has('form.model', 'Bad', f => f.p.prop === 'Missing'));
ok('form.model silent on the good form', !a.findings.some(f => f.rule.startsWith('form.model') && f.target.name === 'Good'));
ok('form.ds.missing', has('form.ds.missing', 'Bad', f => f.p.guid === 'nope'));
ok('form.reveal.required on the optional revealed field', has('form.reveal.required', 'Bad', f => f.p.field === 'expireDate'));
ok('form.reveal.required silent when required', !has('form.reveal.required', 'Good'));
ok('form.ref on a hideExpression to nothing', has('form.ref', 'Bad', f => f.p.ref === 'noSuchField'));
ok('form.ref silent on real references', !has('form.ref', 'Good'));
ok('form.choice.placeholder', has('form.choice.placeholder', 'Bad', f => f.p.field === 'pick'));
ok('form.choice.nosource', has('form.choice.nosource', 'Bad', f => f.p.field === 'pick2'));
ok('form.ds.input on an input the data source lacks', has('form.ds.input', 'Bad', f => f.p.prop === 'wrongInput'));
ok('script.form.key: $form.gridUser on a form with gridUsers', has('script.form.key', 'Bad', f => f.p.key === 'gridUser'));
ok('script.form.key silent on the good task', !has('script.form.key', 'Good'));

/* entries */
ok('entry.form.missing (delegated, critical)', has('entry.form.missing', 'Lost', f => f.sev === 'critical'));
ok('entry.form.missing (product)', has('entry.form.missing', 'Empty product'));
ok('entry.access on the form without group', has('entry.access', 'Bad'));
ok('entry.access silent on visibility All', !has('entry.access', 'Visio'));
ok('entry.access on a product not visible to all', has('entry.access', 'Empty product'));
ok('entry.category', has('entry.category', 'Bad') && !has('entry.category', 'Good'));
ok('entry.notask', has('entry.notask', 'Lost') && !has('entry.notask', 'Good'));
ok('product.notask', has('product.notask', 'Empty product') && !has('product.notask', 'Visio'));
ok('name.dup across case (Good/good, users-a/Users-A)', has('name.dup', null, f => f.p.kind === 'delegated') && has('name.dup', null, f => f.p.kind === 'datasource' && f.p.n === 2));
ok('orphan.ds', has('orphan.ds', 'orphan') && !has('orphan.ds', 'users-a'));
ok('orphan.form once per original', has('orphan.form', 'Unlinked form') && !has('orphan.form', 'Bad form'));

/* scripts */
ok('script.undefined on $groupName', has('script.undefined', 'buggy', f => f.p.name === 'groupName' && f.line === 1));
ok('script.undefined on the typo $searchValu', has('script.undefined', 'users-c', f => f.p.name === 'searchValu'));
ok('script.undefined skips automatic, assigned, foreach and library vars', !has('script.undefined', 'users-a') && !has('script.undefined', 'Good'));
ok('script.optional on a guarded $ADServer', has('script.optional', 'optional', f => f.p.name === 'ADServer') && !has('script.undefined', 'optional'));
ok('script.ds.input', has('script.ds.input', 'reads-undeclared', f => f.p.key === 'notDeclared') && !has('script.ds.input', 'users-a'));
ok('script.tls', has('script.tls', 'Bad'));
ok('script.writehost', has('script.writehost', 'Bad') && !has('script.writehost', 'Good'));
ok('script.secret', has('script.secret', 'Bad', f => f.sev === 'critical'));
ok('script.endpoint ignores comments, finds code', has('script.endpoint', 'Visio') && count('script.endpoint') === 1);
ok('script.hardcoded DN', has('script.hardcoded', 'split'));
ok('script.notry', has('script.notry', 'nohandling') && has('script.notry', 'Bad') && !has('script.notry', 'Good'));
ok('script.noaudit on tasks only', has('script.noaudit', 'Bad') && !has('script.noaudit', 'Good') && !has('script.noaudit', 'nohandling'));
ok('agent.pool', has('agent.pool', 'Visio', f => f.p.pool === 'ghost-pool'));
ok('agent.none absent while a pool exists', count('agent.none') === 0);
const noPool = L.analyse(Object.assign({}, cfg, { agentPools: [] }));
ok('agent.none without a pool, cloud scripts exempt', noPool.findings.some(f => f.rule === 'agent.none' && f.target.name === 'Good') &&
  !noPool.findings.some(f => f.rule === 'agent.none' && f.target.name === 'good'));

/* variables */
ok('var.unused, system exempt', has('var.unused', 'NeverUsed') && !has('var.unused', 'portalBase') && !has('var.unused', 'ADusersSearchOU'));
ok('var.empty high when used', has('var.empty', 'EmptyUsed', f => f.sev === 'high'));
ok('var.empty never on secrets', !has('var.empty', 'TheSecret'));
ok('var.casing', has('var.casing', 'ADusersSearchOU', f => /AdUsersSearchOu/.test(f.p.spellings)));
ok('var.format', has('var.format', 'OuList', f => f.p.json === 1 && f.p.split === 1));

/* clones */
const c = a.clusters.find(x => x.members.some(m => m.name === 'users-a'));
ok('clone cluster holds the three searches', c && c.members.length === 3, c && c.members.map(m => m.name));
ok('clone reference is the shared variant', c && c.ref.name !== 'users-c');
ok('script.clone finding per cluster', count('script.clone') === a.clusters.length && a.clusters.length >= 1);
const d = L.diffLines('a\nb\nc', 'a\nB\nx\nc');
ok('diffLines ignores case, shows the added line', d.filter(x => x.op === 'add').length === 1 && d.filter(x => x.op === 'del').length === 0, d);

/* runtime */
ok('use.errors from an IsError audit line', has('use.errors', 'Bad', f => f.p.n === 1 && /Cannot find/.test(f.p.last)) && !has('use.errors', 'Good'));
ok('use.abandon: opened 6, submitted 1', has('use.abandon', 'Bad', f => f.p.opened === 6 && f.p.submitted === 1));
ok('use.unused on an enabled form nobody opened', has('use.unused', 'Lost') && !has('use.unused', 'Good'));
const quiet = L.analyse(Object.assign({}, cfg, { activity: null }));
ok('no activity, no runtime rules', !quiet.findings.some(f => f.rule.startsWith('use.')) && quiet.activity === null);

/* parsing details */
const v = L.varsOf("$a = 1\n# $b in a comment\n'$c in single quotes'\n\"$d in double\"\n$e, $f = 1, 2\nparam(\n [string]$g\n)\n`$h\n$env:PATH");
ok('varsOf: comment and verbatim string do not read', !v.reads.has('b') && !v.reads.has('c'));
ok('varsOf: expandable string reads', v.reads.has('d'));
ok('varsOf: multi-assign and param assign', v.assigned.has('e') && v.assigned.has('f') && v.assigned.has('g'));
ok('varsOf: escaped and drive variables skipped', !v.reads.has('h') && !v.reads.has('env'));
ok('severity order', a.findings.every((f, i) => !i || a.findings[i - 1].order <= f.order));
ok('summary counts', a.summary.delegated === 4 && a.summary.products === 2 && a.summary.forms === 3);

/* safety and robustness rules */
const S = (guid, name, script, extra) => Object.assign({ dataSourceGUID: guid, name, type: 4, runInCloud: false, script,
  model: [{ key: 'DisplayName' }, { key: 'ObjectGuid' }], input: [{ key: 'searchValue' }] }, extra || {});
const selF = (key, g, extra) => Object.assign({ key, type: 'grid', templateOptions: { required: true, grid: { columns: [{ field: 'DisplayName' }] },
  dataSourceConfig: { dataSourceGuid: g, input: { propertyInputs: [{ propertyName: 'searchValue', otherFieldValue: { otherFieldKey: 'searchValue' } }] } } } }, extra || {});
const WILD = 'try {\n  $s = $datasource.searchValue\n  $f = "Name -like \'*$s*\'"\n  Get-ADUser -Filter $f | Select-Object DisplayName, ObjectGuid\n} catch { Write-Error $_ }';
const t2 = L.analyse({ kind: 'helloid-sa-config', agentPools: [{ agentPoolGUID: 'p' }],
  variables: [{ name: 'ApiPassword', value: 'hunter22', secret: false }, { name: 'SafePassword', value: '***', secret: true }, { name: 'SearchOU', value: 'OU=x', secret: false }],
  dataSources: [
    S('w1', 'wide', WILD),
    S('w2', 'scoped', WILD.replace('Get-ADUser -Filter $f', 'Get-ADUser -Filter $f -SearchBase $SearchOU').replace('$f = "Name', '$s = $s -replace "\'", "\'\'"\n  $f = "Name')),
    S('w3', 'cloudy', 'try { Get-ADUser -Filter * -SearchBase $SearchOU -ResultSetSize 50 | Select-Object DisplayName } catch { Write-Error $_ }', { runInCloud: true }),
    S('w4', 'everything', 'try {\n  Get-ADGroup -Filter * -SearchBase $SearchOU | Select-Object DisplayName\n} catch { }'),
    S('w5', 'lookup-one', 'try { Get-ADUser -Identity $datasource.searchValue | Select-Object DisplayName } catch { Write-Error $_ }')
  ],
  dynamicForms: [
    { dynamicFormGUID: 'fa', name: 'Reset', formSchema: [
      { key: 'searchValue', type: 'input', templateOptions: { required: true } }, selF('gridUsers', 'w1'),
      { key: 'password', type: 'password', templateOptions: { required: true }, summaryVisibility: 'Show' },
      { key: 'mobile', type: 'input', templateOptions: {} },
      { key: 'samAccountName', type: 'input', templateOptions: { required: true } },
      { key: 'notes', type: 'input', templateOptions: {} },
      { key: 'shown', type: 'input', templateOptions: { readonly: true } }
    ] },
    { dynamicFormGUID: 'fb', name: 'Delete', formSchema: [{ key: 'searchValue', type: 'input', templateOptions: { required: true } }, selF('gridUsers', 'w2'),
      { key: 'sure', type: 'boolean', templateOptions: { required: true } }] },
    { dynamicFormGUID: 'fc', name: 'Delete2', formSchema: [{ key: 'searchValue', type: 'input', templateOptions: { required: true } }, selF('gridUsers', 'w2')] }
  ],
  delegatedForms: [
    { delegatedFormGUID: 'r', name: 'Reset form', dynamicFormGUID: 'fa', isEnabled: true, accessGroups: [{ name: 'SD' }], categoryGuids: ['c'],
      task: { id: 'tr', script: 'try {\n  $mob = $form.mobile\n  Set-ADAccountPassword -Identity $form.gridUsers.ObjectGuid -NewPassword $form.password\n  Set-ADUser -Identity $form.gridUsers.ObjectGuid -MobilePhone $mob -SamAccountName $form.samAccountName\n  Write-Information "Reset to $($form.password)"\n  Write-Information -Tags "Audit" -MessageData @{ IsError = $false }\n} catch {\n  Write-Information "failed"\n}' } },
    { delegatedFormGUID: 'd', name: 'Delete form', dynamicFormGUID: 'fb', isEnabled: true, accessGroups: [{ name: 'SD' }], categoryGuids: ['c'],
      task: { id: 'td', script: 'try { Remove-ADUser -Identity $form.gridUsers.ObjectGuid -Confirm:$false; Write-Information -Tags "Audit" -MessageData @{} } catch { Write-Error $_ }', runInCloud: false } },
    { delegatedFormGUID: 'd2', name: 'Delete open', dynamicFormGUID: 'fc', isEnabled: true, accessGroups: [{ name: 'Users' }], categoryGuids: ['c'],
      task: { id: 'td2', script: 'try { Remove-ADUser -Identity $form.gridUsers.ObjectGuid -Confirm:$false; Write-Information -Tags "Audit" -MessageData @{} } catch { Write-Error $_ }' } }
  ],
  products: [
    { productId: 'pa', name: 'Grant only', visibility: 'All', categories: [{ id: 'x' }], actions: [], returnOnUserDisable: true,
      approvalWorkflow: { name: 'Instant approve' }, hasRiskFactor: true, riskFactor: 8,
      onApprove: [{ id: 'a1', name: 'Add', script: 'try { Add-ADGroupMember -Identity G -Members $requester.userName } catch { Write-Error $_ }' }] },
    { productId: 'pb', name: 'Empty return', visibility: 'All', categories: [{ id: 'x' }], actions: [], returnOnUserDisable: false,
      approvalWorkflow: { name: 'Manager' },
      onApprove: [{ id: 'b1', name: 'Add', script: 'try { Add-ADGroupMember -Identity G -Members $requester.userName } catch { Write-Error $_ }' }],
      onReturn: [{ id: 'b2', name: 'Log only', script: 'Write-Information "returned"' }] },
    { productId: 'pc', name: 'Good product', visibility: 'All', categories: [{ id: 'x' }], actions: [], returnOnUserDisable: true,
      approvalWorkflow: { name: 'Instant approve' }, hasRiskFactor: false, riskFactor: 1,
      onApprove: [{ id: 'c1', name: 'Add', script: 'try { Add-ADGroupMember -Identity G -Members $requester.userName } catch { Write-Error $_ }' }],
      onReturn: [{ id: 'c2', name: 'Remove', script: 'try { Remove-ADGroupMember -Identity G -Members $requester.userName -Confirm:$false } catch { Write-Error $_ }' }] }
  ] });
const h2 = (rule, name, pred) => t2.findings.some(f => f.rule === rule && (!name || f.target.name === name) && (!pred || pred(f)));
ok('script.scope on the unscoped wildcard search, not a scoped one or a lookup', h2('script.scope', 'wide') && !h2('script.scope', 'scoped') && !h2('script.scope', 'lookup-one'));
ok('entry.privileged: password reset fed by an unscoped search', h2('entry.privileged', 'Reset form', f => /Set-ADAccountPassword/.test(f.p.op)));
ok('script.inject low in a lookup, not when escaped', h2('script.inject', 'wide', f => f.sev === 'low') && !h2('script.inject', 'scoped'));
ok('script.cloud.ad', h2('script.cloud.ad', 'cloudy') && !h2('script.cloud.ad', 'wide'));
ok('form.password.shown', h2('form.password.shown', 'Reset form', f => f.p.field === 'password'));
ok('script.log.secret on Write-Information of the password', h2('script.log.secret', 'Reset form'));
ok('var.secret.plain', h2('var.secret.plain', 'ApiPassword') && !h2('var.secret.plain', 'SafePassword') && !h2('var.secret.plain', 'SearchOU'));
ok('entry.destructive without confirmation, high when open to Users', !h2('entry.destructive', 'Delete form') && h2('entry.destructive', 'Delete open', f => f.sev === 'high'));
ok('script.clears: optional mobile through an alias', h2('script.clears', 'Reset form', f => f.p.field === 'mobile' && f.p.param === 'MobilePhone'));
ok('script.clears: required field is fine', !h2('script.clears', 'Reset form', f => f.p.field === 'samAccountName'));
ok('script.swallow in the task, not where Write-Error is', h2('script.swallow', 'Reset form') && !h2('script.swallow', 'Delete form'));
ok('script.swallow low in a data source', h2('script.swallow', 'everything', f => f.sev === 'low'));
ok('form.field.unused: notes, not a readonly display field', h2('form.field.unused', 'Reset form', f => f.p.field === 'notes') && !h2('form.field.unused', 'Reset form', f => f.p.field === 'shown'));
ok('form.field.unused: fields feeding a data source count as used', !h2('form.field.unused', 'Reset form', f => f.p.field === 'searchValue'));
ok('script.unbounded on -Filter * without input or limit (low when scoped)', h2('script.unbounded', 'everything', f => f.sev === 'low') && !h2('script.unbounded', 'cloudy'));
const t3 = L.analyse({ kind: 'helloid-sa-config', dataSources: [S('u1', 'star', 'try {\n  $s = $datasource.searchValue\n  if ($s -eq "*") { $f = "Name -like \'*\'" } else { $f = "Name -like \'*$s*\'" }\n  Get-ADUser -Filter $f | Select-Object DisplayName\n} catch { Write-Error $_ }')],
  dynamicForms: [], delegatedForms: [], products: [], variables: [] });
ok('script.unbounded medium on the "*" path without OU', t3.findings.some(f => f.rule === 'script.unbounded' && f.sev === 'medium'));
ok('script.scope also when no selection is fed', t3.findings.some(f => f.rule === 'script.scope'));
ok('form.validation on samAccountName without length', h2('form.validation', 'Reset form', f => f.p.field === 'samAccountName'));
ok('product.norevoke on grant without return', h2('product.norevoke', 'Grant only') && !h2('product.norevoke', 'Good product'));
ok('product.return.empty on a return that only logs', h2('product.return.empty', 'Empty return'));
ok('product.leaver when return on disable is off', h2('product.leaver', 'Empty return') && !h2('product.leaver', 'Good product'));
ok('product.instant on a risky product', h2('product.instant', 'Grant only') && !h2('product.instant', 'Good product'));

console.log(fails.join('\n'));
console.log(`salint: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
