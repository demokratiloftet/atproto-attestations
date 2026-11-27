import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseDescriptor,
  matchWhere,
  resolveBinding,
} from "../verify/claim-type.ts";
import { validate, checkSchema } from "../verify/schema.ts";
import type { Schema } from "../verify/types.ts";

const licence: Schema = {
  additionalProperties: false,
  properties: {
    discipline: { enum: ["svomming", "ski"], type: "string" },
    issuedCount: { maximum: 10, minimum: 0, type: "integer" },
    level: { maxLength: 40, minLength: 1, type: "string" },
    orgId: { pattern: "^[a-z0-9-]{1,40}$", type: "string" },
    tags: { items: { type: "string" }, maxItems: 3, type: "array" },
    validFrom: { format: "datetime", type: "string" },
  },
  required: ["discipline", "level"],
  type: "object",
};

void test("a claim payload is accepted only when it matches the declared schema", () => {
  assert.deepEqual(
    validate({ discipline: "svomming", level: "instruktor-2" }, licence),
    [],
  );
  assert.deepEqual(
    validate(
      {
        discipline: "svomming",
        issuedCount: 3,
        level: "a",
        orgId: "fjord",
        tags: ["x"],
        validFrom: "2026-09-17T10:00:00Z",
      },
      licence,
    ),
    [],
  );
});

void test("every rejection names the field that failed", () => {
  const cases: [unknown, string][] = [
    [{ level: "a" }, "discipline"],
    [{ discipline: "svomming" }, "level"],
    [{ discipline: "padling", level: "a" }, "discipline"],
    [{ discipline: "svomming", level: "" }, "level"],
    [{ discipline: "svomming", level: "a", orgId: "FJORD" }, "orgId"],
    [{ discipline: "svomming", issuedCount: 11, level: "a" }, "issuedCount"],
    [{ discipline: "svomming", issuedCount: 1.5, level: "a" }, "issuedCount"],
    [
      { discipline: "svomming", level: "a", tags: ["a", "b", "c", "d"] },
      "tags",
    ],
    [{ discipline: "svomming", level: "a", validFrom: "someday" }, "validFrom"],
    [{ discipline: "svomming", level: "a", surprise: true }, "surprise"],
  ];
  for (const [value, field] of cases) {
    const errors = validate(value, licence);
    assert.equal(errors.length > 0, true, `accepted ${JSON.stringify(value)}`);
    assert.match(
      errors.join(" "),
      new RegExp(field, "u"),
      `wrong field for ${JSON.stringify(value)}`,
    );
  }
});

void test("__proto__ and prototype pollution attempts are not treated as valid claims", () => {
  const payload = JSON.parse(
    '{"discipline":"svomming","level":"a","__proto__":{"admin":true}}',
  );
  assert.match(
    validate(payload, licence).join(" "),
    /unexpected property "__proto__"/u,
  );
  assert.equal(Object.hasOwn({}, "admin"), false);
});

const descriptor = {
  claim: {
    additionalProperties: false,
    properties: {
      orgId: { type: "string" },
      role: { enum: ["leder", "trener", "medlem"], type: "string" },
    },
    required: ["orgId", "role"],
    type: "object",
  },
  description: "Rolle i et idrettslag.",
  disclosure: { mode: "public-record" },
  id: "no.nif.clubRole",
  issuance: {
    requesters: [
      { kind: "self" },
      {
        claimType: "no.nif.clubRole",
        kind: "attestation",
        where: { orgId: "$request.orgId", role: "leder" },
      },
    ],
  },
  label: { nb: "Klubbrolle" },
  maxLifetimeDays: 180,
  version: 1,
  visibility: "public",
};

void test("a descriptor is parsed, and a broken one is refused at load time", () => {
  assert.equal(parseDescriptor(descriptor).id, "no.nif.clubRole");
  const broken = [
    { ...descriptor, id: "Not An NSID" },
    { ...descriptor, visibility: "secret" },
    { ...descriptor, maxLifetimeDays: 0 },
    { ...descriptor, claim: { type: "string" } },
    { ...descriptor, issuance: { requesters: [] } },
    { ...descriptor, issuance: { requesters: [{ kind: "whoever" }] } },
    { ...descriptor, issuance: { requesters: [{ kind: "attestation" }] } },
    // A restricted claim must not be publishable as a public record.
    {
      ...descriptor,
      disclosure: { mode: "public-record" },
      visibility: "restricted",
    },
    // Query-only disclosure without a requester rule would answer anyone.
    {
      ...descriptor,
      disclosure: { mode: "query-only" },
      visibility: "restricted",
    },
  ];
  for (const value of broken) {
    assert.throws(
      () => parseDescriptor(value),
      Error,
      `accepted ${JSON.stringify(value).slice(0, 80)}`,
    );
  }
});

void test("bindings resolve from the request, and an unknown binding is an error, never undefined", () => {
  const context = { request: { orgId: "fjord" }, subject: "did:plc:subject" };
  assert.equal(resolveBinding("$request.orgId", context), "fjord");
  assert.equal(resolveBinding("$subject", context), "did:plc:subject");
  assert.equal(resolveBinding("leder", context), "leder");
  for (const bad of ["$request.missing", "$nonsense", "$request.__proto__"]) {
    assert.throws(() => resolveBinding(bad, context));
  }
});

void test("where-matching binds a delegate to the club named in the request", () => {
  const where = { orgId: "$request.orgId", role: "leder" };
  const context = { request: { orgId: "fjord" }, subject: "did:plc:coach" };
  assert.equal(
    matchWhere({ orgId: "fjord", role: "leder" }, where, context).ok,
    true,
  );
  assert.equal(
    matchWhere({ orgId: "marka", role: "leder" }, where, context).ok,
    false,
  );
  assert.equal(
    matchWhere({ orgId: "fjord", role: "trener" }, where, context).ok,
    false,
  );
  assert.equal(matchWhere({ orgId: "fjord" }, where, context).ok, false);
});

void test("schema metadata has the declared types; unsupported constraints cannot silently pass", () => {
  for (const invalid of [
    { minLength: "2", type: "string" },
    { maxLength: -1, type: "string" },
    { minimum: Infinity, type: "number" },
    { required: "role", type: "object" },
    { properties: [], type: "object" },
    { additionalProperties: "false", type: "object" },
    { enum: "valid", type: "string" },
    { format: "toString", type: "string" },
    { items: null, type: "array" },
  ]) {
    assert.throws(() => checkSchema(invalid));
  }
  assert.throws(() =>
    parseDescriptor({ ...descriptor, label: { en: 42, nb: "Rolle" } }),
  );
  assert.throws(() =>
    parseDescriptor({
      ...descriptor,
      disclosure: {
        mode: "query-only",
        purposes: [42],
        requesters: [{ kind: "self" }],
      },
      visibility: "restricted",
    }),
  );
});
