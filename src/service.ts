import type { readConfig } from "./config.ts";
// Wires configuration into a running issuer. Kept separate from the HTTP layer
// so tests, the CLI and the server all build the same object.
import { join } from "node:path";
import { loadSigner } from "./core/keys.ts";
import { loadClaimTypes } from "./core/registry.ts";
import { IssuerStore } from "./core/store.ts";
import { createIssuer } from "./core/issuer.ts";
import { createDemoAdapter } from "./adapters/demo-nif.ts";
import { createNullPublisher } from "./publish/none.ts";
import { createAtprotoPublisher } from "./publish/atproto.ts";

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
  const repo = description.repo;

  const issuer = createIssuer({
    issuer: config.issuer,
    name: config.name,
    contact: config.contact,
    demo: config.demo,
    signer,
    store,
    claimTypes,
    adapter,
    publisher,
    repo,
  });
  return {
    issuer,
    adapter,
    store,
    signer,
    claimTypes,
    publisher,
    repo,
    config,
  };
}
