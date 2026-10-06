import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Fridge {
  id: string;
  name: string;
  invite_token: string;
  created_at: string;
}

export interface Member {
  id: string;
  fridge_id: string;
  device_id: string;
  nickname: string;
  created_at: string;
}

export type ItemStatus = "kept" | "claimed" | "used";

export interface Item {
  id: string;
  fridge_id: string;
  name: string;
  quantity: string | null;
  use_by: string | null;
  owner_member_id: string;
  shared: number;
  status: ItemStatus;
  claimed_by_member_id: string | null;
  claimed_at: string | null;
  used_by_member_id: string | null;
  used_at: string | null;
  created_at: string;
}

// /data is the Fly volume mounted by fly.toml; ./data is for running the app
// directly on a laptop. Either way this is the one place state lives — no
// in-memory fallback, no browser storage.
const dataDir = process.env.DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, "app.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Smallest schema that can carry the core interaction: a fridge has members
// (identified by browser, not account) and items. Visibility/claim state is
// `shared` + `status`, not a separate table — see CLAUDE.md for what each
// combination means and who may move an item between them.
db.exec(`
  CREATE TABLE IF NOT EXISTS fridges (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    invite_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS members (
    id TEXT PRIMARY KEY,
    fridge_id TEXT NOT NULL REFERENCES fridges(id),
    device_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (fridge_id, device_id)
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    fridge_id TEXT NOT NULL REFERENCES fridges(id),
    name TEXT NOT NULL,
    quantity TEXT,
    use_by TEXT,
    owner_member_id TEXT NOT NULL REFERENCES members(id),
    shared INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'kept' CHECK (status IN ('kept', 'claimed', 'used')),
    claimed_by_member_id TEXT REFERENCES members(id),
    claimed_at TEXT,
    used_by_member_id TEXT REFERENCES members(id),
    used_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS items_fridge_status_idx ON items (fridge_id, status);
`);
