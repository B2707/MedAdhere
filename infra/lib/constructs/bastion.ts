// infra/lib/constructs/bastion.ts
//
// BastionConstruct (D-09) — an on-demand SSM Session-Manager bastion, per RESEARCH Pattern 8.
//
//   - A t4g.micro EC2 in a PRIVATE_WITH_EGRESS subnet, SSM-managed (AmazonSSMManagedInstanceCore).
//     (t4g.micro, not nano: post-upgrade the account is on the AWS PAID Plan — t4g.micro is a
//     DELIBERATE COST CHOICE (it is stopped right after deploy, so the t4g.micro-vs-nano delta is
//     cost-negligible), NOT a free-plan constraint. The size is intentionally FIXED here — there is
//     no cdk.json lever — and the post-exec full review RATIFIED KEEP-micro (R2/FP-02): reverting to
//     nano would save <$0.01/mo and is not worth re-touching. Historical note: on the now-superseded
//     Free Plan, t4g.nano was NOT free-tier-eligible and was blocked outright at deploy — the original
//     micro bump came from that Free-Plan wall, but micro is retained on its own merits. t4g.micro IS
//     ARM64, so the AL2023 ARM AMI is unchanged.)
//     NOTE (post-exec review DEPLOY-4/COST-1): EC2 instances LAUNCH RUNNING — there is no "create
//     stopped" — so this bastion costs ~$3/mo while running. It is "on-demand" in the sense that
//     Plan 05 STOPS it right after deploy (`aws ec2 stop-instances`) and starts it only when a DB
//     tunnel is needed (~$0 compute while stopped, minus a few cents of EBS). NO inbound SG ports —
//     SSM is an outbound TLS channel; RDS stays private. A local dev runs
//     AWS-StartPortForwardingSessionToRemoteHost to tunnel localhost:5432 → RDS:5432.
//   - SG rule into RDS:5432 (db.connections.allowFrom(bastionSg, Port.tcp(5432))) — the second DB
//     ingress alongside the Lambda SG.
//   - ARM64 AL2023 AMI (ships a current SSM Agent ≥ 3.1.1374.0).

import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as rds from 'aws-cdk-lib/aws-rds';

export interface BastionConstructProps {
  readonly vpc: ec2.IVpc;
  readonly db: rds.DatabaseInstance;
}

export class BastionConstruct extends Construct {
  public readonly instance: ec2.Instance;
  public readonly bastionSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: BastionConstructProps) {
    super(scope, id);

    // No inbound ports — SSM is outbound-only (D-09). allowAllOutbound for the SSM TLS channel + the
    // RDS:5432 egress.
    this.bastionSg = new ec2.SecurityGroup(this, 'BastionSg', {
      vpc: props.vpc,
      description: 'MedAdhere SSM bastion SG (no inbound; SSM outbound-only, D-09)',
      allowAllOutbound: true,
    });

    const role = new iam.Role(this, 'BastionRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'AmazonSSMManagedInstanceCore',
        ),
      ],
    });

    this.instance = new ec2.Instance(this, 'Bastion', {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        ec2.InstanceSize.MICRO, // PAID-plan deliberate cost choice (stopped post-deploy), not a free-plan constraint; review R2/FP-02 ratified KEEP; stays ARM64
      ),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: this.bastionSg,
      role,
    });

    // The second RDS ingress rule (RESEARCH Pattern 8): bastion → RDS:5432 for ad-hoc inspection.
    props.db.connections.allowFrom(
      this.bastionSg,
      ec2.Port.tcp(5432),
      'Allow the SSM bastion to port-forward to RDS:5432',
    );
  }
}
