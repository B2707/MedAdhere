// backend/src/schema-init/handler.ts
//
// CDK custom-resource (Provider framework) onEvent handler that applies the SSOT `schema.sql`
// to the private RDS PostgreSQL instance (D-03 / D-12). Wired + deployed by Plan 04/05.
//
//   - Delete  → strict NO-OP: returns success echoing the incoming PhysicalResourceId. DDL is
//               additive; teardown is `cdk destroy` of RDS itself (RESEARCH Assumption A5). There
//               is NO DROP and NO DB connection on Delete — the F65 unit test enforces this.
//   - Create/Update → fetch separate admin, internal-app, inbound-webhook, status-callback, and
//               offline-source-import credentials from Secrets Manager (no passwords in code/env),
//               connect with the admin credential, apply `schema.sql`, and idempotently align the
//               four non-DDL roles and exact table grants inside ONE transaction.
//   - Returns a STABLE PhysicalResourceId of "medadhere-schema" on every Create/Update. Returning
//               a FRESH id on Update would make CFN treat it as a replacement and Delete the old
//               resource mid-deploy (RESEARCH critical note / T-03-03). The unit test asserts this.
//
// Single-source TLS (F28): TLS is configured by ONE source — the explicit `ssl` object on the pg
// Client. M-2: the connection is encrypted (D-14 rds.force_ssl=1) AND the server certificate is
// VERIFIED against the pinned AWS RDS global CA bundle (rds-global-bundle.pem, bundled alongside this
// handler; `ssl:{ca, rejectUnauthorized:true}`). We do NOT also rely on a `PGSSLMODE` env var
// (node-postgres honors the explicit `ssl` object over `PGSSLMODE`, so a `PGSSLMODE` env would be
// dead, misleading config — Plan 04 likewise omits it from the function env).
//
// Module mode: CommonJS (F11) — `__dirname` + `readFileSync` resolve natively under NodeNext with
// no ESM rewrite, so the bundled `schema.sql` (copied alongside the handler by the Plan-04 CDK
// bundling step) is read directly. The CDK Provider framework handles CFN response signaling /
// timeout / failure — we do NOT hand-roll `cfn-response`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CdkCustomResourceEvent, CdkCustomResourceResponse } from 'aws-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Client } from 'pg';

/** STABLE physical id — identical for every Create/Update so CFN treats updates as updates. */
const PHYSICAL_RESOURCE_ID = 'medadhere-schema';

/** Reuse the Secrets Manager client across warm invocations. */
const secrets = new SecretsManagerClient({});

/** Shape of the CDK-generated DB credential secret (D-06). */
interface DbSecret {
  username: string;
  password: string;
}

const ADMIN_DB_USERNAME = 'medadhere_admin';

export const DATABASE_ROLE_USERNAMES = {
  application: 'medadhere_app',
  inbound: 'medadhere_inbound',
  statusCallback: 'medadhere_status_callback',
  sourceImport: 'medadhere_source_import',
} as const;

export interface DatabaseRolePasswords {
  readonly application: string;
  readonly inbound: string;
  readonly statusCallback: string;
  readonly sourceImport: string;
}

interface RoleGrant {
  readonly privileges: readonly ('SELECT' | 'INSERT' | 'UPDATE')[];
  readonly tables: readonly string[];
  readonly columns?: readonly string[];
}

interface RoleDefinition {
  readonly username: (typeof DATABASE_ROLE_USERNAMES)[keyof typeof DATABASE_ROLE_USERNAMES];
  readonly passwordKey: keyof DatabaseRolePasswords;
  readonly grants: readonly RoleGrant[];
}

const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const;

const COLUMN_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'] as const;

const DATABASE_ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    username: DATABASE_ROLE_USERNAMES.application,
    passwordKey: 'application',
    grants: [
      {
        privileges: ['SELECT'],
        tables: [
          'patient',
          'dose_schedule',
          'outbound_message',
          'inbound_reply',
          'adherence_record',
          'safety_events',
          'label_match',
          'source_release',
          'medication_identity_bridge',
          'evidence_record',
          'patient_medication',
          'patient_medication_ingredient',
          'ingredient_ddinter_map',
          'ddinter_drug',
          'medication_interaction',
          'clinical_fact',
          'turn_job',
          'agent_turn',
          'clinical_event',
          'clinical_event_source',
          'clinical_event_evidence',
          'information_need',
          'information_need_scope',
          'information_need_event_candidate',
          'information_need_transition',
          'clinical_review_item',
          'clinical_review_item_transition',
          'daily_summary',
          'clinician_review_draft',
          'clinician_review_action',
          'usage_bucket',
          'provider_circuit',
          'composer_control',
        ],
      },
      {
        privileges: ['INSERT'],
        tables: [
          'patient',
          'dose_schedule',
          'outbound_message',
          'adherence_record',
          'safety_events',
          'label_match',
          'patient_medication',
          'patient_medication_ingredient',
          'clinical_fact',
          'agent_turn',
          'clinical_event',
          'clinical_event_source',
          'clinical_event_evidence',
          'information_need',
          'information_need_scope',
          'information_need_event_candidate',
          'information_need_transition',
          'clinical_review_item',
          'clinical_review_item_transition',
          'daily_summary',
          'clinician_review_draft',
          'clinician_review_action',
          'usage_bucket',
          'provider_circuit',
          'composer_control',
        ],
      },
      {
        privileges: ['UPDATE'],
        tables: [
          'patient',
          'dose_schedule',
          'outbound_message',
          'inbound_reply',
          'adherence_record',
          'safety_events',
          'turn_job',
          'usage_bucket',
          'provider_circuit',
          'composer_control',
        ],
      },
    ],
  },
  {
    username: DATABASE_ROLE_USERNAMES.inbound,
    passwordKey: 'inbound',
    grants: [
      {
        privileges: ['SELECT'],
        tables: [
          'patient',
          'inbound_reply',
          'turn_job',
          'agent_turn',
          'safety_events',
          'usage_bucket',
        ],
      },
      {
        privileges: ['INSERT'],
        tables: ['inbound_reply', 'turn_job', 'safety_events', 'usage_bucket'],
      },
      {
        privileges: ['UPDATE'],
        tables: ['patient'],
        columns: [
          'provider_opted_in',
          'agent_enabled',
          'messaging_state_version',
          'opted_out_at',
          'next_inbound_sequence',
        ],
      },
      { privileges: ['UPDATE'], tables: ['inbound_reply', 'usage_bucket'] },
    ],
  },
  {
    username: DATABASE_ROLE_USERNAMES.statusCallback,
    passwordKey: 'statusCallback',
    grants: [{ privileges: ['SELECT', 'UPDATE'], tables: ['outbound_message'] }],
  },
  {
    username: DATABASE_ROLE_USERNAMES.sourceImport,
    passwordKey: 'sourceImport',
    grants: [
      { privileges: ['SELECT', 'INSERT', 'UPDATE'], tables: ['source_release'] },
      {
        privileges: ['INSERT'],
        tables: [
          'source_release_file',
          'evidence_record',
          'medication_identity_bridge',
          'ddinter_drug',
          'ingredient_ddinter_map',
          'medication_interaction',
        ],
      },
    ],
  },
];

function databaseRoleVerificationSql(databaseName: string): string {
  const targetRoles = DATABASE_ROLE_DEFINITIONS.map(({ username }) =>
    quoteSqlLiteral(username),
  ).join(', ');
  const expectedGrants = DATABASE_ROLE_DEFINITIONS.flatMap(({ username, grants }) =>
    grants.flatMap(({ privileges, tables, columns }) =>
      privileges.flatMap((privilegeType) =>
        tables.map((tableName) => ({ columns, roleName: username, tableName, privilegeType })),
      ),
    ),
  );
  const expectedGrantsJson = quoteSqlLiteral(JSON.stringify(expectedGrants));
  const databaseLiteral = quoteSqlLiteral(databaseName);
  const tablePrivileges = TABLE_PRIVILEGES.map(quoteSqlLiteral).join(', ');
  const columnPrivileges = COLUMN_PRIVILEGES.map(quoteSqlLiteral).join(', ');

  return `DO $verify_database_roles$
DECLARE
  target_roles text[] := ARRAY[${targetRoles}]::text[];
  expected_grants jsonb := ${expectedGrantsJson}::jsonb;
  violation text;
BEGIN
  IF (
    SELECT count(*)
      FROM pg_roles
     WHERE rolname = ANY(target_roles)
  ) <> cardinality(target_roles) THEN
    RAISE EXCEPTION 'database role ACL verification failed: a managed role is missing'
      USING ERRCODE = '42501';
  END IF;

  SELECT managed_role.rolname
    INTO violation
    FROM pg_roles managed_role
   WHERE managed_role.rolname = ANY(target_roles)
     AND (
       NOT managed_role.rolcanlogin
       OR managed_role.rolinherit
       OR managed_role.rolsuper
       OR managed_role.rolcreatedb
       OR managed_role.rolcreaterole
       OR managed_role.rolreplication
       OR managed_role.rolbypassrls
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: unsafe role attributes on %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT format('%I inherits %I', member.rolname, inherited.rolname)
    INTO violation
    FROM pg_auth_members membership
    JOIN pg_roles inherited ON inherited.oid = membership.roleid
    JOIN pg_roles member ON member.oid = membership.member
   WHERE member.rolname = ANY(target_roles)
      OR (
        -- PostgreSQL 16 records the CREATEROLE administrator's ADMIN OPTION as a membership.
        -- Preserve only that current deploy principal; every other managed-role consumer is drift.
        inherited.rolname = ANY(target_roles)
        AND member.rolname <> current_user
      )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: unexpected membership %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT managed_role.role_name
    INTO violation
    FROM unnest(target_roles) AS managed_role(role_name)
   WHERE NOT has_database_privilege(managed_role.role_name, ${databaseLiteral}, 'CONNECT')
      OR has_database_privilege(managed_role.role_name, ${databaseLiteral}, 'CREATE')
      OR has_database_privilege(managed_role.role_name, ${databaseLiteral}, 'TEMPORARY')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: database privileges on %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT managed_role.role_name
    INTO violation
    FROM unnest(target_roles) AS managed_role(role_name)
   WHERE NOT has_schema_privilege(managed_role.role_name, 'public', 'USAGE')
      OR has_schema_privilege(managed_role.role_name, 'public', 'CREATE')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: schema privileges on %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT format('public.%I owned by %I', relation.relname, owner_role.rolname)
    INTO violation
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_roles owner_role ON owner_role.oid = relation.relowner
   WHERE namespace.nspname = 'public'
     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND owner_role.rolname <> current_user
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: unexpected object owner %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT format('%I %s on public.%I', managed_role.role_name, privilege.privilege_type, relation.relname)
    INTO violation
    FROM unnest(target_roles) AS managed_role(role_name)
    CROSS JOIN unnest(ARRAY[${tablePrivileges}]::text[]) AS privilege(privilege_type)
    CROSS JOIN pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND has_table_privilege(
       managed_role.role_name,
       relation.oid,
       privilege.privilege_type
     ) IS DISTINCT FROM EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(expected_grants) AS expected(
           "roleName" text,
           "tableName" text,
           "privilegeType" text,
           columns jsonb
         )
        WHERE expected."roleName" = managed_role.role_name
          AND expected."tableName" = relation.relname
          AND expected."privilegeType" = privilege.privilege_type
          AND expected.columns IS NULL
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: effective table privilege %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT format('%I %s on columns of public.%I', managed_role.role_name, privilege.privilege_type, relation.relname)
    INTO violation
    FROM unnest(target_roles) AS managed_role(role_name)
    CROSS JOIN unnest(ARRAY[${columnPrivileges}]::text[]) AS privilege(privilege_type)
    CROSS JOIN pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
   WHERE namespace.nspname = 'public'
     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND has_any_column_privilege(
       managed_role.role_name,
       relation.oid,
       privilege.privilege_type
     ) IS DISTINCT FROM EXISTS (
       SELECT 1
         FROM jsonb_to_recordset(expected_grants) AS expected(
           "roleName" text,
           "tableName" text,
           "privilegeType" text,
           columns jsonb
         )
        WHERE expected."roleName" = managed_role.role_name
          AND expected."tableName" = relation.relname
          AND expected."privilegeType" = privilege.privilege_type
          AND (
            expected.columns IS NULL
            OR EXISTS (
              SELECT 1
                FROM jsonb_array_elements_text(expected.columns) AS expected_column(column_name)
                JOIN pg_attribute expected_attribute
                  ON expected_attribute.attrelid = relation.oid
                 AND expected_attribute.attname = expected_column.column_name
               WHERE expected_attribute.attnum > 0
                 AND NOT expected_attribute.attisdropped
                 AND has_column_privilege(
                   managed_role.role_name,
                   expected_attribute.attrelid,
                   expected_attribute.attname,
                   privilege.privilege_type
                 )
            )
          )
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: effective column privilege %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT format(
    '%s ACL %s on public.%I',
    COALESCE(direct_grantee.rolname, 'PUBLIC'),
    direct_acl.privilege_type,
    relation.relname
  )
    INTO violation
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(relation.relacl) AS direct_acl
    LEFT JOIN pg_roles direct_grantee ON direct_grantee.oid = direct_acl.grantee
   WHERE namespace.nspname = 'public'
     AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND (direct_acl.grantee = 0 OR direct_grantee.rolname = ANY(target_roles))
     AND (
       direct_acl.grantee = 0
       OR direct_acl.is_grantable
       OR direct_acl.grantor <> relation.relowner
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_to_recordset(expected_grants) AS expected(
             "roleName" text,
             "tableName" text,
             "privilegeType" text,
             columns jsonb
           )
          WHERE expected."roleName" = direct_grantee.rolname
            AND expected."tableName" = relation.relname
            AND expected."privilegeType" = direct_acl.privilege_type
            AND expected.columns IS NULL
       )
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: unexpected direct relation %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT format(
    '%s ACL %s on public.%I.%I',
    COALESCE(direct_grantee.rolname, 'PUBLIC'),
    direct_acl.privilege_type,
    relation.relname,
    attribute.attname
  )
    INTO violation
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(attribute.attacl) AS direct_acl
    LEFT JOIN pg_roles direct_grantee ON direct_grantee.oid = direct_acl.grantee
   WHERE namespace.nspname = 'public'
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
     AND (direct_acl.grantee = 0 OR direct_grantee.rolname = ANY(target_roles))
     AND (
       direct_acl.grantee = 0
       OR direct_acl.is_grantable
       OR direct_acl.grantor <> relation.relowner
       OR NOT EXISTS (
         SELECT 1
           FROM jsonb_to_recordset(expected_grants) AS expected(
             "roleName" text,
             "tableName" text,
             "privilegeType" text,
             columns jsonb
           )
          WHERE expected."roleName" = direct_grantee.rolname
            AND expected."tableName" = relation.relname
            AND expected."privilegeType" = direct_acl.privilege_type
            AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements_text(expected.columns) AS expected_column(column_name)
               WHERE expected_column.column_name = attribute.attname
            )
       )
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: unexpected direct column %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT format('%s database ACL %s', COALESCE(direct_grantee.rolname, 'PUBLIC'), direct_acl.privilege_type)
    INTO violation
    FROM pg_database database_object
    CROSS JOIN LATERAL aclexplode(database_object.datacl) AS direct_acl
    LEFT JOIN pg_roles direct_grantee ON direct_grantee.oid = direct_acl.grantee
   WHERE database_object.datname = ${databaseLiteral}
     AND (direct_acl.grantee = 0 OR direct_grantee.rolname = ANY(target_roles))
     AND (
       direct_acl.grantee = 0
       OR direct_acl.privilege_type <> 'CONNECT'
       OR direct_acl.is_grantable
       OR direct_acl.grantor <> database_object.datdba
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: unexpected direct database %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT format('%s schema ACL %s', COALESCE(direct_grantee.rolname, 'PUBLIC'), direct_acl.privilege_type)
    INTO violation
    FROM pg_namespace namespace
    CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS direct_acl
    LEFT JOIN pg_roles direct_grantee ON direct_grantee.oid = direct_acl.grantee
   WHERE namespace.nspname = 'public'
     AND (direct_acl.grantee = 0 OR direct_grantee.rolname = ANY(target_roles))
     AND (
       direct_acl.grantee = 0
       OR direct_acl.privilege_type <> 'USAGE'
       OR direct_acl.is_grantable
       OR direct_acl.grantor <> namespace.nspowner
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: unexpected direct schema %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT format(
    '%s default ACL %s',
    COALESCE(direct_grantee.rolname, 'PUBLIC'),
    direct_acl.privilege_type
  )
    INTO violation
    FROM pg_default_acl defaults
    LEFT JOIN pg_namespace namespace ON namespace.oid = defaults.defaclnamespace
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS direct_acl
    LEFT JOIN pg_roles direct_grantee ON direct_grantee.oid = direct_acl.grantee
   WHERE defaults.defaclobjtype IN ('r', 'S')
     AND (defaults.defaclnamespace = 0 OR namespace.nspname = 'public')
     AND (direct_acl.grantee = 0 OR direct_grantee.rolname = ANY(target_roles))
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: unexpected %', violation
      USING ERRCODE = '42501';
  END IF;

  SELECT format('%I %s on public.%I', managed_role.role_name, privilege.privilege_type, sequence.relname)
    INTO violation
    FROM unnest(target_roles) AS managed_role(role_name)
    CROSS JOIN unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']::text[]) AS privilege(privilege_type)
    CROSS JOIN pg_class sequence
    JOIN pg_namespace namespace ON namespace.oid = sequence.relnamespace
   WHERE namespace.nspname = 'public'
     AND sequence.relkind = 'S'
     AND has_sequence_privilege(
       managed_role.role_name,
       sequence.oid,
       privilege.privilege_type
     )
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'database role ACL verification failed: effective sequence privilege %', violation
      USING ERRCODE = '42501';
  END IF;
END
$verify_database_roles$;`;
}

async function readDbSecret(secretArn: string): Promise<DbSecret> {
  const value = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!value.SecretString) {
    throw new Error('DB secret has no SecretString — secret not populated');
  }
  const parsed = JSON.parse(value.SecretString) as Partial<DbSecret>;
  if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
    throw new Error('DB secret must contain username and password strings');
  }
  return { username: parsed.username, password: parsed.password };
}

function quoteSqlLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('DB password contains an unsupported null byte');
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteSqlIdentifier(value: string): string {
  if (value.includes('\0')) throw new Error('DB name contains an unsupported null byte');
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Repeat-safe role/password alignment. Every invocation first removes stale current/default ACLs,
 * then grants only the reviewed table matrix. The schema currently uses UUID defaults rather than
 * identity sequences, so runtime and loader roles intentionally receive zero sequence privileges.
 */
export function databaseRolesSql(databaseName: string, passwords: DatabaseRolePasswords): string {
  const database = quoteSqlIdentifier(databaseName);
  const roleNames = DATABASE_ROLE_DEFINITIONS.map(({ username }) => quoteSqlLiteral(username)).join(
    ', ',
  );
  const createRoles = DATABASE_ROLE_DEFINITIONS.map(
    ({ username }) => `  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${username}') THEN
    CREATE ROLE ${username} LOGIN;
  END IF;`,
  ).join('\n');

  const alignRoles = DATABASE_ROLE_DEFINITIONS.map(({ username, passwordKey, grants }) => {
    const exactGrants = grants
      .map(({ privileges, tables, columns }) => {
        const columnList = columns === undefined ? '' : ` (${columns.join(', ')})`;
        return `GRANT ${privileges.join(', ')}${columnList} ON TABLE ${tables.join(', ')} TO ${username};`;
      })
      .join('\n');
    return `ALTER ROLE ${username}
  WITH LOGIN NOINHERIT NOCREATEDB NOCREATEROLE
  PASSWORD ${quoteSqlLiteral(passwords[passwordKey])};
REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM ${username};
GRANT CONNECT ON DATABASE ${database} TO ${username};
REVOKE ALL ON SCHEMA public FROM ${username};
GRANT USAGE ON SCHEMA public TO ${username};
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${username};
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${username};
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM ${username};
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${username};
${exactGrants}`;
  }).join('\n');

  return `DO $database_roles$
BEGIN
${createRoles}
END
$database_roles$;
DO $database_role_memberships$
DECLARE role_membership record;
BEGIN
  FOR role_membership IN
    SELECT inherited.rolname AS inherited_role, member.rolname AS member_role
      FROM pg_auth_members auth_membership
      JOIN pg_roles inherited ON inherited.oid = auth_membership.roleid
      JOIN pg_roles member ON member.oid = auth_membership.member
     WHERE member.rolname IN (${roleNames})
        OR (
          -- Preserve the current PostgreSQL 16 role administrator's required ADMIN OPTION entry.
          inherited.rolname IN (${roleNames})
          AND member.rolname <> current_user
        )
  LOOP
    EXECUTE format(
      'REVOKE %I FROM %I CASCADE',
      role_membership.inherited_role,
      role_membership.member_role
    );
  END LOOP;
END
$database_role_memberships$;
REVOKE ALL PRIVILEGES ON DATABASE ${database} FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
${alignRoles}
${databaseRoleVerificationSql(databaseName)}`;
}

export async function handler(event: CdkCustomResourceEvent): Promise<CdkCustomResourceResponse> {
  // Delete: strict no-op. No secret fetch, no DB connection, no query, NO DROP. Echo the id.
  if (event.RequestType === 'Delete') {
    return { PhysicalResourceId: event.PhysicalResourceId };
  }

  // Create / Update: fetch all DB passwords (never hard-coded), then apply schema + roles atomically.
  const adminSecretArn = process.env.DB_ADMIN_SECRET_ARN;
  const appSecretArn = process.env.DB_APP_SECRET_ARN;
  const inboundSecretArn = process.env.DB_INBOUND_SECRET_ARN;
  const statusCallbackSecretArn = process.env.DB_STATUS_CALLBACK_SECRET_ARN;
  const sourceImportSecretArn = process.env.DB_SOURCE_IMPORT_SECRET_ARN;
  if (
    !adminSecretArn ||
    !appSecretArn ||
    !inboundSecretArn ||
    !statusCallbackSecretArn ||
    !sourceImportSecretArn
  ) {
    throw new Error('DB role secret ARN env vars must all be set');
  }
  const adminCredential = await readDbSecret(adminSecretArn);
  const appCredential = await readDbSecret(appSecretArn);
  const inboundCredential = await readDbSecret(inboundSecretArn);
  const statusCallbackCredential = await readDbSecret(statusCallbackSecretArn);
  const sourceImportCredential = await readDbSecret(sourceImportSecretArn);
  const expectedCredentials = [
    [adminCredential, ADMIN_DB_USERNAME],
    [appCredential, DATABASE_ROLE_USERNAMES.application],
    [inboundCredential, DATABASE_ROLE_USERNAMES.inbound],
    [statusCallbackCredential, DATABASE_ROLE_USERNAMES.statusCallback],
    [sourceImportCredential, DATABASE_ROLE_USERNAMES.sourceImport],
  ] as const;
  for (const [credential, expectedUsername] of expectedCredentials) {
    if (credential.username !== expectedUsername) {
      throw new Error(`DB secret username must be ${expectedUsername}`);
    }
  }

  // WR-04 — defense-in-depth: guard DB_HOST/DB_PORT/DB_NAME (the construct sets all three, so this
  // catches future drift / a misconfigured deploy) with the SAME actionable-error posture as the
  // secret-ARN guard. Without these, `host: undefined` / `Number(undefined) === NaN` would surface
  // an opaque pg connection error from inside a CFN custom resource → a full VPC/NAT/RDS rollback.
  const { DB_HOST, DB_PORT, DB_NAME } = process.env;
  if (!DB_HOST || !DB_PORT || !DB_NAME) {
    throw new Error('DB_HOST / DB_PORT / DB_NAME env vars must all be set');
  }
  const port = Number(DB_PORT);
  if (!Number.isInteger(port)) {
    throw new Error(`DB_PORT is not a valid integer port: ${DB_PORT}`);
  }

  // schema.sql is bundled alongside this handler by the CDK bundling step (Plan 04, F01/F03).
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

  // M-2 — pin the AWS RDS global CA bundle and VERIFY the server certificate. The bundle
  // (rds-global-bundle.pem, fetched from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem)
  // is copied alongside this handler by the CDK bundling step (same afterBundling cp mechanism as
  // schema.sql). Reading it + `rejectUnauthorized:true` upgrades the connection from
  // encrypted-but-unverified to encrypted-AND-server-authenticated, closing the SEC W-2 residual and
  // setting the correct TLS template for the Phase-2 data-API. Still single-source TLS (F28): ONE
  // explicit pg `ssl` object, no PGSSLMODE.
  const rdsCaBundle = readFileSync(join(__dirname, 'rds-global-bundle.pem'), 'utf8');

  const client = new Client({
    host: DB_HOST,
    port,
    user: adminCredential.username,
    password: adminCredential.password,
    database: DB_NAME,
    // F28 single-source TLS: configured by ONE source — this explicit `ssl` object (no PGSSLMODE
    // reliance). M-2: the connection is ENCRYPTED (rds.force_ssl=1, enforced server-side) AND the
    // server certificate is now VERIFIED against the pinned RDS CA bundle (rejectUnauthorized:true).
    ssl: { ca: rdsCaBundle, rejectUnauthorized: true },
  });

  await client.connect();
  let applyError: unknown;
  let applyFailed = false;
  try {
    await client.query('BEGIN');
    await client.query(sql); // whole file: guarded additive DDL, applied atomically (D-12)
    await client.query(
      databaseRolesSql(DB_NAME, {
        application: appCredential.password,
        inbound: inboundCredential.password,
        statusCallback: statusCallbackCredential.password,
        sourceImport: sourceImportCredential.password,
      }),
    );
    await client.query('COMMIT');
  } catch (err) {
    // Post-exec review CORR-1: a failing ROLLBACK must not mask the original schema-apply error.
    try {
      await client.query('ROLLBACK');
    } catch {
      /* swallow — preserve and rethrow the original error below */
    }
    applyError = err;
    applyFailed = true;
  }
  try {
    await client.end();
  } catch (endError) {
    // Cleanup failure is actionable only after a successful apply. It must never replace the
    // transaction failure that CloudFormation needs in order to explain why schema-init failed.
    if (!applyFailed) throw endError;
  }
  if (applyFailed) throw applyError;

  // STABLE id on every Create/Update (T-03-03): updates stay updates, never replacements.
  return { PhysicalResourceId: PHYSICAL_RESOURCE_ID };
}
