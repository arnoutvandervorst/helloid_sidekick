#!/usr/bin/env python3
"""Pull the Service Automation *configuration* out of a HelloID tenant, for the Scripts view.

helloid-export.py answers "who holds which product". This one answers "how is it built":
every PowerShell script (data sources, delegated form tasks, product tasks and actions,
scheduled tasks), every dynamic form schema, and the variable library — so the dashboard
can lint them: cloned scripts that drifted apart, grids whose columns the data source does
not deliver, a date field a checkbox reveals but nobody has to fill in, variables spelled
three ways or never given a value.

    python3 helloid-sa-export.py

Same credentials as helloid-export.py (the 'api' profile in helloid-config.json; read
access is enough). Writes one file, next to this script unless -o says otherwise:

    helloid-sa-config.json

Secrets stay out: the variable library's secret values are never in the file (the API
masks them anyway; this script drops whatever comes back), and neither are secret local
task variables. Provisioning scripts are not part of it — the API does not return them.

Runtime: when the same profile also holds the Elastic audit-log credentials (the ones
helloid-audit.py uses), the file carries the Service Automation events of the last
--log-days days (default 90; 0 skips): forms opened and submitted, product requests and
approvals, and the log lines tasks write with Write-Information -Tags "Audit" (IsError
marks a failure). That is how the dashboard shows which forms actually fail. Submitted
form data is never copied: it can hold passwords.

Authentication is the documented scheme: Authorization: Basic base64(key:secret).
Nothing is written to the terminal that carries the credential.
"""
import argparse
import base64
import datetime as dt
import importlib.util
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helloid_creds  # noqa: E402  (next to this script)

PRODUCT_EVENTS = ('onRequest', 'onApprove', 'onDeny', 'onReturn', 'onWithdrawn')
MASK = '***'
# Audit-log index patterns per bucket in the output. sa-form* is opened/submitted, sa-audit*
# the task log lines, sa-request*/sa-approval* the product request lifecycle.
SA_LOG_SOURCES = [('sa-form*', 'forms'), ('sa-audit*', 'audit'), ('sa-request*', 'requests'), ('sa-approval*', 'approvals')]
# Submitted form data can hold passwords; it never leaves the tenant through this file.
SA_LOG_DROP = {'tenant', 'tid', 'formData', 'formValues', 'form'}


class HelloID:
    def __init__(self, base, key, secret, insecure=False):
        self.base = base.rstrip('/')
        if not self.base.endswith('/api/v1'):
            self.base += '/api/v1'
        pair = f'{key}:{secret}'.encode('ascii')
        self.auth = 'Basic ' + base64.b64encode(pair).decode('ascii')
        self.ctx = ssl._create_unverified_context() if insecure else None

    def get(self, path, params=None, missing_ok=False):
        """GET with a short retry on 429/5xx. Returns None for a 404 when missing_ok."""
        url = self.base + path
        if params:
            url += '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            'Authorization': self.auth,
            'Accept': 'application/json',
            'User-Agent': 'helloid-sidekick-export/1.0'
        })
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, context=self.ctx, timeout=120) as res:
                    raw = res.read().decode('utf-8')
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as e:
                if e.code == 404 and missing_ok:
                    return None
                if (e.code == 429 or e.code >= 500) and attempt < 3:
                    time.sleep(2 ** (attempt + 1))
                    continue
                body = e.read().decode('utf-8', 'replace')[:400]
                raise SystemExit(f'{path} -> HTTP {e.code} {e.reason}\n{body}')
            except urllib.error.URLError as e:
                raise SystemExit(f'{path} -> {e.reason}')


def unwrap(data):
    """Lists come back bare, as {data:[..]} or {pageData:[..]}; detail calls sometimes as a 1-item list."""
    if isinstance(data, dict):
        for k in ('data', 'pageData', 'items'):
            if isinstance(data.get(k), list):
                return data[k]
    return data if isinstance(data, list) else []


def one(data):
    return data[0] if isinstance(data, list) and data else data


def progress(label, i, n):
    end = '\r' if sys.stdout.isatty() else '\n'
    if sys.stdout.isatty() or i == n:
        print(f'  {label}: {i}/{n}', end=end if i < n else '\n', flush=True)


def is_system_variable(v):
    value = str(v.get('value') or '')
    return value.startswith('{{') and value.endswith('}}')


def mask_variables(items):
    """Secret values never leave the tenant through this file."""
    out = []
    for v in items or []:
        v = dict(v)
        if v.get('secret') in (True, 'True', 'true'):
            v['value'] = MASK if v.get('value') not in (None, '') else ''
        out.append(v)
    return out


def elastic_creds(args):
    """The Elastic audit-log credentials, only when they are already saved or in the
    environment: the configuration export never stops to ask for a second key."""
    fields = [f[0] for f in helloid_creds.KINDS['elastic']['fields']]
    data = helloid_creds.load()
    name = args.profile or data.get('default')
    prof = data['profiles'].get(name) if name else None
    if prof and all(prof.get(f) for f in fields):
        return helloid_creds._pack(prof, fields, name)
    env = helloid_creds.load_env(args.env)
    vals = [os.environ.get(e) or env.get(e) for _f, e, _l, _h in helloid_creds.KINDS['elastic']['fields']]
    return helloid_creds._pack(dict(zip(fields, vals)), fields, None) if all(vals) else None


def trim(row):
    for k in SA_LOG_DROP:
        row.pop(k, None)
    for k, v in list(row.items()):
        if isinstance(v, str) and len(v) > 1000:
            row[k] = v[:1000] + '…'
    return row


def collect_activity(args):
    """Service Automation events from the audit log, or None when there is no Elastic key."""
    if args.log_days <= 0:
        return None
    creds = elastic_creds(args)
    if not creds:
        print('  activity: skipped (no Elastic audit-log key in this profile; run helloid-audit.py --setup once to add it)')
        return None
    spec = importlib.util.spec_from_file_location('helloid_audit', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'helloid-audit.py'))
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    es = audit.Elastic(creds['url'], creds['key'], creds['secret'], insecure=args.insecure)
    end = dt.datetime.now(dt.timezone.utc).replace(microsecond=0) + dt.timedelta(minutes=1)
    start = end - dt.timedelta(days=args.log_days)
    out = {'from': audit.iso(start), 'to': audit.iso(end), 'days': args.log_days}
    for pattern, bucket in SA_LOG_SOURCES:
        try:
            rows = es.window(pattern, start, end, None, {'rows': 0, 'splits': 0})
        except (Exception, SystemExit) as e:
            # A rejected audit-log key must not cost the configuration export.
            print(f'  activity: skipped ({e}); check the Elastic URL, key and secret with helloid-audit.py --setup')
            return None
        if sys.stdout.isatty():
            print('\r' + ' ' * 100 + '\r', end='')
        out[bucket] = [trim(r) for r in rows]
        print(f'  activity {pattern}: {len(rows)}')
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('-o', '--out', default=os.path.dirname(os.path.abspath(__file__)), help='output directory (default: next to the script)')
    p.add_argument('--insecure', action='store_true', help='skip TLS verification (test tenants)')
    p.add_argument('--log-days', type=int, default=90, help='days of Service Automation audit-log events to include (default 90; 0 skips)')
    helloid_creds.add_arguments(p)
    args = p.parse_args()

    creds = helloid_creds.resolve('api', args)
    api = HelloID(creds['url'], creds['key'], creds['secret'], args.insecure)
    tenant = urllib.parse.urlparse(api.base).netloc
    print(f'Tenant {tenant}')

    # Variable library (global variables). System ones resolve to {{...}} placeholders.
    variables = []
    for v in mask_variables(unwrap(api.get('/automation/variables'))):
        v['isSystem'] = is_system_variable(v)
        variables.append(v)
    print(f'  variables: {len(variables)}')

    # Data sources: the list has no script, the detail call does.
    ds_list = unwrap(api.get('/datasource/all'))
    data_sources = []
    for i, d in enumerate(ds_list, 1):
        detail = one(api.get(f"/datasource/{d['dataSourceGUID']}", missing_ok=True)) or d
        data_sources.append({**d, **detail})
        progress('data sources', i, len(ds_list))

    # Dynamic forms: the list has no schema. GET by the GUID serves the latest version.
    form_list = unwrap(api.get('/forms', {'take': 10000}))
    dynamic_forms = []
    for i, f in enumerate(form_list, 1):
        detail = api.get(f"/forms/{f['dynamicFormGUID']}", missing_ok=True) or f
        dynamic_forms.append({**f, **detail})
        progress('dynamic forms', i, len(form_list))

    # Delegated forms with their task script, access groups and categories.
    df_list = unwrap(api.get('/delegatedforms'))
    delegated_forms = []
    for i, f in enumerate(df_list, 1):
        detail = api.get(f"/delegatedforms/{f['delegatedFormGUID']}", missing_ok=True) or f
        delegated_forms.append({**f, **detail})
        progress('delegated forms', i, len(df_list))
    df_categories = unwrap(api.get('/delegatedformcategories'))

    # Products: no take (paging on /products is ordered by name without a tiebreaker and can
    # drop same-named products). The detail call carries actions and the event task scripts.
    product_list = unwrap(api.get('/products'))
    products = []
    for i, pr in enumerate(product_list, 1):
        detail = api.get(f"/products/{pr['productId']}", missing_ok=True) or pr
        merged = {**pr, **detail}
        for ev in PRODUCT_EVENTS:
            for task in merged.get(ev) or []:
                task['variables'] = mask_variables(task.get('variables'))
        products.append(merged)
        progress('products', i, len(product_list))
    product_categories = unwrap(api.get('/selfservice/categories', missing_ok=True))

    # A delegated form or product can point at an older version of its dynamic form; the
    # list only names the latest and the original GUID, HelloID serves the latest for any.
    by_guid = {}
    for f in dynamic_forms:
        for k in ('dynamicFormGUID', 'formOriginalGUID'):
            if f.get(k): by_guid[f[k].lower()] = f
    wanted = [d.get('dynamicFormGUID') for d in delegated_forms] + \
             [(pr.get('dynamicForm') or {}).get('id') or (pr.get('dynamicForm') or {}).get('dynamicFormGUID') for pr in products]
    for guid in {g.lower() for g in wanted if g} - set(by_guid):
        latest = api.get(f'/forms/{guid}', missing_ok=True)
        hit = isinstance(latest, dict) and by_guid.get((latest.get('dynamicFormGUID') or '').lower())
        if hit:
            hit.setdefault('versionGUIDs', []).append(guid)

    # Scheduled tasks, including disabled ones (the API hides those by default).
    task_list = unwrap(api.get('/automationtasks', {'includeDisabledTasks': 'true'}))
    scheduled_tasks = []
    for i, t in enumerate(task_list, 1):
        guid = t.get('automationTaskGuid') or t.get('automationTaskGUID')
        detail = api.get(f'/automationtasks/{guid}', missing_ok=True) or t
        merged = {**t, **detail}
        merged['variables'] = mask_variables(merged.get('variables'))
        scheduled_tasks.append(merged)
        progress('scheduled tasks', i, len(task_list))

    agent_pools = unwrap(api.get('/agentpools', missing_ok=True))
    activity = collect_activity(args)

    os.makedirs(args.out, exist_ok=True)
    out_file = os.path.join(args.out, 'helloid-sa-config.json')
    with open(out_file, 'w', encoding='utf-8') as fh:
        json.dump({
            'kind': 'helloid-sa-config',
            'version': 1,
            'collectedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'tenant': tenant,
            'variables': variables,
            'dataSources': data_sources,
            'dynamicForms': dynamic_forms,
            'delegatedForms': delegated_forms,
            'delegatedFormCategories': df_categories,
            'products': products,
            'productCategories': product_categories,
            'scheduledTasks': scheduled_tasks,
            'agentPools': agent_pools,
            'activity': activity
        }, fh, indent=1, ensure_ascii=False)

    scripts = (sum(1 for d in data_sources if d.get('script'))
               + sum(1 for f in delegated_forms if (f.get('task') or {}).get('script'))
               + sum(1 for pr in products for ev in PRODUCT_EVENTS for t in (pr.get(ev) or []) if t.get('script')))
    print(f'\n{out_file}: {len(delegated_forms)} delegated forms, {len(dynamic_forms)} dynamic forms, '
          f'{len(data_sources)} data sources, {len(products)} products, {len(scheduled_tasks)} scheduled tasks, '
          f'{scripts} PowerShell scripts, {len(variables)} variables. Drop it on the dashboard under Imports.')


if __name__ == '__main__':
    main()
