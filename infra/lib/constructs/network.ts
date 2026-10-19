// infra/lib/constructs/network.ts
//
// NetworkConstruct (INFRA-05 / D-01) — the VPC baseline every later Lambda + the data-API
// (Phase 2) attaches to.
//
//   - VPC: 2 AZs, PRIVATE_WITH_EGRESS subnets, ONE managed NAT Gateway (D-01 — never 0, never
//     per-AZ; the SMS egress path was once broken by a no-NAT topology, the reversed plan).
//   - Interface VPC endpoints: Secrets Manager UNCONDITIONALLY (the schema-init + smoke Lambdas reach
//     it without a NAT round-trip). It sits on a DEDICATED endpoint security group (F24) with
//     `open: false` — otherwise CDK defaults `open: true` and opens 443 to the whole VPC CIDR. We add
//     a single scoped ingress rule from the Lambda SG.
//   - S3 GATEWAY endpoint (free; D-01).
//   - DELIBERATELY NO CloudWatch Logs / EventBridge / Scheduler interface endpoint — that traffic
//     routes via the NAT on purpose (D-01 / D-15 / 260612-prv). Adding one here is a cost regression.
//
// Exposes `vpc`, `lambdaSg` (the SG every in-VPC Lambda joins — RDS admits only this SG + the
// bastion SG on 5432), and `endpointSg` for assertions.

import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export class NetworkConstruct extends Construct {
  /** The single Phase-1 VPC (2 AZs, ONE NAT). */
  public readonly vpc: ec2.Vpc;
  /** The security group every in-VPC Lambda (schema-init + both smoke + future data-API) joins. */
  public readonly lambdaSg: ec2.SecurityGroup;
  /** The dedicated interface-endpoint SG (F24) — admits only the Lambda SG on 443. */
  public readonly endpointSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // --- VPC: 2 AZs, private-with-egress subnets, ONE NAT Gateway (D-01) ------------------------
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1, // D-01 — ONE managed NAT (never 0, never per-AZ)
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // --- Security groups -------------------------------------------------------------------------
    // The Lambda SG: every in-VPC function joins this. RDS (database.ts) and the interface
    // endpoints admit only this SG. No ingress rules — Lambdas are egress-only clients.
    this.lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: this.vpc,
      description: 'MedAdhere in-VPC Lambda security group (schema-init + smoke + data-API)',
      allowAllOutbound: true,
    });

    // The dedicated endpoint SG (F24): interface endpoints attach here with `open: false` so CDK
    // does NOT open 443 to the whole VPC CIDR. We add ONE scoped ingress rule from the Lambda SG.
    this.endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc: this.vpc,
      description: 'MedAdhere interface-endpoint security group (Lambda SG only, 443)',
      allowAllOutbound: true,
    });
    this.endpointSg.addIngressRule(
      this.lambdaSg,
      ec2.Port.tcp(443),
      'Allow the in-VPC Lambdas to reach the Secrets Manager interface endpoint',
    );

    // --- Interface VPC endpoint: Secrets Manager -------------------------------------------------
    // `open: false` + the scoped endpoint SG (F24); private DNS on (default true) so the SDK clients
    // resolve the service hostname to the endpoint ENIs without code changes.
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      securityGroups: [this.endpointSg],
      open: false,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    // --- S3 GATEWAY endpoint (free; D-01) --------------------------------------------------------
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // DELIBERATELY no CloudWatch Logs / EventBridge / Scheduler interface endpoint — that traffic
    // routes via the NAT on purpose (D-01). Do NOT add one here (cost regression).
  }
}
