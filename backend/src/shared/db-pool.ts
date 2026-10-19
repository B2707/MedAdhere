import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';

interface SecretReader {
  send(command: GetSecretValueCommand): Promise<{ SecretString?: string }>;
}

interface DbSecret {
  username: string;
  password: string;
}

function readRdsCaBundle(): string {
  try {
    return readFileSync(join(__dirname, 'rds-global-bundle.pem'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return readFileSync(join(__dirname, '..', 'schema-init', 'rds-global-bundle.pem'), 'utf8');
  }
}

/**
 * Return a handler-local lazy pool getter. Every Lambda calls this factory once at
 * module scope, so warm invocations reuse a max-2 pool while separate handlers keep
 * independent connection state. TLS always verifies against the bundled AWS RDS CA.
 */
export function createDbPoolProvider(secrets: SecretReader): () => Promise<Pool> {
  let pool: Pool | undefined;

  return async () => {
    if (pool) return pool;

    const dbSecretArn = process.env.DB_SECRET_ARN;
    if (!dbSecretArn) throw new Error('DB_SECRET_ARN env var is not set');

    const { DB_HOST, DB_PORT, DB_NAME } = process.env;
    if (!DB_HOST || !DB_PORT || !DB_NAME) {
      throw new Error('DB_HOST / DB_PORT / DB_NAME env vars must all be set');
    }

    const port = Number(DB_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`DB_PORT is not a valid TCP port (1-65535): ${DB_PORT}`);
    }

    const secretValue = await secrets.send(new GetSecretValueCommand({ SecretId: dbSecretArn }));
    if (!secretValue.SecretString) {
      throw new Error('DB secret has no SecretString — secret not populated');
    }
    const { username, password } = JSON.parse(secretValue.SecretString) as DbSecret;
    const rdsCaBundle = readRdsCaBundle();
    const tlsServername = process.env.DB_TLS_SERVERNAME?.trim();

    pool = new Pool({
      host: DB_HOST,
      port,
      database: DB_NAME,
      user: username,
      password,
      max: 2,
      ssl: {
        ca: rdsCaBundle,
        rejectUnauthorized: true,
        ...(tlsServername ? { servername: tlsServername } : {}),
      },
    });
    return pool;
  };
}
