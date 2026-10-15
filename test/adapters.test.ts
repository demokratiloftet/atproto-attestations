import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDemoAdapter } from "../src/adapters/demo-nif.ts";
import { createAtprotoPublisher } from "../src/publish/atproto.ts";

void test("malformed demo facts or corrupt persisted facts are refused, not treated as an empty roster", () => {
  const directory = mkdtempSync(join(tmpdir(), "issuer-adapter-"));
  const file = join(directory, "people.json");
  const adapter = createDemoAdapter({ file });
  try {
    for (const facts of [
      { identity: "high" },
      { clubs: "fjord" },
      { clubs: [{ orgId: 42 }] },
      { licences: [{ discipline: "ski", level: 3 }] },
      { attests: [null] },
    ]) {
      assert.throws(() => adapter.enrol("did:plc:test", facts));
    }
    assert.deepEqual(adapter.roster(), {});
    writeFileSync(file, "{corrupt");
    assert.throws(() => adapter.roster());
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

void test("malformed publisher sessions fail before an authenticated write", async () => {
  for (const response of [
    { did: "did:plc:issuer" },
    { accessJwt: "test-token" },
  ]) {
    let calls = 0;
    const publisher = createAtprotoPublisher({
      fetchImpl: async () => {
        calls += 1;
        return Response.json(response);
      },
      identifier: "fixture.test",
      password: "fixture-only",
      service: "http://127.0.0.1:2583",
    });
    await assert.rejects(
      () =>
        publisher.remove(
          "at://did:plc:issuer/no.demokratiloftet.attestation/key"
        ),
      /PDS response missing/u
    );
    assert.equal(calls, 1);
  }
});
