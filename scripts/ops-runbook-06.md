# OPS Runbook — Phase 6 (OPS-03 pre-deploy gate + DASH-06 export + D14 cohort workflow)

Plan 06-07. **This file is documentation only — nothing here runs in CI or during `cdk synth`.**
Every command below is a **manual, deploy-time** step the operator runs against a live stack (the same
posture as `ops-runbook-05.md`). Region is `us-east-1`; the stack is `MedAdhereFoundation`.

The steps are ordered as the Phase-7 operator actually runs them: **(0) gate + §0b pre-create checks
→ (1) create (`validationWindow=true`, every cycle) + §1a bootstrap → (2) wipe →
(3) enroll → (4) verify on the dashboard (+ §4a SC1 evidence capture, validation cycle) →
(5) export → (6) teardown (+ §6a leak-check, §6b Twilio purge + post-purge SSM deletion, §6c
retained-export obligation).**
Cycles are system-identical; only the data ceremony differs — see the §1b checklist.

---

## 0. OPS-03 — the pre-deploy blocking gate (run BEFORE every `cdk deploy`)

Run the local regression bar from the repo root and let it finish green before you deploy anything.
The dependency-audit stage needs npm advisory network access:

The current Testcontainers 12/Undici 8 development toolchain requires Node 22.19 or newer. Use the project's bundled Node 24 operator runtime for the predeploy gate and CDK commands. This local toolchain choice does not change the Lambda runtime declared in the synthesized stack.

```sh
npm run predeploy        # → node scripts/predeploy-gate.mjs
```

It runs **eleven stages in seven ordered groups, fail-fast** — the first nonzero stage stops the run and
exits nonzero (that is the "blocks" contract; the deploy is NOT cleared until this exits 0):

| Group | Stage | Command |
|---|---|---|
| guards | `guard:no-pg` | `node dashboard/scripts/check-no-pg.mjs` |
| guards | `guard:eval-csv` | `node scripts/check-eval-csv-guard.mjs` |
| dependency audit | `audit-ci` | `npx audit-ci --config audit-ci.jsonc` |
| typecheck | `typecheck:backend` | `npm run typecheck --workspace backend` |
| typecheck | `typecheck:infra` | `npm run typecheck --workspace infra` |
| typecheck | `typecheck:dashboard` | `npm run typecheck --workspace dashboard` |
| typecheck | `typecheck:packages/shared` | `npm run typecheck --workspace packages/shared` |
| lint | `lint` | `npm run lint` |
| production build | `dashboard-build` | `npm run build -w @medadhere/dashboard` |
| regression | `ops-03-regression` | `npx vitest run backend/src/inbound backend/src/enroll backend/src/classifier backend/src/timeout` |
| infrastructure | `cdk-synth` | `npx cdk synth --quiet` from `infra/` |

`audit-ci` reads the dated allowlist in `audit-ci.jsonc`; any new high-or-critical advisory remains
blocking. `cdk-synth` is also the cdk-nag AwsSolutions gate (`bin/medadhere.ts` applies `nag.ts`).

**Docker / `TEST_DATABASE_URL` prerequisite for `ops-03-regression`.** The classifier and timeout lanes
include real-PostgreSQL contract tests (testcontainers `postgres:16`). They **fail loud in `beforeAll`** if
there is neither a running Docker daemon nor a CI-style `TEST_DATABASE_URL` pointing at a reachable PG16.
Before running the gate: start Docker Desktop (or `export TEST_DATABASE_URL=postgres://…`), or
`ops-03-regression` will block.

This gate is a **named, reproducible** bar, distinct from CI. CI (`.github/workflows/ci.yml`) keeps its own
full quality job on every PR/push to `main`; the gate is the operator's local pre-deploy checkpoint. It is
never wired into an automated path (INFRA-04 clean-teardown depends on that).

### Required AWS target guards (guard split — account guard + stack guard)

Run this block in every terminal used for live AWS work. Replace both placeholders from the approved
operator record. `EXPECTED_AWS_ACCOUNT` must be typed independently; do not derive it from STS. There
are TWO guards (Phase-7 pre-exec gate, C1): **`confirm_medadhere_account`** pins the region, confirms
the caller identity, and requires the typed account id — it works when the stack does NOT exist, so use
it before the FIRST `cdk deploy` of a cycle and for all post-destroy work (§6a leak-check, snapshot
deletion). **`confirm_medadhere_target`** adds the deployed-stack ARN check — use it for every mutation
against an existing stack. Every mutating recipe below calls the applicable guard again immediately
before the mutation.

```sh
export AWS_PROFILE='<APPROVED MEDADHERE AWS PROFILE>'
export AWS_REGION='us-east-1'
export AWS_DEFAULT_REGION="$AWS_REGION"
export EXPECTED_AWS_ACCOUNT='<EXPECTED 12-DIGIT AWS ACCOUNT ID>'
export STACK='MedAdhereFoundation'

confirm_medadhere_account() {
  test "$AWS_REGION" = 'us-east-1' || {
    echo "Refusing: AWS_REGION must be us-east-1" >&2
    return 1
  }
  actual_account=$(aws sts get-caller-identity --query Account --output text) || return 1
  test "$actual_account" = "$EXPECTED_AWS_ACCOUNT" || {
    echo "Refusing: current AWS account does not match EXPECTED_AWS_ACCOUNT" >&2
    return 1
  }
  aws sts get-caller-identity
  printf 'Type the expected AWS account ID to continue: '
  read -r confirmed_account
  test "$confirmed_account" = "$EXPECTED_AWS_ACCOUNT"
}

confirm_medadhere_target() {
  confirm_medadhere_account || return 1
  stack_arn=$(aws cloudformation describe-stacks \
    --stack-name "$STACK" --query 'Stacks[0].StackId' --output text) || return 1
  case "$stack_arn" in
    "arn:aws:cloudformation:${AWS_REGION}:${EXPECTED_AWS_ACCOUNT}:stack/${STACK}/"*) ;;
    *) echo "Refusing: stack ARN does not match the approved target" >&2; return 1 ;;
  esac
}

confirm_medadhere_target || exit 1   # first deploy of a cycle: confirm_medadhere_account || exit 1
```

### 0b. Pre-create checks (ACCOUNT guard — run BEFORE every cycle's first `cdk deploy`)

Three account-level preconditions the create consumes or collides with (round-2 gate, R2-5). All
fail-closed: do not run `cdk deploy` until every check passes.

```sh
confirm_medadhere_account || exit 1

# 1. SSM params exist — recreate if absent. /medadhere/test-recipient is consumed AT DEPLOY TIME as a
#    CFN dynamic reference: a missing param fails the create. Both survive destroy, but §6a deletes
#    them at project end — recreate before any later demo cycle.
aws ssm get-parameter --name /medadhere/twilio-from --query Parameter.Name --output text \
  || aws ssm put-parameter --name /medadhere/twilio-from --type String --value '<project number E.164>'
aws ssm get-parameter --name /medadhere/test-recipient --query Parameter.Name --output text \
  || aws ssm put-parameter --name /medadhere/test-recipient --type String --value '<test recipient E.164>'

# 2. Cognito domain released — the deterministic `medadhere-auth` domain must be free or the create fails:
aws cognito-idp describe-user-pool-domain --domain medadhere-auth \
  --query 'DomainDescription.Status' --output text   # must be empty/None — else release it first (§6a)

# 3. Persistent secrets USABLE (A3; post-exec gate CG-1/M4) — exist, NOT pending deletion, and carry
#    the JSON shape runtime needs (Twilio consumers need accountSid AND authToken; the classifier
#    needs a nonempty apiKey). `cdk deploy` is green even if these are absent/bad — the stack only
#    references them by name — so THIS is the deploy-time gate. Values are never printed:
for S in medadhere/twilio medadhere/anthropic; do
  DEL=$(aws secretsmanager describe-secret --secret-id "$S" --query DeletedDate --output text) \
    && test "$DEL" = "None" \
    || { echo "secret $S MISSING or PENDING DELETION — run block 1b (or restore) before deploy" >&2; exit 1; }
done
aws secretsmanager get-secret-value --secret-id medadhere/twilio --query SecretString --output text \
  | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('accountSid') and d.get('authToken'), 'twilio secret shape BAD (needs accountSid AND authToken)'; print('twilio shape OK')" \
  || exit 1
aws secretsmanager get-secret-value --secret-id medadhere/anthropic --query SecretString --output text \
  | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('apiKey'), 'anthropic secret shape BAD (needs nonempty apiKey)'; print('anthropic shape OK')" \
  || exit 1
```

---

## 1. Deploy recipe (D11 — Vercel is the host of record; Amplify gated off)

The **stack** deploys from CDK with hosting gated off; the **dashboard host** is Vercel (outside CDK).

> **Dated note (2026-07-30, user decision — "the demo should be live"; supersedes this section's
> former two-stage create-`false`-then-flip-`true` ritual, Phase-7 pre-exec gate C1):** EVERY deploy
> — demo or validation — ships the identical full system: `-c validationWindow=true` + a real
> billing email (the WR-01 guard hard-fails a window deploy that still ships the `.invalid` placeholder,
> ops-runbook-05 §3). Protections are on from birth — the accepted posture. The C1 guard split
> survives unchanged: the ACCOUNT guard covers the first create (the stack guard cannot check a
> stack that does not exist). **Recovery for a failed FIRST create:** in the CloudFormation console,
> disable the stack's termination protection, then delete the failed stack (if the create got as far
> as the DB instance, clear its deletion protection in the RDS console first). The ONLY
> `validationWindow=false` deploy in the lifecycle is the §6.3 teardown revert.

```sh
# THE deploy (every cycle, demo or validation — the identical full system; §1b's data ceremony is
# the only per-cycle difference). §0b pre-create checks must be green first (the deploy consumes
# /medadhere/test-recipient as a CFN dynamic reference).
confirm_medadhere_account || exit 1     # first deploy of the cycle: no stack exists yet
                                        # (redeploys against a live stack: confirm_medadhere_target)
cd infra
# Amplify hosting constructs stay in-stack but are NOT deployed (deployHosting=false).
npx cdk deploy -c deployHosting=false \
  -c validationWindow=true \
  -c billingEmail=<real ops email> \
  --require-approval never
cd ..
# → now run the §1a post-deploy bootstrap and smoke-verify BEFORE any further step.
# Validation cycle: then proceed §2 wipe → DATA-02 snapshot → §3 enrollment.
```

### 1a. Post-deploy bootstrap (MANDATORY after EVERY fresh create — the stack is dead until this runs)

> **Dated note (2026-07-30, user decision — "add them once and keep them there"; A3, supersedes the
> former per-cycle placeholder refill):** `medadhere/twilio` + `medadhere/anthropic` are
> **OUT-OF-STACK persistent secrets** — created ONCE (block 1b below, values from the Keychain),
> surviving `cdk destroy`; the stack references them by name (`Secret.fromSecretNameV2`). The
> per-cycle step is now the fail-closed EXISTENCE check (step 1). Standing cost ≈ $0.40/secret/mo
> while they exist; deleted only at project end (§6a row, recovery-window caution F15).

A fresh deploy ships a **new** `InboundUrl` and a **new** Cognito pool/client + data-API URL.
SMS and the classifier are dead until this block completes, in order. OPS-02 intentionally creates
no SNS topic, subscription, or alarm action under the 2026-08-04 user decision.

```sh
confirm_medadhere_target || exit 1

# 1. Persistent-secret check — EVERY cycle, fail-closed (A3): both secrets must exist and must NOT
#    be inside a deletion recovery window (DescribeSecret still succeeds there while GetSecretValue
#    fails — CG-1). If either is missing, run the ONE-TIME creation block 1b, then re-run. The
#    content/shape gate is §0b check 4 (run this same sitting, pre-create); if §0b was skipped,
#    run its check 4 now — a name-only pass is NOT sufficient.
for S in medadhere/twilio medadhere/anthropic; do
  DEL=$(aws secretsmanager describe-secret --secret-id "$S" --query DeletedDate --output text) \
    && test "$DEL" = "None" \
    || { echo "persistent secret $S MISSING or PENDING DELETION — run block 1b / restore first" >&2; exit 1; }
done
```

```sh
# 1b. ONE-TIME creation (only if the step-1 check fails — normally once for the whole project).
#    Values come from the Keychain: the Anthropic key from the `medadhere-anthropic` item; the
#    Twilio creds from `medadhere-twilio-sid` / `medadhere-twilio-token` (stored 2026-07-30 per the
#    07-01 housekeeping item). The former Twilio MCP API key was revoked on 2026-08-04 after its
#    command arguments appeared in tool-health output; do not recreate or use that MCP path. Same
#    staging hygiene as before (R2-6/R3-4): FILES only (never inline — argv/shell-history leak),
#    interruption-safe prefix-named staging dir; every read and file write aborts on failure; one
#    cleanup() (validate path prefix → rm -rf → unset every credential var) runs on EXIT, and on
#    HUP/INT/TERM it runs then exits 1 — a signal must never resume the sequence.
umask 077
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/medadhere-secret-stage.XXXXXX") \
  || { echo 'staging mktemp FAILED — abort' >&2; exit 1; }
cleanup() {
  case "$STAGE" in
    *medadhere-secret-stage.*) rm -rf "$STAGE" ;;
    *) echo "refusing rm -rf: unexpected STAGE path '$STAGE'" >&2 ;;
  esac
  unset TW_SID TW_TOK ANT_KEY STAGE
}
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM
TW_SID=$(security find-generic-password -s medadhere-twilio-sid -w) && test -n "$TW_SID" \
  || { echo 'Keychain retrieval of medadhere-twilio-sid FAILED — abort' >&2; exit 1; }
TW_TOK=$(security find-generic-password -s medadhere-twilio-token -w) && test -n "$TW_TOK" \
  || { echo 'Keychain retrieval of medadhere-twilio-token FAILED — abort' >&2; exit 1; }
ANT_KEY=$(security find-generic-password -s medadhere-anthropic -w) && test -n "$ANT_KEY" \
  || { echo 'Keychain retrieval of medadhere-anthropic FAILED — abort' >&2; exit 1; }
printf '{"accountSid":"%s","authToken":"%s"}' "$TW_SID" "$TW_TOK" > "$STAGE/twilio.json" \
  || { echo 'twilio.json write FAILED — abort' >&2; exit 1; }
printf '{"apiKey":"%s"}' "$ANT_KEY" > "$STAGE/anthropic.json" \
  || { echo 'anthropic.json write FAILED — abort' >&2; exit 1; }
unset TW_SID TW_TOK ANT_KEY
chmod 600 "$STAGE"/*.json && ls -l "$STAGE"   # verify 0600 on both files before any create
aws secretsmanager create-secret --name medadhere/twilio \
  --secret-string "file://$STAGE/twilio.json" \
  || { echo 'twilio create-secret FAILED — abort, do not continue the bootstrap' >&2; exit 1; }
aws secretsmanager create-secret --name medadhere/anthropic \
  --secret-string "file://$STAGE/anthropic.json" \
  || { echo 'anthropic create-secret FAILED — abort, do not continue the bootstrap' >&2; exit 1; }
cleanup; trap - EXIT HUP INT TERM
# NEVER `aws secretsmanager delete-secret` these persistent secrets mid-project: deletion schedules
# a recovery window during which the name is reserved (blocking recreation and the stack's by-name
# reference). They are deleted ONLY at project end (§6a row) with
# `delete-secret --force-delete-without-recovery` — the F15 caution. If a mid-project deletion ever
# happens, recover the name with `--force-delete-without-recovery`, then re-run block 1b.
```

```sh
# 2. SSM params — already verified/recreated in §0b BEFORE the create (the deploy consumes
#    /medadhere/test-recipient as a CFN dynamic reference); re-read here only if in doubt.

# 3. Twilio inbound-webhook re-point: the endpoint is FRESH every cycle. Read it, then update the
#    Twilio number's "A message comes in" URL through the secret-safe REST procedure. The Twilio MCP
#    is retired by the 2026-08-04 credential-incident ruling because its stdio arguments were exposed
#    by health output. The doctrine is unchanged: explicit user confirmation before any real send.
#    StatusCallback self-heals (sent per-message) — no step needed.
aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='InboundUrl'].OutputValue" --output text

# 4. Cognito: recreate the admin (per-cycle — the pool is new each time), then the single-admin
#    TOTP enrollment (section below). Cognito EMAILS a one-time temporary password to ADMIN_EMAIL;
#    the TOTP section's FIRST hidden password prompt expects exactly that emailed temp password
#    (its NEW_PASSWORD_REQUIRED challenge then sets the real one). ADMIN_USER there = this same
#    <admin email>. Executable block (M3):
#    Dated note (2026-08-14): managed-login branding for the dashboard client is now stack-managed
#    (AWS::Cognito::ManagedLoginBranding in auth.ts) — no manual create-managed-login-branding step.
POOL_ID=$(aws cognito-idp list-user-pools --max-results 20 \
  --query "UserPools[?Name=='medadhere-clinicians'].Id | [0]" --output text) \
  && test -n "$POOL_ID" && test "$POOL_ID" != "None" \
  || { echo 'medadhere-clinicians pool-id lookup FAILED — abort' >&2; exit 1; }
( cd infra && USER_POOL_ID="$POOL_ID" ADMIN_EMAIL='<admin email>' npm run create-admin ) || exit 1
aws cognito-idp admin-get-user --user-pool-id "$POOL_ID" --username '<admin email>' \
  --query UserStatus --output text   # must print FORCE_CHANGE_PASSWORD

# 5. Vercel dashboard env re-point: COGNITO_* (new pool/client ids), DATA_API_URL (new DataApiUrl
#    output), COGNITO_REDIRECT_URI + the Cognito callback/sign-out allow-list (DEPLOY-NOTES-02
#    §"Vercel deploy"). Then TRIGGER a Vercel PRODUCTION REDEPLOY (env changes do not apply to the
#    running build — R2-5) and verify a dashboard sign-in + ONE data-API call against the new stack;
#    verify the headers live (curl block below).

# 6. Smoke-verify before anything else touches the stack: one smoke send to the /medadhere/test-recipient
#    number (live SMS — per-action user confirmation) + one dashboard sign-in.
```

### 1b. Redeploy-cycle checklist (data ceremony only — D6)

> **Dated note (2026-07-30, user decision):** the deployed system is **bit-identical in every
> cycle** — every deploy is `validationWindow=true` with the full §1a bootstrap. The rows below are
> **data-ceremony differences only** (what to do about the data in the DB), never system
> differences: the DATA-02 snapshot and the §6.1 final-export teardown step apply when live-test
> data exists; a demo cycle on throwaway seeded data may skip them.

| | DEMO cycle (throwaway seeded data) | THE validation cycle (live-test data) |
|---|---|---|
| Pre-create §0b | full (SSM params, domain release) | full |
| Deploy §1 | THE deploy (`validationWindow=true`) | identical |
| Bootstrap §1a | full (secret existence check, webhook, admin+TOTP, Vercel, smoke) | full |
| Wipe / snapshot | wipe as needed / MAY skip the DATA-02 snapshot (throwaway data) | §2 wipe → DATA-02 snapshot (ops-runbook-05 §2) |
| Data | seed throwaway demo rows as needed | the researcher's validation row (§3) |
| Teardown | §6 order — MAY skip §6.1 final export (throwaway data; an empty-DB export loud-fails by design); §6.2 drain → §6.3 window-off revert (REQUIRED — protections are on from birth) → §6.4 destroy | full §6 order |
| Post-destroy | §6a leak-check — esp. the `medadhere-auth` domain release before the next cycle | §6a leak-check |

Per-cycle drift (why §1a is mandatory every time): `InboundUrl` / `DataApiUrl` / pool / client ids →
new; admin user + TOTP enrollment → gone; Vercel env → stale; `medadhere-auth` Cognito domain → must
be released from the previous cycle before the next create succeeds (§6a; checked pre-create in §0b,
together with the SSM params the deploy consumes). The persistent secrets do NOT drift (A3) — the
§1a step-1 existence check still runs every cycle, fail-closed.

### Single-admin TOTP enrollment (U38 / COG2 — via the D4 auxiliary app client)

The pool enables **optional software-token (TOTP) MFA**. COG2 expects MFA to be required at the pool.
The single admin must enroll and prefer TOTP before the Phase-7 validation run begins. The deployed dashboard
client cannot supply the required access token (it stores only ID/refresh tokens and requests only
`openid email profile`); the setup calls need a signed-in **access token** carrying
`aws.cognito.signin.user.admin`. **Do not start the validation run until the D4 client is deployed and
this section has been executed.** This is a blocking prerequisite, not permission to make MFA required or
replace the pool.

> **Dated note (2026-07-30, round-2 gate R2-1) — supersedes this section's former `USER_SRP_AUTH`
> mention:** SRP is not CLI-executable (the AWS CLI cannot compute `SRP_A`; no SRP library exists in
> the workspace). The token path is the D4 **second no-secret app client with
> `ALLOW_USER_PASSWORD_AUTH`** — password auth over TLS via `read -s`, no client secret, single admin.

**Binding now:** the challenge FLOW below and its hygiene rules; the exact commands are finalized by
the D4 implementation deliverable. Hygiene (non-negotiable): every secret/token/TOTP code enters via
stdin/hidden input (`read -s`) and is staged in a mode-0600 file under the prefix-validated
`medadhere-secret-stage.*` staging dir; every request body is REAL JSON built by `jq -n` — secrets
enter jq via `--rawfile` from those files, NEVER `--arg` (jq's argv is process-listing-visible;
round-4 gate, R4-3); non-secret identifiers (client id, username, challenge names) may use `--arg` —
piped to `--cli-input-json file:///dev/stdin`; secrets are NEVER string-interpolated into heredocs
(a valid password containing quotes/backslashes would corrupt the JSON; round-3 gate, R3-3) and
NEVER argv; every response is captured and asserted (ChallengeName / Session / AccessToken / Status)
without printing token values; the exit trap removes the staging dir and unsets every secret-bearing
variable; nothing is pasted into the runbook or a committed log.

```sh
confirm_medadhere_target || exit 1
# Secrets NEVER on jq argv (R4-3): each secret is read via `read -s` into a mode-0600 file under the
# prefix-validated staging dir and enters jq via --rawfile; argv carries only file paths and
# non-secret identifiers. cleanup() validates the prefix, removes the dir, unsets vars; signals
# clean up AND abort (R3-4).
umask 077
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/medadhere-secret-stage.XXXXXX") \
  || { echo 'staging mktemp FAILED — abort' >&2; exit 1; }
cleanup() {
  case "$STAGE" in
    *medadhere-secret-stage.*) rm -rf "$STAGE" ;;
    *) echo "refusing rm -rf: unexpected STAGE path '$STAGE'" >&2 ;;
  esac
  unset ADMIN_PW NEW_PW TOTP_CODE RESP STAGE
}
trap cleanup EXIT
trap 'cleanup; exit 1' HUP INT TERM
D4_CLIENT_ID=$(aws cloudformation describe-stacks --stack-name "${STACK:-MedAdhereFoundation}" \
  --query "Stacks[0].Outputs[?OutputKey=='D4ClientId'].OutputValue" --output text) \
  && test -n "$D4_CLIENT_ID" && test "$D4_CLIENT_ID" != "None" \
  || { echo 'D4ClientId stack-output retrieval FAILED — abort' >&2; exit 1; }
ADMIN_USER='<admin username>'

# 1. Sign in via USER_PASSWORD_AUTH. The pool is new each cycle (§1a admin recreation), so the fresh
#    admin MUST be challenged NEW_PASSWORD_REQUIRED — assert it and capture the Session (to a 0600
#    staging file, like every secret below):
printf 'Admin password: ' && read -rs ADMIN_PW && echo && test -n "$ADMIN_PW" || exit 1
printf '%s' "$ADMIN_PW" > "$STAGE/admin-pw" || exit 1
unset ADMIN_PW
RESP=$(jq -n --arg cid "$D4_CLIENT_ID" --arg u "$ADMIN_USER" --rawfile p "$STAGE/admin-pw" \
  '{AuthFlow:"USER_PASSWORD_AUTH",ClientId:$cid,AuthParameters:{USERNAME:$u,PASSWORD:$p}}' \
  | aws cognito-idp initiate-auth --cli-input-json file:///dev/stdin) || exit 1
test "$(printf '%s' "$RESP" | jq -r .ChallengeName)" = NEW_PASSWORD_REQUIRED \
  || { echo 'expected NEW_PASSWORD_REQUIRED — abort' >&2; exit 1; }
printf '%s' "$RESP" | jq -je .Session > "$STAGE/session" \
  || { echo 'no Session — abort' >&2; exit 1; }

# 2. Answer NEW_PASSWORD_REQUIRED; assert an AccessToken came back (never print it):
printf 'New admin password: ' && read -rs NEW_PW && echo && test -n "$NEW_PW" || exit 1
printf '%s' "$NEW_PW" > "$STAGE/new-pw" || exit 1
unset NEW_PW
RESP=$(jq -n --arg cid "$D4_CLIENT_ID" --arg u "$ADMIN_USER" \
  --rawfile s "$STAGE/session" --rawfile np "$STAGE/new-pw" \
  '{ClientId:$cid,ChallengeName:"NEW_PASSWORD_REQUIRED",Session:$s,
    ChallengeResponses:{USERNAME:$u,NEW_PASSWORD:$np}}' \
  | aws cognito-idp respond-to-auth-challenge --cli-input-json file:///dev/stdin) || exit 1
printf '%s' "$RESP" | jq -je .AuthenticationResult.AccessToken > "$STAGE/access-token" \
  || { echo 'no AccessToken — abort' >&2; exit 1; }

# 3. TOTP enrollment trio (token + code via --rawfile from staging files, never argv; assert each):
RESP=$(jq -n --rawfile t "$STAGE/access-token" '{AccessToken:$t}' \
  | aws cognito-idp associate-software-token --cli-input-json file:///dev/stdin) || exit 1
printf '%s' "$RESP" | jq -re .SecretCode    # the ONLY value shown — copy into the authenticator app
printf 'Current TOTP: ' && read -rs TOTP_CODE && echo && test -n "$TOTP_CODE" || exit 1
printf '%s' "$TOTP_CODE" > "$STAGE/totp" || exit 1
unset TOTP_CODE
RESP=$(jq -n --rawfile t "$STAGE/access-token" --rawfile c "$STAGE/totp" \
  '{AccessToken:$t,UserCode:$c}' \
  | aws cognito-idp verify-software-token --cli-input-json file:///dev/stdin) || exit 1
test "$(printf '%s' "$RESP" | jq -r .Status)" = SUCCESS \
  || { echo 'verify-software-token != SUCCESS — abort' >&2; exit 1; }
jq -n --rawfile t "$STAGE/access-token" \
  '{AccessToken:$t,SoftwareTokenMfaSettings:{Enabled:true,PreferredMfa:true}}' \
  | aws cognito-idp set-user-mfa-preference --cli-input-json file:///dev/stdin || exit 1

# 4. PROVE the challenge — a FULL fresh sign-in answering SOFTWARE_TOKEN_MFA (only a TOTP-challenged
#    sign-in that returns a token closes this step):
RESP=$(jq -n --arg cid "$D4_CLIENT_ID" --arg u "$ADMIN_USER" --rawfile p "$STAGE/new-pw" \
  '{AuthFlow:"USER_PASSWORD_AUTH",ClientId:$cid,AuthParameters:{USERNAME:$u,PASSWORD:$p}}' \
  | aws cognito-idp initiate-auth --cli-input-json file:///dev/stdin) || exit 1
test "$(printf '%s' "$RESP" | jq -r .ChallengeName)" = SOFTWARE_TOKEN_MFA \
  || { echo 'expected SOFTWARE_TOKEN_MFA — abort' >&2; exit 1; }
printf '%s' "$RESP" | jq -je .Session > "$STAGE/session" \
  || { echo 'no Session — abort' >&2; exit 1; }
printf 'Fresh TOTP: ' && read -rs TOTP_CODE && echo && test -n "$TOTP_CODE" || exit 1
printf '%s' "$TOTP_CODE" > "$STAGE/totp" || exit 1
unset TOTP_CODE
RESP=$(jq -n --arg cid "$D4_CLIENT_ID" --arg u "$ADMIN_USER" \
  --rawfile s "$STAGE/session" --rawfile c "$STAGE/totp" \
  '{ClientId:$cid,ChallengeName:"SOFTWARE_TOKEN_MFA",Session:$s,
    ChallengeResponses:{USERNAME:$u,SOFTWARE_TOKEN_MFA_CODE:$c}}' \
  | aws cognito-idp respond-to-auth-challenge --cli-input-json file:///dev/stdin) || exit 1
printf '%s' "$RESP" | jq -e '(.AuthenticationResult.AccessToken // "") | length > 0' >/dev/null \
  || { echo 'TOTP sign-in returned no token — abort' >&2; exit 1; }
echo 'TOTP-challenged sign-in PROVEN'
cleanup; trap - EXIT HUP INT TERM
```

Sign out of the dashboard, sign back in through managed login, and confirm the admin is challenged for
a TOTP before continuing. `admin-set-user-mfa-preference` is not a substitute for association and
verification: it cannot register the authenticator secret.

The **dashboard** is deployed to Vercel (project `b2707s-projects/dashboard`) from the local tree. The D10
security headers (HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, CSP) are **code** in
`dashboard/next.config.ts` (`headers()`), so they ship automatically with the Vercel build — no Vercel
dashboard configuration is required for them. Vercel env (`COGNITO_*`, `DATA_API_URL`,
`COGNITO_REDIRECT_URI`) and the Cognito callback/sign-out allow-list are reconciled per
`.notes/phases/02-auth-dashboard-shell/DEPLOY-NOTES-02.md` §"Vercel deploy".

Verify the headers are live after deploy:

```sh
curl -sI https://<vercel-production-url>/patients | grep -iE \
  'strict-transport-security|content-security-policy|x-frame-options|x-content-type-options|referrer-policy'
```

---

## Shared operator prerequisites — discover resources and open the RDS tunnel

Sections 2 and 5 use the same private-RDS path. Discover every deployed physical resource from
CloudFormation instead of copying generated names:

```sh
confirm_medadhere_target || exit 1

DB_INSTANCE_ID=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK" \
  --query "StackResources[?ResourceType=='AWS::RDS::DBInstance'].PhysicalResourceId | [0]" \
  --output text)
DB_SECRET_ID=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK" \
  --query "StackResources[?ResourceType=='AWS::SecretsManager::Secret' && contains(LogicalResourceId,'DatabaseInstanceSecret')].PhysicalResourceId | [0]" \
  --output text)
BASTION_ID=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK" \
  --query "StackResources[?ResourceType=='AWS::EC2::Instance' && contains(LogicalResourceId,'Bastion')].PhysicalResourceId | [0]" \
  --output text)
EXPORT_BUCKET_NAME=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK" \
  --query "StackResources[?ResourceType=='AWS::S3::Bucket' && contains(LogicalResourceId,'ExportBucket')].PhysicalResourceId | [0]" \
  --output text)

export DB_SECRET_ARN
DB_SECRET_ARN=$(aws secretsmanager describe-secret \
  --secret-id "$DB_SECRET_ID" --query ARN --output text)
export RDS_HOST
RDS_HOST=$(aws rds describe-db-instances \
  --db-instance-identifier "$DB_INSTANCE_ID" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
export RDS_REMOTE_PORT
RDS_REMOTE_PORT=$(aws rds describe-db-instances \
  --db-instance-identifier "$DB_INSTANCE_ID" \
  --query 'DBInstances[0].Endpoint.Port' --output text)
export DB_NAME
DB_NAME=$(aws rds describe-db-instances \
  --db-instance-identifier "$DB_INSTANCE_ID" \
  --query 'DBInstances[0].DBName' --output text)
export DB_HOST=127.0.0.1
export DB_TLS_SERVERNAME="$RDS_HOST"
export DB_PORT=5432
export DB_CA_BUNDLE_PATH=backend/src/schema-init/rds-global-bundle.pem
export EXPORT_BUCKET_NAME
```

Start the bastion and wait for it before opening the tunnel:

```sh
confirm_medadhere_target || exit 1
aws ec2 start-instances --instance-ids "$BASTION_ID"
aws ec2 wait instance-running --instance-ids "$BASTION_ID"
```

In a separate terminal, rerun the **Required AWS target guard** block, then rediscover the values needed
by the tunnel. Shell variables from the operator terminal do not carry into a new terminal. Keep this
foreground session open:

```sh
confirm_medadhere_target || exit 1
DB_INSTANCE_ID=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK" \
  --query "StackResources[?ResourceType=='AWS::RDS::DBInstance'].PhysicalResourceId | [0]" \
  --output text)
BASTION_ID=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK" \
  --query "StackResources[?ResourceType=='AWS::EC2::Instance' && contains(LogicalResourceId,'Bastion')].PhysicalResourceId | [0]" \
  --output text)
RDS_HOST=$(aws rds describe-db-instances \
  --db-instance-identifier "$DB_INSTANCE_ID" \
  --query 'DBInstances[0].Endpoint.Address' --output text)
RDS_REMOTE_PORT=$(aws rds describe-db-instances \
  --db-instance-identifier "$DB_INSTANCE_ID" \
  --query 'DBInstances[0].Endpoint.Port' --output text)
DB_PORT=5432
aws ssm start-session \
  --target "$BASTION_ID" \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "{\"host\":[\"$RDS_HOST\"],\"portNumber\":[\"$RDS_REMOTE_PORT\"],\"localPortNumber\":[\"$DB_PORT\"]}"
```

Back in the operator terminal, prove the local endpoint is listening before any script runs:

```sh
nc -z 127.0.0.1 "$DB_PORT"
```

### Phase 8 restored-owner reconciliation

Use this only when a restored Phase 7 database still contains `patient.owner_clinician_sub IS NULL`.
Run it immediately after the Phase 8 schema migration and before clinician traffic is enabled. Create a
local, uncommitted mode-`0600` mapping file whose entries were explicitly reviewed by the clinician:

```json
[
  {
    "legacyPatientId": "<patient UUID>",
    "clinicianSub": "<verified Cognito sub UUID>",
    "confirmStoredMedication": true
  }
]
```

The script never infers ownership from a phone number, name, medication, or row order. Dry-run is the
default and must pass before apply. Apply updates only NULL owners, carries the stored legacy medication,
links the legacy schedules, and verifies the result inside one transaction:

```sh
chmod 600 /absolute/path/owners.json
npx tsx scripts/reconcile-patient-owners.ts --mapping /absolute/path/owners.json
npx tsx scripts/reconcile-patient-owners.ts --mapping /absolute/path/owners.json --apply
```

Delete the local mapping file after its reviewed reconciliation record is captured. Do not commit it.

After the wipe/export work is complete, close the SSM session and stop the bastion:

```sh
confirm_medadhere_target || exit 1
aws ec2 stop-instances --instance-ids "$BASTION_ID"
```

---

## 2. D14 — STUDY-04 pre-run wipe (remove dev/test noise before enrollment)

**The validation patient IS `is_test = true` — the researcher alone (solo self-test, dated note
2026-07-30); there are never real patients** (EXEC-01 canon). The `is_test`
flag is a **badge, never a read filter** — the wipe, not a query predicate, is what removes dev/test noise
before enrollment. Both normal enrollment entry points now default to `is_test = true`: the browser form
is default-checked and the seed script defaults true. A deliberate `--no-test` seed is `is_test = false`
and **survives** this wipe.

Run the confirmation-gated operator script over the bastion tunnel (same DB-access path as
`scripts/export-anon.ts` / `scripts/freeze-drug-profiles.ts`):

```sh
npx tsx scripts/wipe-test-patients.ts             # dry-run: counts only, deletes nothing
confirm_medadhere_target && \
  npx tsx scripts/wipe-test-patients.ts --apply   # sweep schedules first, then CASCADE-delete
npx tsx scripts/wipe-test-patients.ts             # readback: must report 0 test patients
```

Use this script instead of raw SQL because `wipeTestPatients` sweeps both `dose-` and `timeout-`
EventBridge prefixes for every captured tester **before** deleting the patient rows. This prevents an
orphan one-shot from firing against a deleted row. The CASCADE child SSOT is
`backend/src/lib/tester-hygiene.ts` (`STUDY04_CASCADE_CHILDREN`); its schema drift guard fails if a new
patient child could escape the wipe. The operation is idempotent: if it is interrupted, rerun the
dry-run, then `--apply`, then the dry-run readback.

Before enrollment, run this verification query through the same bastion connection:

```sql
-- Must return 0 before enrollment: a false-polarity row would survive the wipe
-- and contaminate the run (R1). Remove any such row by id, by hand, first.
SELECT count(*) AS non_cohort_rows FROM patient WHERE is_test = false;
```

Do not continue until it returns `0`. For each deliberately false-polarity row, sweep both schedule
prefixes before deleting the database row:

```sh
patient_id='<reviewed is_test=false UUID>'
npx tsx scripts/drain-schedules.ts --prefix "dose-${patient_id}-"
confirm_medadhere_target && \
  npx tsx scripts/drain-schedules.ts --prefix "dose-${patient_id}-" --apply
npx tsx scripts/drain-schedules.ts --prefix "timeout-${patient_id}-"
confirm_medadhere_target && \
  npx tsx scripts/drain-schedules.ts --prefix "timeout-${patient_id}-" --apply
# Readback: both commands must report no schedules before the SQL transaction.
npx tsx scripts/drain-schedules.ts --prefix "dose-${patient_id}-"
npx tsx scripts/drain-schedules.ts --prefix "timeout-${patient_id}-"
```

Last-mile `psql` over the tunnel (Phase-7 pre-exec gate, C10) — CA-verified TLS, credential in a
mode-0600 temp file removed the moment `psql` exits, never on argv or in history:

```sh
confirm_medadhere_target || exit 1
umask 077
secret_json=$(aws secretsmanager get-secret-value --secret-id "$DB_SECRET_ARN" \
  --query SecretString --output text)
db_user=$(printf '%s' "$secret_json" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).username')
export PGPASSFILE=$(mktemp)          # 0600 under umask 077
printf '127.0.0.1:%s:%s:%s:%s\n' "$DB_PORT" "$DB_NAME" "$db_user" \
  "$(printf '%s' "$secret_json" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).password')" \
  > "$PGPASSFILE"
unset secret_json
psql "host=127.0.0.1 port=$DB_PORT dbname=$DB_NAME user=$db_user sslmode=verify-ca sslrootcert=$DB_CA_BUNDLE_PATH"
rm -f "$PGPASSFILE"; unset PGPASSFILE
```

(`verify-ca`, not `verify-full`: the tunnel presents `127.0.0.1`, so hostname verification cannot
match; the CA bundle still authenticates the server chain.) Then delete only the reviewed UUID in a
transaction:

```sql
BEGIN;
DELETE FROM patient WHERE id = '<reviewed is_test=false UUID>' AND is_test = false;
COMMIT;
```

This procedure is idempotent and safe to rerun after interruption. Then take the DATA-02 pre-cohort
snapshot (`ops-runbook-05.md` §2) so the freshly wiped state is a restore point.

---

## 3. D14 — enroll the validation patient (the researcher, `is_test = true`)

Enroll ONE patient: the researcher, on the researcher's own phone (solo self-test, dated note
2026-07-30 — one person satisfies EXEC-01's "≤5 testers"). The row carries `is_test = true` end-to-end
(enroll-api zod → `EnrollEvent` → patient INSERT; the `/patients/new` form checkbox is
**default-checked "test patient"**). The form's **Days to schedule** field defaults to `3`. For
operator/seed enrollment, pass the duration explicitly so EXEC-01 covers at least three consecutive
local days — and size the run from the 07-PLAN **event budget: single patient, ≥3 doses/day × ≥4
consecutive days = ≥12 scheduled dose events**, so the ≥10× SC1 counts survive once the planned
non-response and tail STOP are reserved. Pass `--tz` explicitly (the researcher's IANA timezone) and
the chosen local dose times via the enroll-seed dose-time option (07-01 implementation item — it supports
the ≥3/day) instead of the default now+2-minutes:

```sh
confirm_medadhere_target || exit 1
# Resolve the deployed Enroll Lambda, copy the owner UUID from the verified Cognito admin user,
# then seed the researcher's row (one run). This direct Enroll invocation is a privileged offline
# operator exception: it requires AWS IAM permission to invoke the Lambda and is never a clinician
# or browser path.
FN=$(aws cloudformation describe-stack-resources \
  --stack-name MedAdhereFoundation \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function' && contains(LogicalResourceId,'EnrollFn')].PhysicalResourceId | [0]" \
  --output text)
owner_sub=$(aws cognito-idp admin-get-user \
  --user-pool-id "$POOL_ID" \
  --username '<admin email>' \
  --query "UserAttributes[?Name=='sub'].Value | [0]" \
  --output text)
tester_phone='+1XXXXXXXXXX'       # the researcher's own E.164 number
medication_name='Metformin'       # the researcher's chosen real drug name (screened per DRUG-01)
tester_tz='America/Toronto'       # the researcher's IANA timezone
npx tsx scripts/enroll-seed.ts \
  --fn "$FN" --owner-sub "$owner_sub" \
  --phone "$tester_phone" --med "$medication_name" \
  --tz "$tester_tz" --days 4      # --days >= 4 and >= 3 dose times/day per the ≥12-event budget
```

`--no-test` is a dev-only escape hatch. It deliberately creates a row the STUDY-04 wipe will not remove,
so never use it for the Phase-7 validation patient.

There is **no `is_test` predicate** anywhere in the list / cohort / queue SQL — reads badge, never filter.
Capture the returned `patientId`, then verify the future one-shot schedules and the patient-local
timeline boundary:

```sh
patient_id='<patientId returned by enroll-seed>'
aws scheduler list-schedules \
  --group-name medadhere-prod \
  --name-prefix "dose-${patient_id}-"
```

The dashboard timeline intentionally includes doses only through the patient's local today. A future
schedule can therefore exist in Scheduler while its tomorrow row is absent from the timeline.

---

## 4. D14 — verify on the dashboard (badges, not filters)

Open the Vercel dashboard and confirm the enrolled row(s) are visible and badged:

- `/patients` — every enrolled patient appears, each carrying its **`test` badge** (plus
  `is_active` / opted-out badges). No patient is hidden by an `is_test` filter.
- The cohort chart, consecutive-miss banner, and per-patient timelines populate from the enrolled rows.

---

## 4a. SC1 evidence capture (fail-closed — validation cycle only)

Binding round-2 gate section (R2-2). Every check below either returns its expected value or SC1 is
NOT met — no "probably fine". Committed evidence (`07-02-SUMMARY`) carries **sanitized aggregates
only**: counts, ids, exit codes, tester aliases — never raw replies, phones, medication names, or
command payloads.

**1. Window.** Record the UTC instant the validation run opens (first live schedule) and the UTC
instant it closes. Every query below is scoped to exactly `[WINDOW_START, WINDOW_END]`.

```sh
date -u +%Y-%m-%dT%H:%M:%SZ          # run at open AND at close; record both
WINDOW_START='<UTC open>'; WINDOW_END='<UTC close>'
```

**2. Alias map (local-only).** Maintain the `tester alias → patient_id` map as a LOCAL file only —
never committed (committed evidence uses aliases; the map is swept in the 07-04 DATA-01 sweep).
Trivial for the solo run — one row (`researcher → <patient_id>`); the rule is unchanged.

**3. Scoped SQL aggregates** (psql over the bastion tunnel — §2 recipe), window-scoped:

```sql
-- Outbound terminal statuses per patient (expect sent/delivered; no queued/sending leftovers):
SELECT patient_id, status, count(*) FROM outbound_message
WHERE created_at BETWEEN '<WINDOW_START>' AND '<WINDOW_END>' GROUP BY 1, 2 ORDER BY 1, 2;
-- Attributable classification rows — MUST be >= 10, fail-closed (round-4 gate, R4-5: unattributed
-- classifier rows persist by design with NULL dose_id; they must not mask broken attribution):
SELECT count(*) FROM adherence_record
WHERE decided_by = 'classifier' AND dose_id IS NOT NULL
  AND patient_id IN ('<local alias-map cohort ids>')
  AND created_at BETWEEN '<WINDOW_START>' AND '<WINDOW_END>';
-- Companion visibility line (NOT gated — record the count honestly in the SUMMARY):
SELECT count(*) AS unattributed FROM adherence_record
WHERE decided_by = 'classifier' AND dose_id IS NULL
  AND created_at BETWEEN '<WINDOW_START>' AND '<WINDOW_END>';
-- THE missed-dose row (record its id as the SC1 evidence):
SELECT id, patient_id, created_at FROM adherence_record
WHERE status = 'missed' AND decided_by = 'timeout'
  AND created_at BETWEEN '<WINDOW_START>' AND '<WINDOW_END>';
-- Stuck 'sending' — MUST return 0 (the ops-runbook-05 §5 residual signal; 15 min = the same stuck
-- bar as §9's SAFETY_SENDING_STUCK_MINUTES default):
SELECT count(*) FROM outbound_message
WHERE status = 'sending' AND created_at < now() - interval '15 minutes';
```

**4. Logs Insights counts** — invocations + timeout events over the window. Discover each fn as §3
discovers `EnrollFn` (fragments `OutboundFn` / `InboundFn` / `ClassifierFn` / `TimeoutFn`), then its
log group via `aws lambda get-function-configuration --function-name "$FN" --query
'LoggingConfig.LogGroup' --output text`:

```sh
confirm_medadhere_target || exit 1
# Invocations per path — run against the Outbound, Inbound and Classifier log groups; each >= 10:
aws logs start-query --log-group-name "$LG" \
  --start-time "$(date -ju -f %Y-%m-%dT%H:%M:%SZ "$WINDOW_START" +%s)" \
  --end-time   "$(date -ju -f %Y-%m-%dT%H:%M:%SZ "$WINDOW_END" +%s)" \
  --query-string 'filter @type = "REPORT" | stats count(*) as invocations'
# Timeout path — run against the Timeout log group; timeout_recorded + timeout_noop >= 10 combined.
# `metric` lives in JSON inside plain-text log lines — NOT an auto-discovered field (R3-1): every
# metric query MUST parse it out of @message before filtering on it:
#   query-string: parse @message /"metric":"(?<metric>[^"]+)"/
#     | filter metric in ["timeout_recorded","timeout_noop"] | stats count(*) by metric
# Fetch each result with `aws logs get-query-results --query-id <id>`.
```

**Fail-closed query rule (round-3 gate R3-1 + round-4 gate R4-4) — binds EVERY Logs Insights query
in this section:** poll `aws logs get-query-results --query-id <id>` until `status` is `Complete`,
then assert the EXPECTED row shape: the step-4 invocation queries → one `invocations` row with value
≥ 10; the timeout query → `timeout_recorded`/`timeout_noop` rows summing ≥ 10 (nonzero rows here
also prove the parse pattern works); the step-6a parser canary → one `parsed` row ≥ 1; the step-6c
Outbound aggregate → exactly one `failures` row = 0. A `Failed`/`Timeout`/`Cancelled` status or a
malformed result = the procedure FAILS. "Empty result = FAIL" applies to every query SPECIFIED to
always return a row (step 4, the canary, the Outbound aggregate); the step-6b Classifier/Inbound
by-metric queries legitimately return empty on a healthy run and are trusted ONLY alongside a green
canary from the same capture — without it, parser failure and true absence are indistinguishable
and an empty result is NEVER read as "zero failures". Fix the query/window and re-run.

**5. DLQ depth — ALL queues in the stack, ALL depth dimensions, every value 0:**

```sh
confirm_medadhere_target || exit 1
for QURL in $(aws cloudformation describe-stack-resources --stack-name "$STACK" \
  --query "StackResources[?ResourceType=='AWS::SQS::Queue'].PhysicalResourceId" --output text); do
  aws sqs get-queue-attributes --queue-url "$QURL" --attribute-names \
    ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed
done   # every attribute of every queue MUST be 0
```

**6. Failure-line counts — the EXTENDED metric list, every count 0 over the window.** Nine failure
lines (the plan's original four plus the round-2 extension): `anthropic_auth_failure`,
`classifier_transient_exhausted`, `classifier_contract_failure`, `timeout_schedule_failed`,
`inbound_publish_failure`, `classifier_safety_send_failed`, `inbound_safety_send_failed`,
`inbound_safety_reserve_failed`, `inbound_safety_divert_failed`. Authoritative check = Logs Insights
per line (`inbound_publish_failure` has NO deployed metric filter — its log line is the only signal).
Three sub-steps (round-4 gate, R4-4):

```sh
# 6a. Parser CANARY first: run the parse against a log group KNOWN to contain structured metric
#     lines — the Classifier LG discovered in step 4 (`classifier_recorded` is emitted on successful
#     classifications) — and require >= 1 parsed row. A green canary proves the parse pattern works,
#     so an empty by-metric result in 6b reads as true absence, not parser failure:
aws logs start-query --log-group-name "$CLASSIFIER_LG" --start-time '<epoch>' --end-time '<epoch>' \
  --query-string 'parse @message /"metric":"(?<metric>[^"]+)"/ | filter metric = "classifier_recorded" | stats count(*) as parsed'
# parsed >= 1 REQUIRED — else the capture FAILS before any 6b result is read.

# 6b. Classifier + Inbound LGs — by-metric query (same start/end as step 4); a healthy run returns
#     empty or all-zero rows, trusted ONLY alongside the green 6a canary:
#   Classifier LG: anthropic_auth_failure, classifier_transient_exhausted,
#                  classifier_contract_failure, classifier_safety_send_failed
#   Inbound LG:    inbound_publish_failure, inbound_safety_send_failed,
#                  inbound_safety_reserve_failed, inbound_safety_divert_failed
aws logs start-query --log-group-name "$LG" --start-time '<epoch>' --end-time '<epoch>' \
  --query-string 'parse @message /"metric":"(?<metric>[^"]+)"/ | filter ispresent(metric) | stats count(*) by metric'
# EVERY failure line above must be absent (or 0) in every result — status Complete + 6a green.

# 6c. Outbound LG (timeout_schedule_failed) — a ONE-ROW aggregate that ALWAYS returns exactly one
#     row at Complete (a healthy Outbound emits NO structured metric line — its sole logMetric is
#     timeout_schedule_failed — so the 6b query shape would legitimately return empty here and be
#     unreadable fail-closed). The aggregate runs over ALL lines, no filter, precisely so a row
#     always comes back; failures = 0 passes:
aws logs start-query --log-group-name "$OUTBOUND_LG" --start-time '<epoch>' --end-time '<epoch>' \
  --query-string 'stats sum(strcontains(@message, "timeout_schedule_failed")) as failures'
# PASS = status Complete AND exactly one row AND failures = 0. Any other shape FAILS.

# Corroborate with the CloudWatch rollups (namespace MedAdhere/OPS) — every returned Sum MUST be 0:
for M in AnthropicFailure EmergencyRoutingFailure TimeoutOrContractFailure; do
  aws cloudwatch get-metric-statistics --namespace MedAdhere/OPS --metric-name "$M" \
    --start-time "$WINDOW_START" --end-time "$WINDOW_END" --period 86400 --statistics Sum
done
```

**7. Native `AWS/Lambda` `Errors` — window-scoped Sum MUST be 0 for each of the four path functions**
(round-3 gate, R3-1 — part of the mandatory "without error" definition, not supplementary):

```sh
confirm_medadhere_target || exit 1
# The four function names discovered in step 4 (OutboundFn / InboundFn / ClassifierFn / TimeoutFn):
for FN in "$OUTBOUND_FN" "$INBOUND_FN" "$CLASSIFIER_FN" "$TIMEOUT_FN"; do
  aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Errors \
    --dimensions Name=FunctionName,Value="$FN" \
    --start-time "$WINDOW_START" --end-time "$WINDOW_END" --period 86400 --statistics Sum
done
# Every returned Sum MUST be 0. An empty Datapoints list counts as 0 only because step 4 separately
# proves each function ran (>= 10 invocations); any nonzero Sum = SC1 not met.
```

**8. "Without error" — the SC1 definition.** SC1's "without error" holds iff ALL of: (5) every DLQ
depth is 0, AND (6) every failure-line count (and rollup Sum) is 0, AND (7) every window-scoped
`AWS/Lambda` `Errors` Sum is 0 for Outbound/Inbound/Classifier/Timeout, AND (3) the outbound
aggregates are terminal-success (no stuck `sending`, expected terminal statuses). Any nonzero = SC1
not met — investigate and re-run the window checks; never rationalize. Only the sanitized aggregates
enter the SUMMARY.

---

## 5. DASH-06 — the pseudonymized export

The export is **pseudonymized**, not anonymized (honest wording — a known tester group is not truly
anonymizable; see 06-PLAN D7). It **includes the test rows by default** (no `is_test` filter; `is_test`
is emitted as a column tag). Nightly is the automatic backstop; the export can also be run on demand
at any time. Two entry points:

- **Nightly Lambda** — runs automatically (the schedule exists **only** under
  `-c validationWindow=true` — which every deploy now ships, §1 dated note — in the default schedule
  group with its own dedicated target role). The no-argv path exports the seeded `is_test = true` rows.
- **Manual script** (`scripts/export-anon.ts`, over the bastion tunnel):

```sh
mkdir -p ./local-exports
# Dry-run is the DEFAULT (prints row/column summary, writes nothing):
npx tsx scripts/export-anon.ts
# Write to S3:
confirm_medadhere_target && npx tsx scripts/export-anon.ts --apply
aws s3 ls "s3://${EXPORT_BUCKET_NAME}/exports/"
# Local file instead of S3:
npx tsx scripts/export-anon.ts --out ./local-exports/export.csv
# Existing paths are refused unless replacement is explicit:
npx tsx scripts/export-anon.ts --out ./local-exports/export.csv --force
# Dev-noise runs only — invert the polarity to EXCLUDE test rows:
npx tsx scripts/export-anon.ts --exclude-test
```

**A 0-row result fails loudly** (nonzero script exit / Lambda error log) — because the validation row is
`is_test = true`, an empty export means the default polarity or the data is wrong, never a silent success.

---

## 6. Teardown — final export BEFORE destroy (the only correct order)

```sh
# 1. Final export while the DB is still live, then download + verify the artifact off-box.
confirm_medadhere_target && \
  npx tsx scripts/export-anon.ts --apply       # (or --out ./local-exports/final-export.csv)
aws s3 ls "s3://${EXPORT_BUCKET_NAME}/exports/" | tail -1
#    Record the LAST object key verbatim — that exact key IS the readback evidence ("an export
#    exists" is not). Download that key and confirm the CSV opens with the expected rows/columns.

# 2. Drain every per-dose/timeout one-shot before closing the validation window.
npx tsx scripts/drain-schedules.ts            # dry-run: list every schedule still in medadhere-prod
confirm_medadhere_target && \
  npx tsx scripts/drain-schedules.ts --apply  # delete them
npx tsx scripts/drain-schedules.ts            # MUST print "the medadhere-prod group is already empty"

# 3. Flip protection OFF (mirrors ops-runbook-05 §3): redeploy with the window closed so
#    deletionProtection + terminationProtection flip to false AND the export schedule is removed.
#    This is the ONLY validationWindow=false deploy in the lifecycle (§1 dated note) — required in
#    EVERY cycle, demo included (protections are on from birth).
cd infra
confirm_medadhere_target || exit 1
npx cdk deploy -c deployHosting=false -c validationWindow=false \
  -c billingEmail=<real ops email>

# 4. Only now can destroy succeed (RemovalPolicy.DESTROY everywhere; the export bucket auto-deletes).
confirm_medadhere_target || exit 1
npx cdk destroy

# 5. Post-destroy: run the §6a leak-check (ACCOUNT guard — the stack is gone), then the project-end
#    steps IN ORDER: §6b Twilio purge FIRST (it reads the sender number from /medadhere/twilio-from
#    — round-4 gate, R4-1), THEN SSM parameter deletion (§6b step 5 — never before the purge),
#    snapshot deletion (§6a row), persistent-secret deletion at PROJECT END ONLY (§6a row — A3),
#    §6c retained-export obligation recorded. Credential retirement is
#    TERMINAL: delete the IAM access key + revoke the GitHub PAT only AFTER snapshot deletion, a
#    green leak-check, and the final evidence push (they are needed for all three).
```

The drain removes the per-dose and timeout one-shots from `medadhere-prod`; the
`validationWindow=false` redeploy separately removes the nightly export schedule and turns off RDS/stack
protection. Skipping the redeploy leaks the RDS instance (the project decision record caveat). The manual pre-cohort
snapshot (ops-runbook-05 §2) is expected to survive teardown — enumerate and delete every `medadhere*`
manual snapshot at project end (§6a). The Twilio message-log purge is §6b (project end — not an AWS
resource).

---

## 6a. Post-destroy leak-check (account guard — the stack no longer exists)

`confirm_medadhere_account || exit 1` first (§0 guard split). Each row: run the check, record
checked / gone / evidence in the teardown SUMMARY — sanitized evidence only (counts, ids, exit codes).

| Row | Check | Expected |
|---|---|---|
| RDS instance | `aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier'` | no `medadhere*` |
| Manual snapshots | `aws rds describe-db-snapshots --snapshot-type manual --query 'DBSnapshots[].DBSnapshotIdentifier'` | ENUMERATE, don't trust one remembered id — aborted cycles orphan `medadhere-pre-cohort-*`. At project end `aws rds delete-db-snapshot` EVERY `medadhere*` snapshot; evidence per snapshot id |
| SSM params (PII) | `aws ssm get-parameter --name /medadhere/twilio-from` and `--name /medadhere/test-recipient` — verify both still PRESENT; deletion is DEFERRED to §6b step 5 (round-4 gate, R4-1: §6b reads the sender number from `/medadhere/twilio-from` before any deletion) | both present here (created outside CFN, they SURVIVE destroy; `test-recipient` holds a real phone number); deleted only AFTER the terminal §6b purge, ParameterNotFound readback recorded there |
| Secrets | `aws secretsmanager list-secrets --query "SecretList[?starts_with(Name,'medadhere')].Name"` | exactly `medadhere/twilio` + `medadhere/anthropic` remain (out-of-stack persistent — A3, §1a dated note); the stack-owned DB secret is gone. At PROJECT END delete both with `delete-secret --force-delete-without-recovery` (F15 caution: the default deletion schedules a recovery window during which the name stays reserved), evidence per name |
| Vendor credentials (PROJECT END only — L8) | Secrets Manager deletion is NOT credential retirement. Revoke the Twilio **API key** used by the MCP (Console → Account → API keys) or record its retention; delete the four `medadhere-twilio-*` + `medadhere-anthropic` Keychain items (`security delete-generic-password -s <item>`) or record retention; the Anthropic sk-ant key rotate-or-keep disposition is the 07-04 credential step (F6) | each credential: revoked/deleted with readback, or a dated retention note |
| Export bucket | `aws s3 ls "s3://${EXPORT_BUCKET_NAME}"` | bucket gone (auto-delete on destroy) |
| Scheduler | `aws scheduler list-schedule-groups --query "ScheduleGroups[?Name=='medadhere-prod']"` | empty |
| OPS-02 SNS absence | `aws sns list-topics` (no MedAdhere AlarmTopic; the construct intentionally creates none) | absent before and after destroy |
| Cognito domain | `aws cognito-idp describe-user-pool-domain --domain medadhere-auth` | no domain — MUST be released before the next cycle's create (§1b) |
| NAT / EIP / ENI (prudence — destroy-covered; NAT is the dominant cost leak) | `aws ec2 describe-nat-gateways --filter Name=state,Values=available` · `aws ec2 describe-addresses` · `aws ec2 describe-network-interfaces --filters Name=status,Values=available` | all empty |
| Local residue (not AWS — R2-6/R3-4) | `local-exports/` raw-bearing files; §1a staging dirs — `ls -d "${TMPDIR:-/tmp}"/medadhere-secret-stage.*` MUST match nothing (prefix-named so the assert is possible); §6b `medadhere-twilio-*` temps — same check; `PGPASSFILE` temps; the §4a alias→patient-id map | none remain |

---

## 6b. Twilio message-log purge (project end — DATA-01; not an AWS resource)

Run ONLY after the final export is verified off-box and all repo evidence is committed — deleted Twilio
message bodies (the raw replies) are unrecoverable. Use only the secret-safe REST procedure below;
the Twilio MCP was retired by the 2026-08-04 credential-incident ruling. The confirm-before-any-
send/mutate doctrine is unchanged. Shell mechanics are binding (round-2 gate R2-3 +
round-3 gate R3-2): credentials live in a mode-0600 curl config file (`--config`), NEVER `-u` on argv;
every request is `curl -fsS` PLUS an explicit HTTP-status assert before any parse; SIDs stream one per
line through a mode-0600 temp file consumed by `while IFS= read -r` (never an unquoted `$var` loop —
zsh does not word-split unquoted scalars); the final readback asserts BOTH direction counts are 0 and
exits nonzero otherwise. The sender number is READ from the authoritative `/medadhere/twilio-from`
SSM param (or the 0600 resume state record) BEFORE any deletion, and the release targets the
exactly-one SID returned by the pre-release lookup (round-4 gate, R4-1). The terminal path is
RESUMABLE (round-5 gate, R5-1): the release state is atomically persisted BEFORE the number is
released, so a purge interrupted mid-flight re-enters safely instead of stranding messages behind a
zero-result lookup.

```sh
umask 077
TWILIO_SID='<ACCOUNT SID>'
STATEFILE="${TMPDIR:-/tmp}/medadhere-twilio-release-state"   # 0600 resume record (R5-1):
                                                             # line 1 number, line 2 account SID,
                                                             # line 3 released phone-number SID
# Sender number: NEVER hand-typed (R4-1) — read it from the authoritative SSM param, which is still
# present (its deletion is step 5, AFTER this purge). Fallback: line 1 of the state record from a
# prior partial run — also the source if re-running after step 5 deleted the param:
TWILIO_NUM=$(aws ssm get-parameter --name /medadhere/twilio-from \
  --query Parameter.Value --output text) \
  || TWILIO_NUM=$(sed -n 1p "$STATEFILE") \
  || { echo 'sender number unavailable (SSM param AND state record) — abort' >&2; exit 1; }
test -n "$TWILIO_NUM" || { echo 'sender number empty — abort' >&2; exit 1; }
API="https://api.twilio.com/2010-04-01/Accounts/$TWILIO_SID"
enc_num=$(node -pe 'encodeURIComponent(process.argv[1])' "$TWILIO_NUM")

# Credential + working files: 0600 under umask 077, removed on EXIT; signals clean up AND abort:
CURLRC=$(mktemp "${TMPDIR:-/tmp}/medadhere-twilio-curlrc.XXXXXX") || exit 1
SIDFILE=$(mktemp "${TMPDIR:-/tmp}/medadhere-twilio-sids.XXXXXX")  || exit 1
BODYFILE=$(mktemp "${TMPDIR:-/tmp}/medadhere-twilio-body.XXXXXX") || exit 1
trap 'rm -f "$CURLRC" "$SIDFILE" "$BODYFILE"' EXIT
trap 'rm -f "$CURLRC" "$SIDFILE" "$BODYFILE"; exit 1' HUP INT TERM
printf 'Twilio auth token: ' && read -rs TWILIO_AUTH_TOKEN && echo && test -n "$TWILIO_AUTH_TOKEN" \
  || { echo 'auth-token read FAILED — abort' >&2; exit 1; }
printf 'user = "%s:%s"\n' "$TWILIO_SID" "$TWILIO_AUTH_TOKEN" > "$CURLRC" || exit 1
unset TWILIO_AUTH_TOKEN            # from here the credential exists ONLY in the 0600 curl config

twilio_get() {  # $1 = URL → body on stdout; -fsS AND explicit status assert before any parse
  code=$(curl --config "$CURLRC" -fsS -o "$BODYFILE" -w '%{http_code}' "$1") \
    || { echo "GET FAILED ($1)" >&2; return 1; }
  test "$code" = 200 || { echo "HTTP $code from GET — abort" >&2; return 1; }
  cat "$BODYFILE"
}
twilio_delete() {  # $1 = message SID
  code=$(curl --config "$CURLRC" -fsS -o /dev/null -w '%{http_code}' -X DELETE \
    "$API/Messages/$1.json") || { echo "delete FAILED ($1) — abort" >&2; return 1; }
  case "$code" in 200|204) ;; *) echo "HTTP $code deleting $1 — abort" >&2; return 1 ;; esac
}

# 1. FIRST — pick the acceptance path (a late reply would otherwise re-create provider records).
#    TERMINAL (the only path that closes DATA-01) — resumable, fail-closed (R4-1 + R5-1):
#    1a. PRE-RELEASE lookup. Exactly ONE match = fresh run: capture ITS SID, atomically persist the
#        0600 state record BEFORE releasing (temp + mv — it survives the readback and step 5, swept
#        only in the 07-04 local sweep), then release at 1b. ZERO matches is permitted ONLY as a
#        RESUME: the state record must exist, its number must match, AND a direct lookup of its
#        recorded SID must prove the number absent — then SKIP release and RESUME the purge at
#        step 2. Zero without matching state, or any multi-result, hard-aborts:
lookup=$(twilio_get "$API/IncomingPhoneNumbers.json?PhoneNumber=$enc_num") || exit 1
n=$(printf '%s' "$lookup" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).incoming_phone_numbers.length') \
  || exit 1
if test "$n" = 1; then
  PN_SID=$(printf '%s' "$lookup" \
    | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).incoming_phone_numbers[0].sid') \
    || exit 1
  printf '%s\n%s\n%s\n' "$TWILIO_NUM" "$TWILIO_SID" "$PN_SID" > "$STATEFILE.tmp.$$" || exit 1
  mv "$STATEFILE.tmp.$$" "$STATEFILE" || exit 1
elif test "$n" = 0; then
  test -f "$STATEFILE" || { echo 'zero matches and NO state record — abort' >&2; exit 1; }
  test "$(sed -n 1p "$STATEFILE")" = "$TWILIO_NUM" \
    || { echo 'state record number mismatch — abort' >&2; exit 1; }
  rec_sid=$(sed -n 3p "$STATEFILE") && test -n "$rec_sid" \
    || { echo 'state record missing SID — abort' >&2; exit 1; }
  code=$(curl --config "$CURLRC" -sS -o /dev/null -w '%{http_code}' \
    "$API/IncomingPhoneNumbers/$rec_sid.json") || exit 1   # no -f: 404 is the EXPECTED result
  test "$code" = 404 \
    || { echo "recorded SID not proven absent (HTTP $code) — abort" >&2; exit 1; }
  echo 'resume: release already complete — skipping release, resuming purge'
  PN_SID=''
else
  echo "expected exactly ONE matching number, got $n — abort" >&2; exit 1
fi
#    1b. RELEASE exactly THAT SID (fresh run only) — typed confirmation first (live Twilio mutation;
#        MCP/console release of the SAME SID is an acceptable substitute for the DELETE below):
if test -n "$PN_SID"; then
  printf 'Type the sender number to confirm release of %s: ' "$PN_SID" && read -r rel_confirm
  test "$rel_confirm" = "$TWILIO_NUM" || { echo 'release NOT confirmed — abort' >&2; exit 1; }
  code=$(curl --config "$CURLRC" -fsS -o /dev/null -w '%{http_code}' -X DELETE \
    "$API/IncomingPhoneNumbers/$PN_SID.json") || { echo 'release DELETE FAILED — abort' >&2; exit 1; }
  case "$code" in 200|204) ;; *) echo "HTTP $code releasing $PN_SID — abort" >&2; exit 1 ;; esac
fi
#    1c. POST-RELEASE assert (both paths) — the SID/number must now be ABSENT:
n=$(twilio_get "$API/IncomingPhoneNumbers.json?PhoneNumber=$enc_num" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).incoming_phone_numbers.length') \
  || exit 1
test "$n" = 0 || { echo "number still owned ($n) — release NOT complete" >&2; exit 1; }
#    RETENTION (number kept for later demos): clear the number's "A message comes in" URL instead and
#    SKIP 1a–1c — DATA-01 then REMAINS OPEN (see the closing note).

# 2. Purge both directions until empty; record COUNTS only, never bodies:
purge_dir() {  # $1 = From | To
  while :; do
    twilio_get "$API/Messages.json?$1=$enc_num&PageSize=100" \
      | node -e 'for (const m of JSON.parse(require("fs").readFileSync(0,"utf8")).messages) console.log(m.sid)' \
      > "$SIDFILE" || { echo "enumerate FAILED ($1) — abort" >&2; return 1; }
    test -s "$SIDFILE" || break
    echo "deleting $(wc -l < "$SIDFILE" | tr -d ' ') messages ($1)"
    while IFS= read -r sid; do
      test -n "$sid" || continue
      twilio_delete "$sid" || return 1
    done <"$SIDFILE"
  done
}
purge_dir From || exit 1
purge_dir To   || exit 1

# 3. Settle, then RE-PURGE: in-flight/queued records can land after the first pass. Wait a short
#    settle (a few minutes), then rerun both:
purge_dir From || exit 1
purge_dir To   || exit 1

# 4. Readback (fail-closed): BOTH enumerations MUST be 0; any nonzero count exits nonzero:
for d in From To; do
  n=$(twilio_get "$API/Messages.json?$d=$enc_num&PageSize=1" \
    | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).messages.length') \
    || { echo "readback FAILED ($d) — abort" >&2; exit 1; }
  test "$n" = 0 || { echo "readback: $n message(s) remain ($d) — purge NOT complete" >&2; exit 1; }
  echo "readback $d: 0"
done
rm -f "$CURLRC" "$SIDFILE" "$BODYFILE"; trap - EXIT HUP INT TERM
```

```sh
# 5. SSM parameter deletion — ONLY NOW, after the terminal purge above (R4-1: §6b reads
#    /medadhere/twilio-from; deleting it first orphans the purge — this deletion was MOVED here out
#    of the §6a table). TERMINAL path only — on the retention path both params stay until the
#    final-retirement rerun. The 0600 state record written at step 1a already preserves the sender
#    number (R5-1) — it survives this deletion and the readback; no separate preserved file. Delete
#    both params and read back ParameterNotFound:
confirm_medadhere_account || exit 1
aws ssm delete-parameter --name /medadhere/test-recipient
aws ssm delete-parameter --name /medadhere/twilio-from
aws ssm get-parameter --name /medadhere/test-recipient 2>&1 | grep -q ParameterNotFound \
  || { echo 'test-recipient still present — abort' >&2; exit 1; }
aws ssm get-parameter --name /medadhere/twilio-from 2>&1 | grep -q ParameterNotFound \
  || { echo 'twilio-from still present — abort' >&2; exit 1; }
# The state record (the step-5 preserved sender-number file) is swept in the 07-04 DATA-01 local
# sweep ONLY after the zero-count readback and this step are both green — never earlier (R5-1).
```

Then rotate the authToken (the `03-03-SUMMARY.md` + 2026-07-30 transcript exposures) and update the
Keychain copy (`medadhere-twilio-token`); at PROJECT END also revoke or record-retain the MCP API key
+ Keychain items per the §6a Vendor-credentials row (L8) — rotating the auth token does NOT invalidate
API keys.
**Retention path:** if the number is kept for later demos, **DATA-01 remains OPEN** — provider records
keep accruing against the live number; repeat §6b in full at the number's final retirement, and only
that terminal run (release verified + zero-count readback) closes DATA-01. SSM parameter deletion
(step 5) also waits for that terminal run (R4-1).

---

## 6c. Retained-export deletion (the R4-2 standing obligation — survives phase close)

The final pseudonymized export CSV is the ONE retained artifact — **researcher-owned data** (solo
self-test, dated note 2026-07-30: the former consent-disclosure framing is retired; retention +
auto-deletion stay as good practice). At 07-03 download
time it lands in ONE designated encrypted location; the location NAME (never the path contents) is
recorded in the SUMMARY. Trigger: the grading-completion event (user-owned). The deletion is
idempotent — safe to rerun; the not-found readback
line is the sanitized evidence to record:

```sh
RETAINED_EXPORT='<path inside the designated encrypted location>'
rm -f -- "$RETAINED_EXPORT"
test ! -e "$RETAINED_EXPORT" && echo 'retained-export readback: not found (deleted)' \
  || { echo 'retained export STILL PRESENT — abort' >&2; exit 1; }
```

If any copy was ever made, delete it the same way and record one readback per location name. An
earlier deletion (the user's call, any time) discharges the obligation early — record that disposition.

---

## 7. Recorded rulings (Phase-6 decisions on the record — D13 + the no-alert scope)

- **D13 — L6 ~1-hour session expiry is ACCEPTED.** The Cognito access/id token TTL gives clinicians roughly
  a one-hour working session before re-login. A silent-refresh route is a **stretch non-goal** for this
  phase (not built). Acceptable for the honours-project cohort; revisit only if real clinician use ever
  demands longer sessions.

- **No alert for confirmed `stopped` / `skipped` runs (DASH-04 scope ruling).** The consecutive-miss alert
  banner (DASH-04) is **non-response-scoped**: it fires only on runs of `missed` (timeout non-response), and
  says "3+ consecutive check-ins **without a response**". A confirmed `stopped` or `skipped` classifier
  outcome is a *response* — it is **not** a non-response and is deliberately **not** alerted. Confirmed stops
  show in the per-patient timeline (their own distinct series), and a patient who texts STOP typically
  self-deactivates via the deactivate route. This is the documented DASH-04 boundary, not an omission.

---

## 8. Server Action origin allow-list (deploy-time check — 06-02 / D3)

`/patients/new` submits via a Next 15 Server Action. Next rejects the action POST with
`403 "Invalid Server Actions request"` when the request `Origin` doesn't match the host it derives
from `X-Forwarded-Host` — which can happen behind Vercel's proxy and on any custom domain. If the
form 403s post-deploy, declare the deployed origin(s) in `dashboard/next.config.ts`:

```ts
// Next 15: top-level `serverActions` (was `experimental.serverActions` under Next 14)
serverActions: {
  allowedOrigins: [
    '<project>.vercel.app',   // the actual Vercel host of record (D11) — host[:port] only, NO scheme
    // '<custom-domain>',     // every domain the browser may send as Origin
  ],
},
```

List hosts without scheme; include the `*.vercel.app` deployment host and any custom domain.
Verify post-deploy by submitting the form once — a 403 with the row **not** created means an origin
is missing. Localhost dev needs nothing (same-origin). Intentionally NOT pre-coded into
`next.config.ts`: the exact host is confirmed at deploy (DEPLOY-NOTES-02 recipe), and a wrong guess
would silently mask a misconfigured proxy header.

---

## 9. C-10: append-only safety-event review evidence (zero DDL)

This is a research-grade audit trail for the solo test run, not a clinical monitoring service. The safety
queue displays each `safety_event` id, its creation time, the observed `auto_reply_status`, and its age.
A `sending` reservation older than `SAFETY_SENDING_STUCK_MINUTES` (default 15 minutes) is urgent because
the process may have stopped before reaching `sent`, `failed`, or `suppressed`.

**Cadence.** During the validation run, the researcher opens `/reviews/safety` on every next business
day and reviews urgent items first. This queue check is part of, and does not replace, the SAFETY-02
commitment to review all raw inbound replies on the same next-business-day cadence. An urgent item noticed
sooner should be reviewed then; this procedure does not imply overnight or 24/7 coverage.

For every reviewed queue row:

1. Copy `scripts/safety-review-log-template.md` to
   `scripts/safety-review-logs/<YYYY-MM-DD>--<safety_event_id>.md`. The ISO UTC review date and exact
   queue-rendered `safety_event` id form the record key. A repeat review on another date gets another file.

   ```sh
   review_date_utc='<YYYY-MM-DD>'
   safety_event_id='<UUID FROM QUEUE>'
   mkdir -p scripts/safety-review-logs
   review_log_path="scripts/safety-review-logs/${review_date_utc}--${safety_event_id}.md"
   if [ -e "$review_log_path" ]; then
     printf '%s\n' "Review log already exists; append the same-day review instead of replacing it."
   else
     cp scripts/safety-review-log-template.md "$review_log_path"
   fi
   ```

   Never overwrite an existing date + event-id key. A repeat review of the same event on the same UTC date
   appends a new dated review block to the existing file; a review on a later date gets a new keyed file.
2. Fill only the template's non-sensitive metadata. Never paste the inbound message, patient name, phone
   number, medication name, or other free text that could identify a tester. Use a non-PII issue or runbook
   reference when follow-up is needed.
3. Add the new file in the normal reviewed git workflow. Do not amend, squash away, rewrite, or delete
   previously recorded review commits. Git history on the shared remote is the tamper-evident record.
4. If a record needs correction, append a dated correction block to that file and commit the append as a
   separate change. Preserve the original entry and explain the non-PII reason for the correction.
5. At the end of each review session, reconcile every safety queue event seen that day against a
   file keyed by its event id and review date. Verify a record's history with:

   ```sh
   git log --follow -- scripts/safety-review-logs/<YYYY-MM-DD>--<safety_event_id>.md
   ```

This evidence is intentionally file-based. **Do not add `reviewed_at` or any other review-tracking column,
and do not run DDL.**
