#!/usr/bin/env node
// infra/scan/cdk-nag-scan.ts
//
// NON-INVASIVE cdk-nag security/best-practice scan of the FoundationStack.
//
// This is a REVIEW HARNESS ONLY — it is deliberately separate from the deployed app entry
// (bin/medadhere.ts), so the committed synth path, the 87/87 test suite, and `cdk deploy` are
// completely unaffected. It instantiates the same FoundationStack with default (non-validation)
// props and applies the cdk-nag AwsSolutions rule pack so a `cdk synth` against THIS app emits the
// IaC findings (open SGs, public RDS, over-broad IAM, missing encryption, etc.) as Annotations.
//
// Run:  cd infra && npx cdk synth --app "npx tsx scan/cdk-nag-scan.ts" --quiet
// (Added for the Phase-1-exit review after a survey of IaC scanning tools — cdk-nag is the
// one genuine IaC-scanning gap. Whether to wire AwsSolutionsChecks permanently into bin/medadhere.ts
// is a decision the review synthesis will make.)

import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { FoundationStack } from '../lib/foundation-stack.js';

const app = new App();

// Default (non-validation-window) props — the normal default-deploy shape (backups 7, no deletion
// protection), which is what a reviewer wants to scan.
new FoundationStack(app, 'MedAdhereFoundationNagScan', {
  env: { region: 'us-east-1' },
});

// AwsSolutions rule pack, verbose so each finding carries its explanation text.
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
