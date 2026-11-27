import assert from "node:assert/strict";
import { test } from "node:test";

import { readConfig } from "../src/config.ts";

void test("local defaults listen only on loopback and cannot claim a public origin", () => {
  assert.equal(readConfig({}).host, "127.0.0.1");
  assert.throws(
    () => readConfig({ ISSUER_ORIGIN: "https://issuer.example" }),
    /loopback/u,
  );
});

void test("an empty token cannot authorize requests with no credentials", () => {
  assert.throws(
    () =>
      readConfig({
        ISSUER_CLIENTS_JSON: JSON.stringify([
          { id: "test", scopes: ["admin"], token: "" },
        ]),
      }),
    /nonempty token/u,
  );
});
