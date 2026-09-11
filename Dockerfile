# The app is static: no build, no runtime, no back end. nginx serves the folder so the
# browser gets a real origin, which is what enables snapshot storage — opened from a file
# path the same page gets an opaque origin and IndexedDB is refused.
FROM nginx:1.30-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
COPY assets/ /usr/share/nginx/html/assets/
# Generated fiction (make-demo-set.py). The only exports that may be served.
COPY demo/ /usr/share/nginx/html/demo/
# The collector scripts and their consent explainer, so the Imports view can offer
# them for download. They read data; they never carry any.
COPY collect-ad.ps1 collect-entra.ps1 /usr/share/nginx/html/
# The HelloID collectors (REST API and Elastic audit log) and their credential helpers.
# They ask for a key at run time; none is inside them.
COPY helloid-export.py helloid-audit.py helloid_creds.py helloid-export.ps1 helloid-audit.ps1 HelloIDCreds.ps1 /usr/share/nginx/html/
COPY docs/ENTRA-CONSENT.md /usr/share/nginx/html/docs/
# The restore scripts for the rollback pack. They write only what a pack tells them to,
# and only with -Apply; the pack itself never passes through here.
COPY restore-ad.ps1 restore-entra.ps1 /usr/share/nginx/html/

# Deliberately absent: *.csv, vault*.json and dist/. Exports carry account, person and
# contract data and have no business on a public host.
