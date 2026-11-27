import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Proposal, Grant, PublishedEvent } from "./types.ts";

interface Documents {
  cleanup: { id: string };
  event: PublishedEvent;
  grant: Grant;
  proposal: Proposal;
  revision: Proposal;
  seed: { id: string };
}
function decodeDocument<K extends keyof Documents>(
  _kind: K,
  input: string,
): Documents[K] {
  const value: unknown = JSON.parse(input);
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    throw new Error("Invalid stored document");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only typed put() writes this private database; signed evidence is verified again at use.
  return value as Documents[K];
}
export class PilotStore {
  db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const file = join(directory, "pilot.sqlite");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS history(seq INTEGER PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,proposal TEXT,org TEXT,detail TEXT);`);
  }
  get<K extends keyof Documents>(
    kind: K,
    id: string,
  ): Documents[K] | undefined {
    const r = this.db
      .prepare("SELECT value FROM documents WHERE kind=? AND id=?")
      .get(kind, id);
    return r ? decodeDocument(kind, String(r.value)) : undefined;
  }
  list<K extends keyof Documents>(kind: K): Documents[K][] {
    return this.db
      .prepare("SELECT value FROM documents WHERE kind=? ORDER BY rowid DESC")
      .all(kind)
      .map((r) => decodeDocument(kind, String(r.value)));
  }
  put<K extends keyof Documents>(kind: K, value: Documents[K]) {
    this.db
      .prepare(
        "INSERT INTO documents VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(kind, value.id, JSON.stringify(value));
  }
  proposal(id: string) {
    return this.get("proposal", id);
  }
  proposals() {
    return this.list("proposal");
  }
  grants() {
    return this.list("grant");
  }
  events() {
    return this.list("event");
  }
  audit(
    actor: string,
    action: string,
    proposal?: string,
    org?: string,
    detail?: string,
  ) {
    this.db
      .prepare(
        "INSERT INTO history(at,actor,action,proposal,org,detail) VALUES(?,?,?,?,?,?)",
      )
      .run(
        new Date().toISOString(),
        actor,
        action,
        proposal ?? null,
        org ?? null,
        detail ?? null,
      );
  }
  history(orgs: string[], subject: string) {
    return this.db
      .prepare("SELECT * FROM history ORDER BY seq DESC LIMIT 200")
      .all()
      .filter((r) => r.actor === subject || orgs.includes(String(r.org)));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
