// Issued attestations and an audit trail. The evidence behind a claim is never
// stored here: this holds what was stated, to whom, by whose authority, and
// every question asked about a restricted claim.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export class IssuerStore {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'issuer.sqlite');
    this.db = new DatabaseSync(file);
    try { chmodSync(file, 0o600); } catch { /* the file may be owned by the container user already */ }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS attestations (
        id TEXT PRIMARY KEY, claim_type TEXT NOT NULL, subject TEXT NOT NULL, claim TEXT NOT NULL,
        issued_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, visibility TEXT NOT NULL,
        jws TEXT NOT NULL, uri TEXT, cid TEXT);
      CREATE INDEX IF NOT EXISTS attestations_subject ON attestations (subject, claim_type);
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY, at TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL,
        actor TEXT, claim_type TEXT, subject TEXT, detail TEXT);`);
  }
  put(row) {
    this.db.prepare('INSERT INTO attestations (id,claim_type,subject,claim,issued_at,expires_at,visibility,jws,uri,cid) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.claimType, row.subject, JSON.stringify(row.claim), row.issuedAt, row.expiresAt, row.visibility, row.jws, row.uri ?? null, row.cid ?? null);
  }
  get(id) { return hydrate(this.db.prepare('SELECT * FROM attestations WHERE id=?').get(id)); }
  active(subject, claimType, now = new Date().toISOString()) {
    return this.db.prepare('SELECT * FROM attestations WHERE subject=? AND claim_type=? AND revoked_at IS NULL AND expires_at > ? ORDER BY issued_at DESC').all(subject, claimType, now).map(hydrate);
  }
  bySubject(subject) { return this.db.prepare('SELECT * FROM attestations WHERE subject=? ORDER BY issued_at DESC').all(subject).map(hydrate); }
  revoke(id, at = new Date().toISOString()) {
    return this.db.prepare('UPDATE attestations SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(at, id).changes > 0;
  }
  located(id, uri, cid) { this.db.prepare('UPDATE attestations SET uri=?, cid=? WHERE id=?').run(uri ?? null, cid ?? null, id); }
  audit(entry) {
    this.db.prepare('INSERT INTO audit (at,action,outcome,actor,claim_type,subject,detail) VALUES (?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), entry.action, entry.outcome, entry.actor ?? null, entry.claimType ?? null, entry.subject ?? null, entry.detail ?? null);
  }
  recentAudit(limit = 50) { return this.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(Math.min(Number(limit) || 50, 500)); }
  close() { this.db.close(); }
}

const hydrate = row => row && {
  id: row.id, claimType: row.claim_type, subject: row.subject, claim: JSON.parse(row.claim),
  issuedAt: row.issued_at, expiresAt: row.expires_at, revokedAt: row.revoked_at,
  visibility: row.visibility, jws: row.jws, uri: row.uri, cid: row.cid,
};
