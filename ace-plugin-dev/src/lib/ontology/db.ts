// Read-only DuckDB connection for the ENACT closure-table database.
//
// The DB file is produced by scripts/build-ontology-db.sh from the .dsv files
// at $ENACT_TC_DIR. Path is controlled by env var:
//   ENACT_DUCKDB_PATH=/abs/path/to/enact_ontology.duckdb
//
// Requires: npm i @duckdb/node-api

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

let connectionPromise: Promise<DuckDBConnection> | null = null;

// The ENACT ontology DuckDB (~5.2 GB) is distributed SEPARATELY — it is not in
// this repo. Drop it at ./data/enact_ontology.duckdb, or set ENACT_DUCKDB_PATH
// to wherever you placed it. See README → "Ontology database".
const DEFAULT_PATH = "data/enact_ontology.duckdb";

function dbPath(): string {
  return process.env.ENACT_DUCKDB_PATH || DEFAULT_PATH;
}

async function openConnection(): Promise<DuckDBConnection> {
  const instance = await DuckDBInstance.create(dbPath(), {
    access_mode: "READ_ONLY",
  });
  return instance.connect();
}

function getConnection(): Promise<DuckDBConnection> {
  if (!connectionPromise) connectionPromise = openConnection();
  return connectionPromise;
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: Array<string | number | null> = []
): Promise<T[]> {
  const conn = await getConnection();
  const reader = await conn.runAndReadAll(sql, params);
  return reader.getRowObjectsJson() as T[];
}

export async function tableExists(table: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*)::INTEGER AS n FROM information_schema.tables
     WHERE table_schema = 'main' AND table_name = $1`,
    [table]
  );
  return (rows[0]?.n ?? 0) > 0;
}
