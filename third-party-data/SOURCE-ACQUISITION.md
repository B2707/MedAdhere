# Frozen source acquisition and recovery

This directory commits provenance, reviewed rights, transformations, and exact file hashes. Raw
third-party bytes remain ignored. A manifest marked `active` means its exact bytes and rights have
been reviewed and it is eligible for activation; it does not mean that a database import or deploy
has occurred.

## Required escrow before deleting the source workspace

DDInter publishes mutable download names and restricts redistribution. Its exact reviewed bytes
therefore need an operator-controlled, access-restricted escrow outside Git. MedlinePlus publishes
only the six most recent daily health-topic files, so escrow its reviewed dated file as well even
though redistribution is allowed. CCDD's active full CSV snapshot is also ignored locally, so
escrow its five exact files. The bounded openFDA and Health Canada selections are committed and do
not need a separate raw archive.

Choose a private absolute directory and keep it outside any synced/public folder:

```bash
export MEDADHERE_SOURCE_ARCHIVE=/absolute/private/path/medadhere-source-archive
install -d -m 0700 "$MEDADHERE_SOURCE_ARCHIVE/ddinter/download-snapshot-2026-08-11"
install -d -m 0700 "$MEDADHERE_SOURCE_ARCHIVE/medlineplus/2026-08-08"
install -d -m 0700 "$MEDADHERE_SOURCE_ARCHIVE/ccdd/2026-08-05"

for file_name in \
  ddinter_downloads_code_A.csv \
  ddinter_downloads_code_B.csv \
  ddinter_downloads_code_D.csv \
  ddinter_downloads_code_H.csv \
  ddinter_downloads_code_L.csv \
  ddinter_downloads_code_P.csv \
  ddinter_downloads_code_R.csv \
  ddinter_downloads_code_V.csv
do
  install -m 0600 \
    "third-party-data/ddinter/2026-08-11/raw/$file_name" \
    "$MEDADHERE_SOURCE_ARCHIVE/ddinter/download-snapshot-2026-08-11/$file_name"
done

install -m 0600 \
  third-party-data/medlineplus/2026-08-08/raw/mplus_topics_2026-08-08.xml \
  "$MEDADHERE_SOURCE_ARCHIVE/medlineplus/2026-08-08/mplus_topics_2026-08-08.xml"

for file_name in mp.csv ntp.csv tm.csv mp-ntp-tm-en.csv mp-ntp-tm-fr.csv
do
  install -m 0600 \
    "third-party-data/ccdd/2026-08-05/raw/$file_name" \
    "$MEDADHERE_SOURCE_ARCHIVE/ccdd/2026-08-05/$file_name"
done
```

Do not treat an archive copy as valid until the exact-manifest dry runs below pass from a clean
restoration.

## Restore into a fresh clone

```bash
test -n "$MEDADHERE_SOURCE_ARCHIVE" || { echo 'MEDADHERE_SOURCE_ARCHIVE is required' >&2; exit 1; }
install -d -m 0700 third-party-data/ddinter/2026-08-11/raw
install -d -m 0700 third-party-data/medlineplus/2026-08-08/raw
install -d -m 0700 third-party-data/ccdd/2026-08-05/raw

for file_name in \
  ddinter_downloads_code_A.csv \
  ddinter_downloads_code_B.csv \
  ddinter_downloads_code_D.csv \
  ddinter_downloads_code_H.csv \
  ddinter_downloads_code_L.csv \
  ddinter_downloads_code_P.csv \
  ddinter_downloads_code_R.csv \
  ddinter_downloads_code_V.csv
do
  install -m 0600 \
    "$MEDADHERE_SOURCE_ARCHIVE/ddinter/download-snapshot-2026-08-11/$file_name" \
    "third-party-data/ddinter/2026-08-11/raw/$file_name"
done

install -m 0600 \
  "$MEDADHERE_SOURCE_ARCHIVE/medlineplus/2026-08-08/mplus_topics_2026-08-08.xml" \
  third-party-data/medlineplus/2026-08-08/raw/mplus_topics_2026-08-08.xml

for file_name in mp.csv ntp.csv tm.csv mp-ntp-tm-en.csv mp-ntp-tm-fr.csv
do
  install -m 0600 \
    "$MEDADHERE_SOURCE_ARCHIVE/ccdd/2026-08-05/$file_name" \
    "third-party-data/ccdd/2026-08-05/raw/$file_name"
done
```

Use the project's pinned Node 24 runtime and its installed local `tsx`; do not let `npx` download an
unreviewed executable during source verification. Run both importers without `--apply`:

```bash
node -e "if (process.versions.node.split('.')[0] !== '24') process.exit(1)" || {
  echo 'Node 24 is required; activate the version pinned by .nvmrc' >&2
  exit 1
}
test -x node_modules/.bin/tsx || {
  echo 'Install the lockfile first with npm ci' >&2
  exit 1
}
node_modules/.bin/tsx scripts/import-ddinter-release.ts \
  --manifest third-party-data/ddinter/2026-08-11/MANIFEST.json
node_modules/.bin/tsx scripts/import-medlineplus-release.ts \
  --manifest third-party-data/medlineplus/2026-08-08/MANIFEST.json
node_modules/.bin/tsx scripts/import-ccdd-release.ts \
  --manifest third-party-data/ccdd/2026-08-05/MANIFEST.json
node_modules/.bin/tsx scripts/import-openfda-label-release.ts \
  --manifest third-party-data/openfda/reviewed-labels-2026-08-11/MANIFEST.json
node_modules/.bin/tsx scripts/import-health-canada-release.ts \
  --manifest third-party-data/health-canada/reviewed-dpd-2026-08-11/MANIFEST.json
```

These commands verify every source file's byte count and SHA-256, the official-terms snapshot, the
transformation source, declared row counts, and source-specific structure before any database is
opened. A mismatch is a hard failure. Never update a manifest hash merely to accept different
upstream bytes; different bytes are a new release requiring a new directory and rights review.

## Official reacquisition fallback

The exact official file URLs are recorded per file in each active `MANIFEST.json`. A rights-authorized
operator may reacquire from those HTTPS URLs only when the escrow is unavailable. The download must
be placed at the manifest path and pass the same dry run. DDInter URLs are mutable and MedlinePlus
retains only recent dated files, so upstream availability is not an exact-byte preservation strategy.
If the pinned checksum no longer matches, stop and create a separately reviewed release; do not
substitute it for the active snapshot.

## Explicit database-activation credential path

Database activation is a local operator action, not a Lambda. The stack output
`SourceImportDbSecretArn` identifies the generated `medadhere_source_import` credential. That role can
activate and supersede reviewed source releases, but it cannot read patient data, delete rows, create
objects, or access sequences. The secret is granted to schema-init for role/password alignment and to
no runtime Lambda.

First follow `scripts/ops-runbook-06.md` section "Shared operator prerequisites — discover resources
and open the RDS tunnel" to discover the RDS hostname and bastion and open the foreground SSM tunnel.
Do not use the admin secret selected by that general-purpose runbook. In the operator terminal, replace
`DB_SECRET_ARN` with the dedicated stack output and retain the tunnel-specific TLS server name:

```bash
export AWS_REGION=us-east-1
export STACK=MedAdhereFoundation
export DB_SECRET_ARN
DB_SECRET_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='SourceImportDbSecretArn'].OutputValue | [0]" \
  --output text)
test -n "$DB_SECRET_ARN" && test "$DB_SECRET_ARN" != 'None'

export DB_HOST=127.0.0.1
export DB_PORT=5432
export DB_NAME=medadhere
export DB_TLS_SERVERNAME="$RDS_HOST"
test -n "$DB_TLS_SERVERNAME"
```

The operator identity needs `secretsmanager:GetSecretValue` on that one output ARN plus the bounded
CloudFormation/RDS/EC2/SSM discovery and tunnel permissions documented in the runbook. Do not grant the
source-import secret to a Lambda or substitute the broader admin/application credential.

Database activation remains a separate approval gate. Add `--apply` to exactly one verified importer
only after its dry run passes and the database connection, reviewed release, and activation have all
been explicitly approved. Stop the bastion immediately after the activation and verification finish.
