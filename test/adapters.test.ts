import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoAdapter } from "../src/adapters/demo-nif.ts";
import { createAtprotoPublisher } from "../src/publish/atproto.ts";

test("malformed demo facts or corrupt persisted facts are refused, not treated as an empty roster", () => {
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
    ])
      assert.throws(() => adapter.enrol("did:plc:test", facts));
    assert.deepEqual(adapter.roster(), {});
    writeFileSync(file, "{corrupt");
    assert.throws(() => adapter.roster());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("malformed publisher sessions fail before an authenticated write", async () => {
  for (const response of [
    { did: "did:plc:issuer" },
    { accessJwt: "test-token" },
  ]) {
    let calls = 0;
    const publisher = createAtprotoPublisher({
      service: "http://127.0.0.1:2583",
      identifier: "fixture.test",
      password: "fixture-only",
      fetchImpl: async () => {
        calls++;
        return Response.json(response);
      },
    });
    await assert.rejects(
      () =>
        publisher.remove(
          "at://did:plc:issuer/no.demokratiloftet.attestation/key",
        ),
      /PDS response missing/,
    );
    assert.equal(calls, 1);
  }
});
