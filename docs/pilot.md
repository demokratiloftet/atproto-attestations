# Two-party affiliation pilot

The demo runs at **https://tilknytning.hackaton.demokratiloftet.no**. All persons, organisation accounts, affiliations and permissions are synthetic. The real AT records live on the existing isolated hackathon PDS, not the public Atmosphere. The website displays consented public credentials and events.

## Try the demo

The operator's private login sheet contains four separate accounts:

- Emil: person, with an accepted Devotta developer affiliation and publishing grant.
- Nina: appointed Devotta approver; can review, propose changes, invite people, grant event publishing, revoke a grant, or end an affiliation.
- Maja: person with a pending Devotta invitation and no publishing grant.
- Kari: approver for a separate synthetic sports club. She has no authority over Devotta.

Sign in as Maja and accept the invitation; Nina can then grant permission. Maja can publish an event under the exact organisation/scope. Withdraw the affiliation or revoke its grant and the next protected action is denied. Use separate browser profiles to demonstrate both parties. A person can also initiate a proposal. Changes reset the other party's approval and invalidate the previous version's grants. The public proof viewer explains signature, status and matching acceptance.

A private affiliation can grant permissions without publishing employment data. Public events contain the organisation and event details; actor and grant references stay in the private audit trail so private employment is not exposed through events.

## Ownership and reuse

- `src/pilot/` is application workflow, UI composition, storage and transport.
- `@loftet/auth` 0.3.0 is installed from the shared identity repository's unchanged archive. It supplies encrypted SQLite session/token storage and restricted PLC fetching. Login proves control of an enrolled sandbox PDS account.
- Existing issuer modules supply signing keys, the JWS envelope, signed revocation status, schema validation and descriptor-based requester policy.
- `verify/` remains independent of issuer code. Version 0.1.1 adds literal signed claim constraints to trust entries and `verifyPublicAffiliation`.
- Organisation identity evidence remains the responsibility of the existing `organisation-verifier`. Its live production issuer and records are unchanged. This pilot's synthetic organisation DIDs are explicitly enrolled by the operator; `.test` domains do not claim a Brreg match or real Devotta authority. Real onboarding must independently bind an organisation-verifier result to the organisation's DID and appoint authorised approvers before using real people.

The generic fields are subject DID, organisation DID, relationship, namespaced role ID/display label, scope, validity and visibility. Supported relationships include employee, contractor, member, volunteer and elected representative. Organisations, people, scopes and appointed approvers are configuration, not company-specific branches in policy. An institution can use different roles and scopes without changing the workflow. The second club demonstrates organisation isolation. There is no NIF, Idrettens ID, Stortinget, HR or identity-assurance integration.

## Enrol another organisation

The application does not contain a Devotta-specific policy. `examples/affiliation-demo.json` supplies the named demo accounts and seed scenarios; `provision.py` accepts another manifest path. `seed.ts` consumes those examples by handle instead of assuming account order. A company, parliament, federation or club uses the same proposal, two-party consent, publication and permission workflow. Automated tests exercise all four with arbitrary role IDs.

For an existing sandbox, an operator first establishes the organisation's account and appointed reviewer. Prepare a private JSON enrolment file with this structure, replacing placeholders with already provisioned sandbox identities:

```json
{
  "organisation": {
    "did": "<organisation account DID>",
    "name": "Example organisation · demo",
    "description": "Synthetic example organisation",
    "domain": "example.test",
    "issuerHandle": "<organisation sandbox handle>",
    "issuerPassword": "<private sandbox account password>",
    "approvers": ["<reviewer DID>"],
    "scopes": ["*", "unit:communications"]
  },
  "people": [
    {
      "did": "<reviewer DID>",
      "handle": "<reviewer sandbox handle>",
      "name": "Reviewer · demo"
    }
  ]
}
```

`domain` is optional; the DID is the stable identity. `people` contains only newly enrolled people and can be omitted when the reviewer already exists. Role IDs and labels are supplied with each proposal, not hardcoded per organisation. Scopes belong to the organisation's configuration. The operator must independently approve authority; entering a domain does not prove control, employment or permission.

Run `pnpm org:enrol /private/config/pilot.json /private/enrolment.json` in a source checkout. The command validates the entire result, rejects duplicate DIDs/handles/domains and unknown approvers, then atomically replaces the configuration with mode 0600. It prints only the organisation count. Restart the app to activate the new configuration. On the VPS, perform the edit with the configuration owner's UID, preserve ownership 1000:1000 and recreate only the app so the bind mount sees the replaced file. Keep a private backup first. The compiled image also contains `dist/src/pilot/enrol.js` for operator use in an offline one-off container.

Real organisations use this model, but the hosted pilot remains an isolated sandbox: production onboarding needs an independently verified organisation-to-DID binding and authorised reviewer appointment. It does not automatically certify a new organisation merely because two accounts agree.

## Trust and lifecycle

Each configured organisation has its own persistent signing key. Consumer trust pins issuer, key, claim type and `organisationDid`. Discovering `/api/trust` does not make its keys trusted: a consuming application's operator must explicitly approve that policy. Person login never appoints an approver or grants business permissions. Approver attestations are bootstrapped from operator configuration, then checked through the existing policy evaluator with an exact organisation binding. There is no automatic role-to-admin mapping and no self-approval of both sides.

A proposal version is immutable after approval. Editing archives/revokes the old version, removes its grants, and starts a new revision. Server-side optimistic revision checks reject stale forms. The authenticated actor comes from the encrypted browser session; request bodies cannot choose the acting DID.

Publication intent, exact record content and deterministic keys are durable before remote writes. Both repositories must authenticate the same URI/CID before activation. The person-side acceptance is a custom Lexicon record, not a claimed JSON signature. The SDK verifies the current record CID, signed repository commit and Merkle inclusion proof against the enrolled DID's current key from the private PLC. Failure or a changed record denies verification. A 30-second reconciliation worker resumes partial writes and cleanup at the same keys. Read failures do not create positive results.

`verifyPublicAffiliation` accepts an **authenticated record resolver** callback. The callback must verify repository signatures/inclusion and current CIDs; a raw AppView JSON response is not an implementation. `src/pilot/repository.ts` demonstrates this with `@atproto/repo.verifyRecords`. No issuer code ships in the independent verifier.

Private affiliation consent is recorded by the service, with no public acceptance record. It is not presented as independently provable person-side public consent. Public-profile UI and external package support do not create a Bluesky badge.

`events.publish` is an explicit grant bound to person, organisation, exact scope, affiliation revision and expiry. `*` is the **literal whole-organisation scope**, not an implicit wildcard matching every team. Issuance and action rules are declared in `descriptors.ts` and evaluated by `src/core/policy.ts`. Every action checks a fresh signature/status and current affiliation/acceptance. No cached permission fallback. The organisation's service writes to its own PDS repository; it never gives its credentials to a person or browser. A single-process operation queue orders local revocations and writes. A completed event remains published after a grant is revoked. An external PDS edit can race any remote check; the demo does not promise a distributed transaction across an independently operated PDS and application database.

Either party can end an affiliation. Local invalidation precedes remote deletion; cleanup retries are durable. Permissions stop on the next action in this service. The exported status policy allows at most 30 seconds of signed-status age. Copies of previously public data may remain elsewhere after withdrawal.

## Local checks

Use Node 24.17.x and pnpm 11.8.0.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm --dir pilot-fixture install --frozen-lockfile
pnpm test:pilot-integration
pnpm pilot:preview
```

The preview listens on loopback port 4313 (override `PILOT_PREVIEW_PORT`). It creates a disposable SDK PDS/PLC and synthetic users. The private login file path is printed; passwords are not. Local fixture identities are disposable. The hosted PDS and app volumes are persistent. Never point the fixture at the live PDS or reset live data.

Tests cover both directions, stale edits, wrong issuer/org/scope/subject, self-approval, private disclosure, lost-write recovery, signature/CID checks, tampering, unavailable repositories, expiry, dependent revocation and HTTP session/origin boundaries. Gateway checks cover TLS host separation and rejection of protocol/operator routes.

The operator can run `node deploy/pilot/smoke.mjs /private/path/demo-logins.json` against the hosted synthetic pilot. This exercises real HTTPS login, both approval directions, public proof, private visibility, scoped publishing, grant revocation, revision invalidation and withdrawal. It revokes its test affiliations and logs out; one clearly labelled synthetic test event remains published. It never prints secrets.

The hosted smoke script discovers its actors from configured authority, without depending on Devotta or person names. Its private input needs enrolled accounts for a person without active grants and independent reviewers in two organisations, with at least two scopes in the tested organisation.

## VPS deployment and rollback

The app lives in `/root/affiliation-pilot`. Its Compose project owns three containers: app, a fixed private PDS/PLC bridge, and a fixed public HTTP bridge. The app's only network is its internal sandbox. It has no host ports, external DNS forwarding, Docker socket, TLS keys or production organisation-verifier credentials. The public bridge is `10.249.99.14:3000` on the existing internal hackathon-public network. The private bridge forwards only to the sandbox PDS and PLC. Synthetic account provisioning uses the sandbox administrator only during the operator script; no PDS admin credential is mounted into the app.

`affiliation-pilot_pilot-data` holds workflow/issuer databases and signing keys. `.runtime/pilot.json` holds the fixed roster and organisation sandbox credentials. `.runtime/auth-key` separately holds the shared auth store's stable encryption key. Both are mode 0600, mounted read-only, and never included in source archives. `.runtime/demo-logins.json` is the operator's private login sheet. Back up data, configuration and auth key together. No automatic backup service is installed.

The existing public gateway uses a separate reviewed bundle under `/root/affiliation-pilot/gateway`. Its override is in `/etc/loftet-deploy/public-hackathon/edge.json`. Preserve this override and the additional target/firewall rule when updating the gateway. The existing wildcard certificate and renewal timer cover the pilot hostname. `gateway.patch` records source changes against loftet-social a80a04e4f016c28f58d4fd9c4b2e7d3768a5a1d9.

The rollout stores previous edge configuration and unrelated container identities in `/root/loftet-rollbacks/affiliation-pilot-20261015`. Its `rollback.sh` restores only the previous gateway configuration and recreates the gateway. It does not restore old databases, delete volumes or stop existing services. The pilot DNS A record can remain unused during rollback. Application updates pass the [CI/CD quality gate](quality.md), deploy the exact checked image and recreate only the pilot app with automatic health-based rollback; back up SQLite before any future schema migration.

`provision.py`, `cutover.py` and `dns.py` are explicit VPS operator tools. DNS is published only after a valid HTTPS `curl --resolve` check. Do not use `down -v`. Do not print resolved Compose configuration because it may include other services' secrets. Current build hashes and verification results belong in deployment metadata.

## Deliberate pilot limits

Enrolled sandbox accounts only; no open signup, public-account OAuth, account recovery, HR directory sync, email invitations, general delegation chains, permission catalogue beyond event publishing, or multi-process deployment. Real deployments need approved organisation onboarding, personal identity linkage as appropriate, OAuth for public accounts, operational key rotation/backup and a reviewed enrolment process. The existing shared auth package provides OAuth primitives but this demo uses the private PDS credential flow, like the existing public hackathon apps. The public website must not be represented as proof of actual employment.
