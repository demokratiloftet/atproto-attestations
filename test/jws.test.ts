import assert from "node:assert/strict";
import { test } from "node:test";

import { generateKeyPair, signCompact } from "../src/core/sign.ts";
import { decodeCompact, verifyCompact, thumbprint } from "../verify/jws.ts";

const payload = { claimType: "no.nif.clubRole", sub: "did:plc:subject", v: 1 };

void test("a signed attestation verifies with the matching public key only", async () => {
  const key = await generateKeyPair("key-1");
  const other = await generateKeyPair("key-1");
  const jws = await signCompact(key, payload);

  assert.deepEqual(await verifyCompact(jws, [key.publicJwk]), payload);
  await assert.rejects(
    () => verifyCompact(jws, [other.publicJwk]),
    /signature/u
  );
  await assert.rejects(() => verifyCompact(jws, []), /no usable key/iu);
});

void test("decoding never trusts the token: header and payload are readable before verification", async () => {
  const key = await generateKeyPair("key-7");
  const decoded = decodeCompact(await signCompact(key, payload));
  assert.equal(decoded.header.alg, "ES256");
  assert.equal(decoded.header.kid, "key-7");
  assert.equal(decoded.header.typ, "attest+jws");
  assert.equal(decoded.payload.claimType, "no.nif.clubRole");
});

void test("tampering with the payload, header or signature fails", async () => {
  const key = await generateKeyPair("key-1");
  const jws = await signCompact(key, payload);
  const [header, body, signature] = jws.split(".");
  const swap = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const forged = swap({ ...payload, sub: "did:plc:attacker" });
  await assert.rejects(
    () => verifyCompact(`${header}.${forged}.${signature}`, [key.publicJwk]),
    /signature/u
  );
  await assert.rejects(
    () =>
      verifyCompact(`${header}.${body}.${signature.slice(0, -2)}AA`, [
        key.publicJwk,
      ]),
    /signature/u
  );
  // An unsigned "alg: none" token must never be accepted, however well-formed.
  const none = swap({ alg: "none", kid: "key-1", typ: "attest+jws" });
  await assert.rejects(
    () => verifyCompact(`${none}.${body}.`, [key.publicJwk]),
    /algorithm/u
  );
});

void test("a key is selected by kid, and an unknown kid is not silently ignored", async () => {
  const key = await generateKeyPair("key-2");
  const stale = await generateKeyPair("key-1");
  const jws = await signCompact(key, payload);
  assert.deepEqual(
    await verifyCompact(jws, [stale.publicJwk, key.publicJwk]),
    payload
  );
  await assert.rejects(
    () => verifyCompact(jws, [stale.publicJwk]),
    /no usable key/iu
  );
});

void test("malformed tokens are rejected before any cryptography", () => {
  for (const bad of ["", "a.b", "a.b.c.d", "not-base64!.x.y", ".."]) {
    assert.throws(
      () => decodeCompact(bad),
      /token/iu,
      `accepted ${JSON.stringify(bad)}`
    );
  }
});

void test("thumbprints identify a key independently of its id", async () => {
  const key = await generateKeyPair("key-1");
  const renamed = { ...key.publicJwk, kid: "renamed" };
  assert.equal(await thumbprint(key.publicJwk), await thumbprint(renamed));
  assert.notEqual(
    await thumbprint(key.publicJwk),
    await thumbprint((await generateKeyPair("key-1")).publicJwk)
  );
});
