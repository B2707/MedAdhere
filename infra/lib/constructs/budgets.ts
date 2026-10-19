// infra/lib/constructs/budgets.ts
//
// BudgetsConstruct (D-11 / F55/F56) — an ACCOUNT-WIDE monthly cost budget, per RESEARCH Pattern 4.
// aws-cdk-lib/aws-budgets exposes only the L1 CfnBudget (no L2).
//
//   - budgetType COST, timeUnit MONTHLY, budgetLimit $100 USD.
//   - SIX notificationsWithSubscribers: ACTUAL @ {25,50,100} + FORECASTED @ {25,50,100}, all
//     thresholdType ABSOLUTE_VALUE ($ amounts, not %), each with an EMAIL subscriber = the SYNTH-TIME
//     LITERAL billing email (EMAIL-direct needs no SNS confirmation — RESEARCH A4).
//
// WR-01 — the EMAIL subscriber address MUST be a synth-time literal, NOT a `{{resolve:ssm}}` dynamic
// reference: AWS Budgets does not resolve dynamic references for a subscriber address, so an SSM
// token there is delivered to a non-existent literal "email" and the D-11 backstop never notifies.
// FoundationStack.resolveBillingEmail() sources it from `-c billingEmail=` / cdk.json context, so
// `props.billingEmail` is always a real literal here. Budget EMAIL is an independent AWS cost
// protection channel; it is not application or operations alert delivery.
//
// PURPOSE (F55): this is the runaway-cost FORECAST BACKSTOP for D-01's manual `cdk destroy` — it
// catches a NAT/RDS stack accidentally left deployed before month-end. It is NOT a per-service
// cost-allocation breakdown (that is a Cost Explorer capability fed by the D-17 tags + the F54 tag
// activation, NOT a budget property). No costFilters → account-wide.

import { Construct } from 'constructs';
import * as budgets from 'aws-cdk-lib/aws-budgets';

export interface BudgetsConstructProps {
  /**
   * The EMAIL-subscriber address — a SYNTH-TIME LITERAL (WR-01), never a `{{resolve:ssm}}` token
   * (AWS Budgets does not resolve dynamic references for a subscriber address). Sourced by
   * FoundationStack.resolveBillingEmail() from `-c billingEmail=` / cdk.json context.
   */
  readonly billingEmail: string;
}

type NotificationType = 'ACTUAL' | 'FORECASTED';

export class BudgetsConstruct extends Construct {
  public readonly budget: budgets.CfnBudget;

  constructor(scope: Construct, id: string, props: BudgetsConstructProps) {
    super(scope, id);

    const mk = (
      notificationType: NotificationType,
      threshold: number,
    ): budgets.CfnBudget.NotificationWithSubscribersProperty => ({
      notification: {
        notificationType,
        comparisonOperator: 'GREATER_THAN',
        threshold, // ABSOLUTE_VALUE → dollars, not a % of the limit
        thresholdType: 'ABSOLUTE_VALUE',
      },
      subscribers: [
        {
          subscriptionType: 'EMAIL', // EMAIL-direct: no SNS subscription-confirmation dance (A4)
          address: props.billingEmail,
        },
      ],
    });

    this.budget = new budgets.CfnBudget(this, 'CostBudget', {
      budget: {
        budgetName: 'medadhere-monthly',
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        budgetLimit: { amount: 100, unit: 'USD' },
        // No costFilters — this is an ACCOUNT-WIDE backstop (F55), not a per-service breakdown.
      },
      notificationsWithSubscribers: [
        mk('ACTUAL', 25),
        mk('ACTUAL', 50),
        mk('ACTUAL', 100),
        mk('FORECASTED', 25),
        mk('FORECASTED', 50),
        mk('FORECASTED', 100),
      ],
    });
  }
}
