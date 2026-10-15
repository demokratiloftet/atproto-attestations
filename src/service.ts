// Wires configuration into a running issuer. Kept separate from the HTTP layer
// so tests, the CLI and the server all build the same object.
import { join } from "node:path";

import { createDemoAdapter } from "./adapters/demo-nif.ts";
import type { readConfig } from "./config.ts";
import { createIssuer } from "./core/issuer.ts";
import { loadSigner } from "./core/keys.ts";
import { loadClaimTypes } from "./core/registry.ts";
import { IssuerStore } from "./core/store.ts";
import { createAtprotoPublisher } from "./publish/atproto.ts";
import { createNullPublisher } from "./publish/none.ts";

export async function createService(config: ReturnType<typeof readConfig>) {
  const claimTypes = loadClaimTypes(config.claimTypesDir);
  const signer = await loadSigner({
    directory: config.dataDir,
    kid: config.keyId,
    privateJwk: config.privateJwk,
  });
  const store = new IssuerStore(config.dataDir);
  const adapter = createDemoAdapter({
    file: join(config.dataDir, "demo-roster.json"),
  });
  const publisher =
    config.publisher === "atproto"
      ? createAtprotoPublisher(config.atproto)
      : createNullPublisher();
  const description = await publisher
    .describe()
    .catch(() => ({ repo: undefined }));
  const { repo } = description;
  const issuer = createIssuer({
    adapter,
    claimTypes,
    contact: config.contact,
    demo: config.demo,
    issuer: config.issuer,
    name: config.name,
    publisher,
    repo,
    signer,
    store,
  });
  return {
    adapter,
    claimTypes,
    config,
    issuer,
    publisher,
    repo,
    signer,
    store,
  };
}
