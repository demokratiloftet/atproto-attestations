import { AtpAgent } from "@atproto/api";
import type { AtpSessionData } from "@atproto/api";
import { IdResolver } from "@atproto/identity";
import { BlockMap, verifyRecords } from "@atproto/repo";
import type { AuthStore } from "@loftet/auth";
import { restrictedFetch } from "@loftet/auth";

import { refuse } from "./domain.ts";
import type { PilotConfig, Ref, Repository } from "./types.ts";
/** Fixed isolated PDS/PLC, enrolled DIDs only. Never follows caller-selected hosts. */
export class PilotRepository implements Repository {
  private readonly agents = new Map<string, AtpAgent>();
  private readonly resolver: IdResolver;
  private readonly allowed: Set<string>;
  constructor(
    private readonly config: PilotConfig,
    private readonly store: AuthStore,
  ) {
    this.resolver = new IdResolver({
      fetch: restrictedFetch({ [new URL(config.plc).origin]: config.plc }),
      plcUrl: config.plc,
      timeout: 5000,
    });
    this.allowed = new Set([
      ...config.people.map((p) => p.did),
      ...config.organisations.map((o) => o.did),
    ]);
  }
  private newAgent() {
    return new AtpAgent({
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        if (
          ![new URL(this.config.pds).origin, this.config.pdsCanonical].includes(
            url.origin,
          )
        ) {
          throw new Error("Unexpected PDS destination");
        }
        const target = new URL(url.pathname + url.search, this.config.pds);
        const request = new Request(input, init);
        return fetch(new Request(target, request), {
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
      },
      persistSession: async (event, session) => {
        if (session) {
          this.store.set("pilot-pds", session.did, session);
        }
        if (event === "expired" && session) {
          this.store.del("pilot-pds", session.did);
        }
      },
      service: this.config.pds,
    });
  }
  async login(identifier: string, password: string) {
    const enrolled = [
      ...this.config.people.map((p) => ({ did: p.did, handle: p.handle })),
      ...this.config.organisations.map((o) => ({
        did: o.did,
        handle: o.issuerHandle,
      })),
    ];
    const person = enrolled.find((p) => p.handle === identifier);
    if (!person) {
      refuse("Invalid demo account or password.", 401);
    }
    const agent = this.newAgent();
    try {
      await agent.login({ identifier, password });
    } catch {
      refuse("Invalid demo account or password.", 401);
    }
    if (agent.session?.did !== person.did) {
      refuse("The account identity does not match.", 403);
    }
    this.agents.set(person.did, agent);
    return { did: person.did, handle: person.handle };
  }
  async agent(did: string) {
    if (!this.allowed.has(did)) {
      throw new Error("Unenrolled DID");
    }
    let agent = this.agents.get(did);
    if (!agent) {
      const session = this.store.get<AtpSessionData>("pilot-pds", did);
      if (!session) {
        refuse("Sign in again to complete publication.", 409);
      }
      agent = this.newAgent();
      await agent.resumeSession(session);
      this.agents.set(did, agent);
    }
    return agent;
  }
  async put(
    did: string,
    collection: string,
    rkey: string,
    record: Record<string, unknown>,
  ) {
    const agent = await this.agent(did);
    // rkey is persisted before this call. Unknown outcomes reconcile at this key.
    const { data } = await agent.com.atproto.repo.putRecord({
      collection,
      record,
      repo: did,
      rkey,
      validate: false,
    });
    return { cid: data.cid, uri: data.uri };
  }
  async read(ref: Ref) {
    const match =
      /^at:\/\/(did:plc:[a-z2-7]+)\/([a-zA-Z0-9.]+)\/([a-zA-Z0-9-]+)$/u.exec(
        ref.uri,
      );
    if (!match || !this.allowed.has(match[1])) {
      throw new Error("Untrusted repository");
    }
    const [, did, collection, rkey] = match;
    const agent = new AtpAgent({
      fetch: async (input, init) =>
        fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        }),
      service: this.config.pds,
    });
    const current = await agent.com.atproto.repo.getRecord({
      collection,
      repo: did,
      rkey,
    });
    if (current.data.cid !== ref.cid) {
      throw new Error("Record changed or removed");
    }
    const { signingKey } = await this.resolver.did.resolveAtprotoData(
      did,
      true,
    );
    const proof = await agent.com.atproto.sync.getRecord({
      collection,
      did,
      rkey,
    });
    const records = await verifyRecords(proof.data, did, signingKey);
    const record = records.find(
      (r) => r.collection === collection && r.rkey === rkey,
    )?.record;
    if (!record) {
      throw new Error("Missing record inclusion proof");
    }
    const cid = await new BlockMap().add(record);
    if (cid.toString() !== ref.cid) {
      throw new Error("Proof does not match the accepted CID");
    }
    return record as Record<string, unknown>;
  }
  async remove(did: string, collection: string, rkey: string) {
    await (
      await this.agent(did)
    ).com.atproto.repo.deleteRecord({ collection, repo: did, rkey });
  }
}
