import pg from 'pg';

export interface DbResult<T> {
  rowCount: number;
  rows: T[];
}

export interface DbClient {
  query<T>(sql: string, params?: unknown[]): Promise<DbResult<T>>;
  release(error?: boolean | Error): void;
}

export interface DbPool {
  connect(): Promise<DbClient>;
  end(): Promise<void>;
  getClient(): Promise<DbClient>;
  query<T>(sql: string, params?: unknown[]): Promise<DbResult<T>>;
}

export interface DbConfig {
  connectionString?: string;
  connectionTimeoutMillis?: number;
  idleInTransactionTimeoutMs?: number;
  idleTimeoutMillis?: number;
  max?: number;
  pgOptions?: Record<string, unknown>;
  statementTimeoutMs?: number;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

export function assertLocalDatabaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('AI_MEMORY_DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('AI_MEMORY_DATABASE_URL must use PostgreSQL.');
  }
  if (!LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('AI_MEMORY_DATABASE_URL must target a loopback host.');
  }
  if (!/^\/[a-z0-9_-]+$/iu.test(parsed.pathname)) {
    throw new Error('AI_MEMORY_DATABASE_URL must name a local database.');
  }
  const overrides = new Set(['database', 'dbname', 'host', 'hostaddr', 'port', 'service', 'servicefile']);
  if ([...parsed.searchParams.keys()].some(key => overrides.has(key.toLowerCase()))) {
    throw new Error('AI_MEMORY_DATABASE_URL must not override its target in query parameters.');
  }
  return value;
}

export function redactDatabaseUrl(value: unknown): string {
  if (typeof value !== 'string') return '<invalid database url>';
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '<invalid database url>';
  }
}

export function createPool(config: DbConfig = {}): DbPool {
  let pool: pg.Pool | undefined;
  let ended = false;
  const getPool = (): pg.Pool => {
    if (ended) throw new Error('Database pool has already been ended.');
    if (pool !== undefined) return pool;
    const connectionString = config.connectionString ?? process.env.AI_MEMORY_DATABASE_URL;
    if (connectionString === undefined || connectionString.trim().length === 0) {
      throw new Error('AI_MEMORY_DATABASE_URL is required for the local ai-memory database.');
    }
    assertLocalDatabaseUrl(connectionString);
    const options: pg.PoolConfig = {
      ...config.pgOptions,
      connectionString,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 20_000,
      idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
      max: config.max ?? 10,
    };
    const sessionOptions: string[] = [];
    const statementTimeout = config.statementTimeoutMs ?? 300_000;
    const idleTimeout = config.idleInTransactionTimeoutMs ?? 300_000;
    if (statementTimeout > 0) sessionOptions.push(`-c statement_timeout=${String(statementTimeout)}`);
    if (idleTimeout > 0) sessionOptions.push(`-c idle_in_transaction_session_timeout=${String(idleTimeout)}`);
    const existing = typeof options.options === 'string' ? options.options.trim() : '';
    if (existing || sessionOptions.length > 0)
      options.options = [existing, ...sessionOptions].filter(Boolean).join(' ');
    pool = new pg.Pool(options);
    return pool;
  };
  const wrapClient = (client: pg.PoolClient): DbClient => ({
    async query<T>(sql: string, params?: unknown[]): Promise<DbResult<T>> {
      const result = await client.query(sql, params);
      return { rowCount: result.rowCount ?? 0, rows: result.rows as T[] };
    },
    release(error) {
      client.release(error);
    },
  });
  return {
    async connect() {
      return wrapClient(await getPool().connect());
    },
    async end() {
      ended = true;
      if (pool !== undefined) await pool.end();
    },
    async getClient() {
      return wrapClient(await getPool().connect());
    },
    async query<T>(sql: string, params?: unknown[]): Promise<DbResult<T>> {
      const result = await getPool().query(sql, params);
      return { rowCount: result.rowCount ?? 0, rows: result.rows as T[] };
    },
  };
}
