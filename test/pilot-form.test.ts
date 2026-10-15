import assert from "node:assert/strict";
import { test } from "node:test";

import { proposalTerms } from "../public/pilot/form.ts";
import type { Terms } from "../src/pilot/types.ts";

const now = Date.parse("2026-10-15T12:00:00Z");
const fields = {
  duration: "30",
  relationship: "employee",
  roleLabel: "Rådgiver",
  scope: "*",
  subject: "did:plc:person",
  visibility: "private",
} as const;
const context = { organisationDid: "did:plc:organisation", roles: [] };

void test("simplified form creates stable Unicode role codes without merging distinct roles", async () => {
  const first = await proposalTerms(fields, context, now);
  const second = await proposalTerms(
    { ...fields, roleLabel: "  RÅDGIVER  " },
    context,
    now
  );
  const different = await proposalTerms(
    { ...fields, roleLabel: "Radgiver" },
    context,
    now
  );
  assert.equal(first.roleId, second.roleId);
  assert.notEqual(first.roleId, different.roleId);
  assert.match(first.roleId, /^[a-z][a-z0-9.-]{1,79}$/u);
  assert.equal(first.roleLabel, "Rådgiver");
  assert.equal(first.visibility, "private");
  assert.equal(Date.parse(first.expiresAt) - now, 30 * 86_400_000);
});
void test("existing role codes are reused only for an unambiguous matching label", async () => {
  const roles = [{ roleId: "org.adviser", roleLabel: "Rådgiver" }];
  const known = await proposalTerms(fields, { ...context, roles }, now);
  assert.equal(known.roleId, "org.adviser");
  const ambiguous = await proposalTerms(
    fields,
    {
      ...context,
      roles: [...roles, { roleId: "org.another", roleLabel: "rådgiver" }],
    },
    now
  );
  assert.notEqual(ambiguous.roleId, "org.adviser");
});
void test("editing preserves the person, scope, visibility and expiry unless explicitly changed", async () => {
  const previous: Terms = {
    ...(await proposalTerms(fields, context, now)),
    roleId: "org.adviser",
    scope: "unit:one",
    validFrom: new Date(now - 2 * 86_400_000).toISOString(),
  };
  const updated = await proposalTerms(
    {
      ...fields,
      duration: "keep",
      scope: previous.scope,
      subject: "wrong-person",
    },
    { ...context, previous },
    now
  );
  assert.equal(updated.subject, previous.subject);
  assert.equal(updated.roleId, previous.roleId);
  assert.equal(updated.expiresAt, previous.expiresAt);
  assert.equal(updated.scope, previous.scope);
  assert.equal(updated.visibility, "private");
  assert.equal(Date.parse(updated.validFrom), now);
  const changed = await proposalTerms(
    { ...fields, duration: "7", roleLabel: "Trener", visibility: "public" },
    { ...context, previous },
    now
  );
  assert.notEqual(changed.roleId, previous.roleId);
  assert.equal(Date.parse(changed.expiresAt), now + 7 * 86_400_000);
  assert.equal(changed.visibility, "public");
});
void test("a future start is preserved and invalid duration choices fail before submission", async () => {
  const previous = {
    ...(await proposalTerms(fields, context, now)),
    validFrom: new Date(now + 10 * 86_400_000).toISOString(),
  };
  const updated = await proposalTerms(
    { ...fields, duration: "keep" },
    { ...context, previous },
    now
  );
  assert.equal(updated.validFrom, previous.validFrom);
  await assert.rejects(
    proposalTerms({ ...fields, duration: "7" }, { ...context, previous }, now),
    /after the start date/u
  );
  await assert.rejects(
    proposalTerms({ ...fields, duration: "keep" }, context, now),
    /how long/u
  );
  await assert.rejects(
    proposalTerms({ ...fields, roleLabel: " " }, context, now),
    /role/u
  );
});
