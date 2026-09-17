// Wires configuration into a running issuer. Kept separate from the HTTP layer
// so tests, the CLI and the server all build the same object.
import { join } from 'node:path';
import { loadSigner } from './core/keys.mjs';
import { loadClaimTypes } from './core/registry.mjs';
import { IssuerStore } from './core/store.mjs';
import { createIssuer } from './core/issuer.mjs';
import { createDemoAdapter } from './adapters/demo-nif.mjs';
import { createNullPublisher } from './publish/none.mjs';
import { createAtprotoPublisher } from './publish/atproto.mjs';

export async function createService(config) {
  const claimTypes = loadClaimTypes(config.claimTypesDir);
  const signer = await loadSigner({ directory: config.dataDir, kid: config.keyId, privateJwk: config.privateJwk });
  const store = new IssuerStore(config.dataDir);
  const adapter = createDemoAdapter({ file: join(config.dataDir, 'demo-roster.json') });
  const publisher = config.publisher === 'atproto' ? createAtprotoPublisher(config.atproto) : createNullPublisher();
  const repo = config.publisher === 'atproto' ? (await publisher.describe().catch(() => ({}))).repo : undefined;

  const issuer = createIssuer({
    issuer: config.issuer, name: config.name, contact: config.contact, demo: config.demo,
    signer, store, claimTypes, adapter, publisher, repo,
  });
  return { issuer, adapter, store, signer, claimTypes, publisher, repo, config };
}
