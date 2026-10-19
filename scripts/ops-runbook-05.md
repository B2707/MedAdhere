# OPS Runbook — Phase 5 (DATA-02 backups/snapshot/teardown + OPS-02 alarm verify)

Plan 05-04. **This file is documentation only — nothing here runs in CI or during `cdk synth`.**
Every command below is a **manual, deploy-time** step run by the operator against a live stack. Do not
wire any of it into an automated path (INFRA-04 clean-teardown + spend-free build both depend on that).

Region is `us-east-1`; the stack is `MedAdhereFoundation`. All identifiers below are CDK-generated —
discover them from the deployed stack rather than hard-coding.

---

## 1. Discover the RDS instance identifier

The RDS instance identifier is CDK-generated (no fixed `instanceIdentifier`). Resolve it from the stack:

```sh
# The physical id of the Database/Instance logical resource.
aws cloudformation describe-stack-resource \
  --stack-name MedAdhereFoundation \
  --logical-resource-id $(aws cloudformation list-stack-resources \
      --stack-name MedAdhereFoundation \
      --query "StackResourceSummaries[?ResourceType=='AWS::RDS::DBInstance'].LogicalResourceId | [0]" \
      --output text) \
  --query 'StackResourceDetail.PhysicalResourceId' --output text
# → e.g. medadherefoundation-databaseinstanceXXXX-abcd1234 ; call this <DB_ID> below.
```

---

## 2. DATA-02 — manual pre-cohort snapshot (run IMMEDIATELY before the validation cohort)

Automated backups are already provisioned (`database.ts:91`, `backupRetention` default 7 days). This is
the **deliberate, named backup point** taken right before the Phase-7 validation cohort starts, so a
mid-cohort mistake (a mis-run STUDY-04 wipe, a bad migration) can be restored from a known-good instant.
It survives `deleteAutomatedBackups:true` on teardown — a manual snapshot is not an automated backup.

```sh
DB_ID=<paste from step 1>
SNAP_ID="medadhere-pre-cohort-$(date -u +%Y%m%d-%H%M)"   # single UTC now-stamped id (immutable record)

aws rds create-db-snapshot \
  --db-instance-identifier "$DB_ID" \
  --db-snapshot-identifier "$SNAP_ID" \
  --tags Key=project,Value=medadhere Key=purpose,Value=pre-cohort-DATA-02

# Wait until it is available before starting the cohort (a snapshot in `creating` is not a restore point):
aws rds wait db-snapshot-available --db-snapshot-identifier "$SNAP_ID"
aws rds describe-db-snapshots --db-snapshot-identifier "$SNAP_ID" \
  --query 'DBSnapshots[0].[Status,SnapshotCreateTime]' --output text
```

Delete the manual snapshot at **project end only** (it is retained past teardown by design):

```sh
aws rds delete-db-snapshot --db-snapshot-identifier "$SNAP_ID"
```

Restore (if ever needed): `aws rds restore-db-instance-from-db-snapshot` into a NEW instance id, then
re-point the app — never restore over the live instance.

---

## 3. DATA-02 — validation-window protection toggle + teardown ordering

> **Superseded (2026-07-30, Phase-7 pre-exec gate F10):** the deploy/teardown COMMANDS in this section
> are stale — they omit `-c deployHosting=false` (default TRUE deploys the gated Amplify constructs →
> M7 secret failure → rollback; destroy blocked) and the email contexts. **The executable commands are
> `ops-runbook-06.md` §1 (two-stage deploy + §1a bootstrap) and §6 (teardown + §6a/§6b).** The
> protection-toggle table below remains canonical. The calendar window named below is superseded —
> scheduling is sequence-only (user decision 2026-07-30). Post-destroy checks in this section run under
> `confirm_medadhere_account` (runbook-06 §0 guard split): the stack guard cannot pass once the stack
> is gone.

The `validationWindow` context flag (cdk.json / `-c validationWindow=true`) is the ONLY time protection
is ON. It flips **all three** together (enforced by the `foundation-stack.ts` DATA-02 synth guard, which
hard-fails synth if `validationWindow=true` with `backupRetentionDays<7`):

| Protection                       | Where                                        | On when                                  |
| -------------------------------- | -------------------------------------------- | ---------------------------------------- |
| RDS `deletionProtection`         | `database.ts:100` (forwarded from the stack) | `validationWindow=true`                  |
| Stack `terminationProtection`    | `bin/medadhere.ts:43`                        | `validationWindow=true`                  |
| RDS `backupRetentionPeriod >= 7` | `database.ts:91` + the stack guard           | always (guard blocks `<7` in the window) |

**Deploy for the validation window** (Aug 26 – Sep 5). Pass a real billing email — the WR-01
guard hard-fails a validation-window deploy that ships the `.invalid` placeholder:

```sh
cd infra
npx cdk deploy -c validationWindow=true \
  -c billingEmail=<real ops email>
```

**Teardown — protection OFF before `cdk destroy` (the ONLY correct order):**

```sh
cd infra
# 1. Re-synth/redeploy with the window OFF so deletionProtection + terminationProtection flip to false.
npx cdk deploy -c validationWindow=false
# 2. Only now can destroy succeed (RemovalPolicy.DESTROY + deletionProtection:false + deleteAutomatedBackups:true).
npx cdk destroy
```

If you skip step 1, `cdk destroy` "succeeds" at the CloudFormation level but **leaks the DB** (the
project decision record caveat). Confirm nothing survived: `aws rds describe-db-instances` should return no
`medadhere*` instance (the manual pre-cohort snapshot from step 2 is expected to remain — delete it
separately at project end).

The Twilio message-log purge is a separate manual project-end step (Twilio console / API) — it is not an
AWS resource and `cdk destroy` cannot touch it.

---

## 4. OPS-02 — post-deploy alarm verification (the live checkpoints)

These are **deploy-time** checkpoints. They cannot run at build/synth time and are NOT in any test.

### 4a. Confirm the CloudWatch-only alarm inventory

OPS-02 email delivery was removed by user decision on 2026-08-04. `MonitoringConstruct` intentionally
creates no SNS topic, subscription, or alarm action; the alarms remain visible in CloudWatch and on the
AWS dashboard. Confirm they exist before any induced check:

```sh
aws cloudwatch describe-alarms --alarm-name-prefix Monitoring \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output table
```

### 4b. Induced DLQ-depth checkpoint — the CloudWatch alarm becomes visible

On a pre-cohort or idle stack, put one unmistakable operator-test message directly on the FIFO redrive
DLQ. This verifies the native SQS metric → CloudWatch alarm path without making a model call or mutating
credentials. The event-source redrive behavior itself is pinned by the queue/synth integration tests.

```sh
DLQ_URL=$(aws sqs list-queues --queue-name-prefix "" --query "QueueUrls[?contains(@,'TurnRedriveDlq')] | [0]" --output text)
TEST_ID="ops-alarm-check-$(date +%s)"
aws sqs send-message --queue-url "$DLQ_URL" \
  --message-body "{\"kind\":\"ops-alarm-check\",\"id\":\"$TEST_ID\"}" \
  --message-group-id ops-alarm-check --message-deduplication-id "$TEST_ID"

# Expect within ~15 min: TurnRedriveDlqDepthAlarm -> ALARM.
aws cloudwatch describe-alarms --alarm-name-prefix Monitoring \
  --query 'MetricAlarms[?contains(AlarmName, `TurnRedriveDlqDepthAlarm`)].[AlarmName,StateValue]' --output table

# Receive and inspect. Delete only the message whose body contains this run's TEST_ID.
aws sqs receive-message --queue-url "$DLQ_URL" --max-number-of-messages 10 \
  --visibility-timeout 30 --wait-time-seconds 5 \
  --query 'Messages[].[MessageId,ReceiptHandle,Body]' --output text

# Delete ONLY the induced message, using its receipt handle from the preceding output.
aws sqs delete-message --queue-url "$DLQ_URL" --receipt-handle '<paste ReceiptHandle from step 1>'
```

> **NEVER run `aws sqs purge-queue` on a stack that has processed real traffic.** The crash DLQ parks
> parked patient wakes — so a purge is irrecoverable thesis-data loss. If any received body is not the
> exact operator-test message, stop and investigate it; never delete it as part of this drill.

### 4c. Alarm inventory (name → trigger → severity)

| Alarm                                                                                                                                         | Trigger                                                                                                                                                                       | Severity                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `InboundErrorsAlarm` / `OutboundErrorsAlarm` / `ClassifierErrorsAlarm` / `EnrollErrorsAlarm` / `TimeoutErrorsAlarm` / `ExportAnonErrorsAlarm` | AWS/Lambda `Errors >= 1` / 15 min (in-process `.metricErrors()`)                                                                                                              | pipeline error                             |
| `TurnRedriveDlqDepthAlarm`                                                                                                                    | AWS/SQS `ApproximateNumberOfMessagesVisible >= 1`                                                                                                                             | FIFO turn wake parked for review           |
| `SafetyEventRecordedAlarm`                                                                                                                    | `safety_event_recorded` (classifier + inbound)                                                                                                                                | next-business-day review                   |
| `AnthropicFailureAlarm`                                                                                                                       | `anthropic_auth_failure` OR `classifier_transient_exhausted`                                                                                                                  | stop-the-line (key/outage)                 |
| `EmergencyRoutingFailureAlarm`                                                                                                                | `classifier_safety_send_failed` OR `inbound_safety_send_failed` OR `inbound_safety_reserve_failed` OR `inbound_safety_divert_failed` (divert = DB double-fault backstop only) | **URGENT (H6)** — crisis redirect not sent |
| `TimeoutOrContractFailureAlarm`                                                                                                               | `timeout_schedule_failed` (outbound LG) OR `classifier_contract_failure`                                                                                                      | non-response detection / contract at risk  |
| `ConsecutiveUndeliveredAlarm`                                                                                                                 | `consecutive_undelivered` (>= 2 consecutive undelivered/failed)                                                                                                               | patient unreachable / denominator at risk  |

Billing (e) is NOT here — the account-wide cost backstop is `BudgetsConstruct` (D-11, EMAIL-direct, no
SNS confirmation needed).

### 4d. Metric-filter → alarm path verification (L-5 — prove a filter-backed path, not just the DLQ alarm)

§4b drives the `TurnRedriveDlqDepthAlarm`, which reads a **native AWS/SQS** metric. It does not prove the
**metric-filter** front half that the log-backed alarms depend on, so prove a filter too.

**Read-only sanity check (touches no deploy state).** Confirm CloudWatch's matcher resolves the canonical
`{ $.metric = "<name>" }` selector against a real Lambda **Text-format** log line
(`timestamp⇥requestId⇥level⇥json`). Empirically verified 2026-07-17 during the post-exec gate — expect
exactly **1** match:

```sh
aws logs test-metric-filter \
  --filter-pattern '{ $.metric = "safety_event_recorded" }' \
  --log-event-messages $'2026-07-17T00:00:00.000Z\t00000000-0000-0000-0000-000000000000\tINFO\t{"metric":"safety_event_recorded"}'
# → one matched event, extracted field metric=safety_event_recorded. ZERO matches ⇒ the filter is dead;
#   investigate before trusting any (a)/(d)/(g)/(h)/(f) alarm.
```

**Optional live filter-backed alarm drive (end-to-end proof of one metric-filter path).** On a pre-cohort /
idle stack only, emit ONE watched line into a filtered log group and confirm the CloudWatch alarm — e.g. the
`timeout_schedule_failed` line the OUTBOUND fn writes (drives `TimeoutOrContractFailureAlarm`):

```sh
OUTBOUND_LG=$(aws logs describe-log-groups \
  --query "logGroups[?contains(logGroupName,'Outbound')].logGroupName | [0]" --output text)
TS=$(($(date +%s)000))
# Text-format line (tab-delimited), JSON has no ',' or '=' so it stays a single CLI-shorthand message value:
MSG=$'2026-07-17T00:00:00.000Z\tmanual-ops-check\tERROR\t{"metric":"timeout_schedule_failed"}'
aws logs create-log-stream --log-group-name "$OUTBOUND_LG" --log-stream-name manual-ops-check 2>/dev/null || true
aws logs put-log-events --log-group-name "$OUTBOUND_LG" --log-stream-name manual-ops-check \
  --log-events "timestamp=$TS,message=$MSG"
# Within ~15 min: TimeoutOrContractFailureAlarm -> ALARM. This proves the metric-filter -> alarm path,
# not just the native-metric DLQ alarm. Do this ONLY on an idle stack: a real
# timeout_schedule_failed line means non-response detection actually failed for a live dose.
```

---

## 5. Accepted residuals (Phase-5 post-exec gate)

**Outbound crash window between the Twilio send and schedule-create (U-5 — accepted per plan M10).** If the
outbound Lambda dies in the sub-second window _after_ `client.messages.create` returns but _before_
`createTimeoutSchedule`, that dose silently gets no timeout one-shot: the Scheduler retry dead-ends on the
`ON CONFLICT DO NOTHING` reservation guard (`already-reserved`) and never re-reaches schedule creation, and
`timeout_schedule_failed` fires only when `createTimeoutSchedule` **throws** — so the gap is **alarm-silent**
and the row rests at `status='sending'`. Accepted, not code-fixed: plan M10 marks the reserved-skip recovery
**optional** (`05-PLAN.md:84`), the window is sub-second per send, and the impact is one missing `missed` row
(no corruption, no patient-facing effect). **Operator signal:** an `outbound_message` stuck at
`status='sending'` well past its dose time. Revisit the M10 idempotent-create recovery only if such a row is
ever observed live.
