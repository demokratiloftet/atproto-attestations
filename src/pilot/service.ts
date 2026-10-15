import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";

import { validateClaim } from "../../verify/claim-type.ts";
import {
  verifyAttestation,
  verifyPublicAffiliation,
} from "../../verify/index.ts";
import { decodeCompact } from "../../verify/jws.ts";
import type {
  AttestationRecord,
  Claim,
  TrustPolicy,
} from "../../verify/types.ts";
import { createAttestation, createStatus } from "../core/attestation.ts";
import { loadSigner } from "../core/keys.ts";
import { evaluateRequester } from "../core/policy.ts";
import { IssuerStore } from "../core/store.ts";
import type { Signer } from "../types.ts";
import { descriptors, reviewRules, publishRules } from "./descriptors.ts";
import {
  refuse,
  parseTerms,
  newProposal,
  currentRevision,
  live,
  text,
} from "./domain.ts";
import { PilotStore } from "./store.ts";
import {
  AFFILIATION,
  ACCEPTANCE,
  APPROVER,
  PERMISSION,
  EVENT,
  ACTION,
} from "./types.ts";
import type {
  PilotConfig,
  Proposal,
  Repository,
  Grant,
  PublishedEvent,
} from "./types.ts";

export class PilotService {
  readonly store: PilotStore;
  readonly issued: IssuerStore;
  readonly signers = new Map<string, { signer: Signer; issuer: string }>();
  readonly authorities = new Map<string, AttestationRecord>();
  readonly trust: TrustPolicy = {
    maxClockSkewSeconds: 0,
    maxStatusAgeSeconds: 30,
    requireStatusCheck: true,
    trust: [],
    version: 1,
  };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly config: PilotConfig,
    readonly repo: Repository
  ) {
    this.store = new PilotStore(config.dataDir);
    this.issued = new IssuerStore(config.dataDir);
  }
  /** Single-process serialisation includes external writes: revoke cannot race publish. */
  exclusive<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => null);
    return next;
  }
  async init() {
    for (const org of this.config.organisations) {
      const key = createHash("sha256")
        .update(org.did)
        .digest("hex")
        .slice(0, 24);
      const signer = await loadSigner({
        directory: join(this.config.dataDir, "issuers", key),
      });
      const issuer = `${this.config.origin}/issuers/${key}`;
      this.signers.set(org.did, { issuer, signer });
      this.trust.trust.push({
        claimTypes: Object.keys(descriptors),
        issuer,
        keys: [signer.publicJwk],
        where: { organisationDid: org.did },
      });
      const logged = await this.repo.login(
        org.issuerHandle,
        org.issuerPassword
      );
      if (logged.did !== org.did) {
        throw new Error("Configured organisation account mismatch");
      }
      for (const did of org.approvers) {
        if (!this.config.people.some((p) => p.did === did)) {
          throw new Error("Unknown configured approver");
        }
        const record = await this.mint(
          APPROVER,
          did,
          { action: "affiliations.review", organisationDid: org.did },
          365
        );
        this.authorities.set(`${org.did}:${did}`, record);
      }
    }
  }
  async mint(
    claimType: string,
    subject: string,
    claim: Claim,
    days: number,
    id: string = randomUUID()
  ) {
    const descriptor = descriptors[claimType];
    if (!descriptor || validateClaim(claim, descriptor).length) {
      throw new Error("Invalid pilot claim");
    }
    const approval = await evaluateRequester(descriptor.issuance.requesters, {
      claimTypes: descriptors,
      request: claim,
      requester: { client: "approved-workflow" },
      subject,
      trustPolicy: this.trust,
    });
    if (!approval.allowed) {
      refuse(approval.reason, 403);
    }
    const signing = this.signers.get(String(claim.organisationDid));
    if (!signing) {
      throw new Error("Unknown issuer");
    }
    const { record, payload, jws } = await createAttestation({
      ...signing,
      claim,
      claimType,
      demo: true,
      id,
      lifetimeDays: Math.min(days, descriptor.maxLifetimeDays),
      subject,
    });
    this.issued.put({
      claim,
      claimType,
      expiresAt: payload.exp,
      id: payload.id,
      issuedAt: payload.iat,
      jws,
      subject,
      visibility: "public",
    });
    return record;
  }
  async status(id: string) {
    const row = this.issued.get(id);
    if (!row) {
      refuse("Unknown attestation.", 404);
    }
    const signing = this.signers.get(String(row.claim.organisationDid));
    if (!signing) {
      refuse("Unknown issuer.", 404);
    }
    let state = row.revokedAt
      ? "revoked"
      : Date.parse(row.expiresAt) <= Date.now()
        ? "expired"
        : "active";
    if (row.claimType === AFFILIATION) {
      const p = this.store.proposal(String(row.claim.proposalId));
      if (
        !p ||
        p.revision !== row.claim.revision ||
        p.state === "revoked" ||
        p.state === "declined"
      ) {
        state = "revoked";
      } else if (
        p.state !== "active" ||
        !p.subjectApproved ||
        !p.organisationApprovedBy
      ) {
        state = "unknown";
      } else if (Date.parse(p.terms.expiresAt) <= Date.now()) {
        state = "expired";
      }
    }
    if (row.claimType === PERMISSION) {
      const p = this.store.proposal(String(row.claim.proposalId));
      if (!p || p.revision !== row.claim.proposalRevision || !live(p)) {
        state = "revoked";
      }
    }
    return createStatus({ ...signing, id, state });
  }
  verificationOptions() {
    return {
      claimTypes: descriptors,
      fetchStatus: async (url: string) => {
        const u = new URL(url);
        if (
          u.origin !== this.config.origin ||
          !/^\/status\/[a-zA-Z0-9-]+$/u.test(u.pathname)
        ) {
          throw new Error("Unknown status origin");
        }
        return this.status(u.pathname.slice("/status/".length));
      },
      trustPolicy: this.trust,
    };
  }
  async canReview(actor: string, organisationDid: string) {
    // Current operator appointment is mandatory even if an old signed authority exists.
    if (
      !this.config.organisations.some(
        (o) => o.did === organisationDid && o.approvers.includes(actor)
      )
    ) {
      return false;
    }
    const evidence = this.authorities.get(`${organisationDid}:${actor}`);
    if (!evidence) {
      return false;
    }
    const decision = await evaluateRequester(reviewRules, {
      ...this.verificationOptions(),
      request: { organisationDid },
      requester: { attestations: [evidence], did: actor },
      subject: actor,
    });
    return decision.allowed;
  }
  async participant(actor: string, p: Proposal) {
    if (
      actor !== p.terms.subject &&
      !(await this.canReview(actor, p.terms.organisationDid))
    ) {
      refuse("You do not have access to this proposal.", 403);
    }
  }
  getProposal(id: string) {
    const p = this.store.proposal(id);
    if (!p) {
      refuse("Proposal not found.", 404);
    }
    return p;
  }
  async propose(actor: string, input: Record<string, unknown>) {
    const terms = parseTerms(
      input,
      this.config.people,
      this.config.organisations
    );
    const p = newProposal(
      terms,
      actor,
      await this.canReview(actor, terms.organisationDid)
    );
    this.store.transaction(() => {
      this.store.put("proposal", p);
      this.store.audit(actor, "proposed", p.id, terms.organisationDid);
    });
    return p;
  }
  async change(
    actor: string,
    id: string,
    revision: unknown,
    input: Record<string, unknown>
  ) {
    const p = this.getProposal(id);
    await this.participant(actor, p);
    currentRevision(p, revision);
    if (!["pending", "active", "publishing"].includes(p.state)) {
      refuse("Create a new proposal.", 409);
    }
    const terms = parseTerms(
      input,
      this.config.people,
      this.config.organisations
    );
    if (
      terms.subject !== p.terms.subject ||
      terms.organisationDid !== p.terms.organisationDid
    ) {
      refuse("The person and organisation cannot be changed.");
    }
    await this.retire(p, actor, "superseded");
    const updated: Proposal = {
      createdAt: new Date().toISOString(),
      createdBy: actor,
      id: p.id,
      revision: p.revision + 1,
      subjectApproved: actor === terms.subject,
      terms,
      ...(actor !== terms.subject &&
      (await this.canReview(actor, terms.organisationDid))
        ? { organisationApprovedBy: actor }
        : {}),
      state: "pending",
    };
    this.store.transaction(() => {
      this.store.put("proposal", updated);
      this.store.audit(
        actor,
        "changed",
        p.id,
        terms.organisationDid,
        `revision ${updated.revision}`
      );
    });
    return updated;
  }
  async approve(actor: string, id: string, revision: unknown) {
    const p = this.getProposal(id);
    await this.participant(actor, p);
    currentRevision(p, revision);
    if (!["pending", "publishing"].includes(p.state)) {
      refuse("The proposal cannot be approved right now.", 409);
    }
    if (Date.parse(p.terms.expiresAt) <= Date.now()) {
      refuse("The proposal has expired.", 409);
    }
    if (actor === p.terms.subject) {
      p.subjectApproved = true;
    } else {
      if (!(await this.canReview(actor, p.terms.organisationDid))) {
        refuse(
          "You do not have permission to approve for this organisation.",
          403
        );
      }
      p.organisationApprovedBy = actor;
    }
    this.store.put("proposal", p);
    this.store.audit(
      actor,
      "approved",
      p.id,
      p.terms.organisationDid,
      `revision ${p.revision}`
    );
    if (p.subjectApproved && p.organisationApprovedBy) {
      await this.publish(p);
    }
    return this.getProposal(id);
  }
  private async publish(p: Proposal) {
    if (
      !p.subjectApproved ||
      !p.organisationApprovedBy ||
      p.organisationApprovedBy === p.terms.subject ||
      !(await this.canReview(p.organisationApprovedBy, p.terms.organisationDid))
    ) {
      refuse("Both parties must approve the same version.", 403);
    }
    if (Date.parse(p.terms.expiresAt) <= Date.now()) {
      refuse("The proposal has expired.", 409);
    }
    if (!p.record) {
      const { subject, ...claim } = p.terms;
      // Deterministic attestation identity survives a crash after signing/store.put.
      const id = `${p.id}-${p.revision}`;
      const old = this.issued.get(id);
      p.record = old
        ? {
            $type: "no.demokratiloftet.attestation",
            jws: old.jws,
            version: 1,
            view: {
              claimType: AFFILIATION,
              demo: true,
              expiresAt: old.expiresAt,
              issuedAt: old.issuedAt,
              issuer: String(decodeCompact(old.jws).payload.iss),
              subject,
            },
          }
        : await this.mint(
            AFFILIATION,
            subject,
            { ...claim, proposalId: p.id, revision: p.revision },
            (Date.parse(p.terms.expiresAt) - Date.now()) / 86_400_000,
            id
          );
    }
    p.state = "publishing";
    delete p.error;
    this.store.put("proposal", p);
    const key = `${p.id}-${p.revision}`;
    try {
      if (p.terms.visibility === "public") {
        p.ref = await this.repo.put(
          p.terms.organisationDid,
          "no.demokratiloftet.attestation",
          key,
          { ...p.record }
        );
        this.store.put("proposal", p);
        p.acceptance ??= {
          $type: ACCEPTANCE,
          affiliation: p.ref,
          createdAt: new Date().toISOString(),
          revision: p.revision,
          subject: p.terms.subject,
        };
        this.store.put("proposal", p);
        p.acceptanceRef = await this.repo.put(
          p.terms.subject,
          ACCEPTANCE,
          key,
          p.acceptance
        );
        // Do not activate merely because a publisher returned a URI.
        await this.repo.read(p.ref);
        await this.repo.read(p.acceptanceRef);
      }
      p.state = "active";
      this.store.put("proposal", p);
      this.store.audit("workflow", "activated", p.id, p.terms.organisationDid);
    } catch {
      p.error = "Publication is pending. Sign in again if needed, then retry.";
      this.store.put("proposal", p);
    }
  }
  async retry(actor: string, id: string) {
    const p = this.getProposal(id);
    await this.participant(actor, p);
    if (p.state !== "publishing") {
      refuse("No publication is pending.", 409);
    }
    await this.publish(p);
    return this.getProposal(id);
  }
  async retire(p: Proposal, actor: string, action: string) {
    // Persist revocation before remote deletes. A retained public copy is never active.
    this.store.transaction(() => {
      this.store.put("revision", { ...p, id: `${p.id}-${p.revision}` });
      p.state = action === "declined" ? "declined" : "revoked";
      this.store.put("proposal", p);
      if (p.record) {
        this.issued.revoke(String(decodeCompact(p.record.jws).payload.id));
      }
      for (const g of this.store
        .grants()
        .filter((row) => row.proposalId === p.id && !row.revoked)) {
        g.revoked = true;
        this.store.put("grant", g);
        this.issued.revoke(g.id);
      }
      this.store.audit(actor, action, p.id, p.terms.organisationDid);
    });
    // Removal is a durable outbox task; permission denial does not wait for it.
    for (const ref of [p.ref, p.acceptanceRef]) {
      if (ref) {
        this.store.put("cleanup", { id: ref.uri });
      }
    }
    await this.cleanup();
  }
  async end(
    actor: string,
    id: string,
    revision: unknown,
    action: "declined" | "revoked"
  ) {
    const p = this.getProposal(id);
    await this.participant(actor, p);
    currentRevision(p, revision);
    if (action === "declined" && p.state !== "pending") {
      refuse("An active affiliation must be withdrawn.", 409);
    }
    await this.retire(p, actor, action);
    return p;
  }
  async cleanup() {
    for (const task of this.store.list("cleanup")) {
      const [, did, collection, key] =
        /^at:\/\/([^/]+)\/([^/]+)\/(.+)$/u.exec(task.id) ?? [];
      if (!did) {
        continue;
      }
      try {
        await this.repo.remove(did, collection, key);
        this.store.db
          .prepare("DELETE FROM documents WHERE kind=? AND id=?")
          .run("cleanup", task.id);
      } catch {
        /* retry on next worker tick */
      }
    }
  }
  async verify(p: Proposal) {
    if (!live(p) || !p.record) {
      return {
        checks: [],
        reason:
          Date.parse(p.terms.expiresAt) <= Date.now() ? "expired" : p.state,
        valid: false,
      };
    }
    const options = {
      ...this.verificationOptions(),
      expect: {
        claim: {
          organisationDid: p.terms.organisationDid,
          proposalId: p.id,
          revision: p.revision,
        },
        subject: p.terms.subject,
      },
    };
    if (p.terms.visibility === "private") {
      return verifyAttestation(p.record, options);
    }
    if (!p.ref || !p.acceptanceRef) {
      return { checks: [], reason: "missing-publication", valid: false };
    }
    return verifyPublicAffiliation(p.record, p.ref, p.acceptanceRef, {
      ...options,
      organisationDid: p.terms.organisationDid,
      readRecord: (r) => this.repo.read(r),
    });
  }
  async grant(
    actor: string,
    id: string,
    revision: unknown,
    input: Record<string, unknown>
  ) {
    const p = this.getProposal(id);
    currentRevision(p, revision);
    if (!(await this.canReview(actor, p.terms.organisationDid))) {
      refuse(
        "Only the organisation’s approver can grant publishing access.",
        403
      );
    }
    if (!(await this.verify(p)).valid) {
      refuse("The affiliation cannot be verified.", 409);
    }
    if (input.action !== ACTION) {
      refuse("Unknown action.");
    }
    const scope = text(input, "scope");
    if (scope !== p.terms.scope) {
      refuse("Publishing access must match the affiliation’s scope.");
    }
    const expiry = Date.parse(text(input, "expiresAt"));
    if (
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.parse(p.terms.expiresAt)
    ) {
      refuse("Publishing access must expire no later than the affiliation.");
    }
    const existing = this.store
      .grants()
      .find(
        (g) =>
          !g.revoked &&
          g.proposalId === id &&
          g.proposalRevision === p.revision &&
          g.scope === scope &&
          Date.parse(g.expiresAt) > Date.now()
      );
    if (existing) {
      return existing;
    }
    const grantId = randomUUID();
    const claim = {
      action: ACTION,
      organisationDid: p.terms.organisationDid,
      proposalId: p.id,
      proposalRevision: p.revision,
      scope,
    };
    const record = await this.mint(
      PERMISSION,
      p.terms.subject,
      claim,
      (expiry - Date.now()) / 86_400_000,
      grantId
    );
    const g: Grant = {
      id: grantId,
      ...claim,
      expiresAt: new Date(expiry).toISOString(),
      record,
      revoked: false,
      subject: p.terms.subject,
    };
    this.store.put("grant", g);
    this.store.audit(
      actor,
      "grant-created",
      p.id,
      p.terms.organisationDid,
      ACTION
    );
    return g;
  }
  async revokeGrant(actor: string, id: string) {
    const g = this.store.get("grant", id);
    if (!g) {
      refuse("Publishing access grant not found.", 404);
    }
    if (!(await this.canReview(actor, g.organisationDid))) {
      refuse(
        "You do not have permission to approve for this organisation.",
        403
      );
    }
    g.revoked = true;
    this.store.put("grant", g);
    this.issued.revoke(g.id);
    this.store.audit(actor, "grant-revoked", g.proposalId, g.organisationDid);
    return g;
  }
  async permission(actor: string, org: string, scope: string) {
    for (const g of this.store
      .grants()
      .filter(
        (row) =>
          row.subject === actor &&
          row.organisationDid === org &&
          row.scope === scope &&
          !row.revoked &&
          Date.parse(row.expiresAt) > Date.now()
      )) {
      const p = this.store.proposal(g.proposalId);
      if (
        !p ||
        p.revision !== g.proposalRevision ||
        !(await this.verify(p)).valid
      ) {
        continue;
      }
      const decision = await evaluateRequester(publishRules, {
        ...this.verificationOptions(),
        request: { organisationDid: org, scope },
        requester: { attestations: [g.record], did: actor },
        subject: actor,
      });
      if (decision.allowed) {
        return g;
      }
    }
  }
  async publishEvent(actor: string, input: Record<string, unknown>) {
    const org = text(input, "organisationDid", 200);
    const scope = text(input, "scope");
    const title = text(input, "title", 180);
    const startsAt = text(input, "startsAt");
    const date = Date.parse(startsAt);
    if (!Number.isFinite(date) || date <= Date.now()) {
      refuse("Choose a future date and time.");
    }
    const grant = await this.permission(actor, org, scope);
    if (!grant) {
      this.store.audit(actor, "publish-denied", undefined, org);
      refuse("You do not have valid permission to publish in this scope.", 403);
    }
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const event: PublishedEvent = {
      actor,
      createdAt,
      grantId: grant.id,
      id,
      organisationDid: org,
      // Private employment/grants are not exposed through a public event.
      record: {
        $type: EVENT,
        createdAt,
        demo: true,
        organisationDid: org,
        scope,
        startsAt: new Date(date).toISOString(),
        title,
      },
      scope,
      startsAt: new Date(date).toISOString(),
      state: "publishing",
      title,
    };
    this.store.put("event", event);
    await this.deliverEvent(event);
    this.store.audit(actor, "event-published", grant.proposalId, org);
    return event;
  }
  private async deliverEvent(event: PublishedEvent) {
    const grant = await this.permission(
      event.actor,
      event.organisationDid,
      event.scope
    );
    if (!grant || grant.id !== event.grantId) {
      event.state = "cancelled";
      this.store.put("event", event);
      return;
    }
    event.ref = await this.repo.put(
      event.organisationDid,
      EVENT,
      event.id,
      event.record
    );
    await this.repo.read(event.ref);
    event.state = "published";
    this.store.put("event", event);
  }
  async tick() {
    await this.cleanup();
    for (const p of this.store
      .proposals()
      .filter((row) => row.state === "publishing")) {
      try {
        await this.publish(p);
      } catch {
        /* remains pending */
      }
    }
    for (const e of this.store
      .events()
      .filter((row) => row.state === "publishing")) {
      try {
        await this.deliverEvent(e);
      } catch {
        /* fixed-key retry */
      }
    }
  }
  async view(actor?: string) {
    const orgs = this.config.organisations.map((org) => ({
      canReview: !!actor && org.approvers.includes(actor),
      description: org.description,
      did: org.did,
      domain: org.domain,
      name: org.name,
      scopes: org.scopes,
    }));
    const accessible = this.store
      .proposals()
      .filter(
        (p) =>
          actor &&
          (p.terms.subject === actor ||
            orgs.some((o) => o.did === p.terms.organisationDid && o.canReview))
      );
    const publicRows = this.store
      .proposals()
      .filter((p) => p.terms.visibility === "public" && p.state === "active");
    const publicCredentials = await Promise.all(
      publicRows.map(async (p) => ({
        acceptanceRef: p.acceptanceRef,
        id: p.id,
        ref: p.ref,
        revision: p.revision,
        terms: p.terms,
        verification: await this.verify(p),
      }))
    );
    return {
      demo: true,
      events: this.store
        .events()
        .filter((e) => e.state === "published")
        .map((e) => ({
          id: e.id,
          organisationDid: e.organisationDid,
          ref: e.ref,
          scope: e.scope,
          startsAt: e.startsAt,
          title: e.title,
        })),
      grants: actor
        ? this.store
            .grants()
            .filter(
              (g) =>
                g.subject === actor ||
                orgs.some((o) => o.did === g.organisationDid && o.canReview)
            )
            .map((grant) => ({
              action: grant.action,
              expiresAt: grant.expiresAt,
              id: grant.id,
              organisationDid: grant.organisationDid,
              proposalId: grant.proposalId,
              proposalRevision: grant.proposalRevision,
              revoked: grant.revoked,
              scope: grant.scope,
              subject: grant.subject,
            }))
        : [],
      history: actor
        ? this.store.history(
            orgs.filter((o) => o.canReview).map((o) => o.did),
            actor
          )
        : [],
      organisations: orgs,
      people: actor ? this.config.people : [],
      person: this.config.people.find((p) => p.did === actor) ?? null,
      proposals: await Promise.all(
        accessible.map(async (p) => ({
          ...p,
          acceptance: undefined,
          record: undefined,
          verification: await this.verify(p),
        }))
      ),
      publicCredentials,
    };
  }
  close() {
    this.store.close();
    this.issued.close();
  }
}
