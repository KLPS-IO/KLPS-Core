// server/src/config/db.ts

import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const isProduction =
  process.env.NODE_ENV === "production";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL is not defined in .env"
  );
}

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL,

  ssl: isProduction
    ? { rejectUnauthorized: false }
    : false
});

export default pool;