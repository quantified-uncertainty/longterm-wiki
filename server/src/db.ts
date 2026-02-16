import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://wiki:wiki_dev@localhost:5432/longterm_wiki";

/** Raw postgres.js connection (used for migrations & raw queries). */
export const sql = postgres(DATABASE_URL);

/** Drizzle ORM instance with typed schema. */
export const db = drizzle(sql, { schema });
