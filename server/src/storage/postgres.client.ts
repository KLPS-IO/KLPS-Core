import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const TRANSIENT_DATABASE_ERRORS = [
  "database system is starting up",
  "connection terminated unexpectedly",
  "terminating connection due to administrator command",
  "econnreset",
  "etimedout",
  "57p03"
];

const wait = (ms: number) =>
  new Promise(resolve =>
    setTimeout(resolve, ms)
  );

const shouldRetryQuery = (
  error: unknown
) => {
  const message =
    error instanceof Error
      ? error.message
      : String(error);

  const normalized =
    message.toLowerCase();

  return TRANSIENT_DATABASE_ERRORS.some(
    transientError =>
      normalized.includes(
        transientError
      )
  );
};

const queryWithoutRetry =
  pool.query.bind(pool) as (
    ...args: any[]
  ) => Promise<any>;

pool.query = (async (
  ...args: any[]
) => {
  const maxAttempts = 8;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt += 1
  ) {
    try {
      return await queryWithoutRetry(
        ...args
      );
    }
    catch (error) {
      if (
        attempt >= maxAttempts ||
        !shouldRetryQuery(error)
      ) {
        throw error;
      }

      await wait(
        Math.min(2000, 500 * attempt)
      );
    }
  }

  return queryWithoutRetry(...args);
}) as typeof pool.query;
