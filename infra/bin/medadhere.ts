#!/usr/bin/env node
// infra/bin/medadhere.ts
//
// CDK app entry (run via `npx tsx bin/medadhere.ts`, registered in cdk.json's `app` key — F09/F10/
// F11). Instantiates the single FoundationStack (D-07) and applies the standard app-level tag set
// (D-17).
//
// F59 — stack-level termination protection: the `validationWindow` context flag (cdk.json or
// `-c validationWindow=true`) drives BOTH the stack-level `terminationProtection` StackProp AND the
// forwarded `validationWindow` → DatabaseConstruct `deletionProtection`. Termination protection is a
// Stack-level prop and cannot live inside a construct. Default false (INFRA-04 clean teardown);
// flip true only during the P7 validation window (2026-08-26 – 2026-09-05, DATA-02).

import { App, Tags } from 'aws-cdk-lib';
import { FoundationStack } from '../lib/foundation-stack.js';
import { parseBackupRetentionDays } from '../lib/context.js';
import { applyNag } from '../lib/nag.js';

const app = new App();

// F59 — the P7 toggle. Accept BOTH the JSON boolean `true` (cdk.json / programmatic context) AND
// the string "true" (CLI `-c validationWindow=true`, which arrives as a string). Any other value
// (incl. absent / false / "false") is false (INFRA-04 default clean teardown).
const vwCtx = app.node.tryGetContext('validationWindow');
const validationWindow = vwCtx === true || vwCtx === 'true';

// Region: us-east-1 (project decision record). Read from context with the pinned default.
const region =
  (app.node.tryGetContext('region') as string | undefined) ?? 'us-east-1';

// RDS automated-backup retention (days), parsed + validated from context (cdk.json number or a CLI
// string `-c backupRetentionDays=N`). Default 7 (DATA-02 ">=7-day backups from first deploy") — the
// account is on the Paid Plan, so 7 deploys cleanly. Set 0 ONLY as the exceptional override for a
// free-plan-restricted account (which rejects >0); the FoundationStack DATA-02 guard still hard-fails
// synth if validationWindow=true with <7. Garbage input throws loudly (never silently disables backups).
const backupRetentionDays = parseBackupRetentionDays(
  app.node.tryGetContext('backupRetentionDays'),
);

const stack = new FoundationStack(app, 'MedAdhereFoundation', {
  env: { region },
  // F59 — stack-level termination protection mirrors the validation-window flag.
  terminationProtection: validationWindow,
  // Forwarded to DatabaseConstruct as deletionProtection (F59).
  validationWindow,
  // Forwarded to DatabaseConstruct as backupRetention (days). Default 7 (DATA-02; Paid Plan). 0 is the
  // exceptional free-plan override.
  backupRetentionDays,
});

// W0.3b (audit LOW-19) — cdk-nag AwsSolutions pack + per-finding accepted-disposition
// suppressions (infra/lib/nag.ts). Any NEW unsuppressed finding fails `cdk synth` — this is the
// CI IaC gate. The raw unsuppressed view stays at scan/cdk-nag-scan.ts.
applyNag(app, stack);

// D-17 — the standard app-level tag set on every resource. ~5 lines via Tags.of(app).
Tags.of(app).add('project', 'medadhere');
Tags.of(app).add('phase', '02-auth-dashboard-shell');
Tags.of(app).add('owner', 'bader');
Tags.of(app).add('managed-by', 'cdk');
