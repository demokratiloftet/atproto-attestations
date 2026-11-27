# Attestation issuer

An organisation runs this service to state a narrow, checkable fact about an account it does not own:

> «Denne kontoen har gyldig instruktørlisens i svømming.» «Denne kontoen kan publisere arrangementer for Fjord idrettslag.»

Any application can then check that statement without contacting the organisation's databases and without trusting whoever hosts the data. The organisation writes one adapter against its own systems. Everything else — the claim envelope, signing, key publication, policy, revocation, audit and the verification library — is here.

Node.js 24.17.x (see `.node-version`). Cryptography and SQLite use Node built-ins; the affiliation app also uses AT Protocol SDKs and the shared authentication package.

## Generic affiliation pilot

The generic two-party affiliation workflow, public credentials and scoped event-publishing permissions are documented in [the pilot guide](docs/pilot.md). It reuses this issuer/signature policy and the shared `@loftet/auth` encrypted store. The VPS demo uses synthetic accounts on the private hackathon PDS; it does not certify real employment or connect to NIF/Stortinget systems.

## Try it in two minutes

```sh
# One-time setup if pnpm is not installed:
npm install --global pnpm@11.8.0
gh repo clone demokratiloftet/attestation-issuer
cd attestation-issuer
pnpm install --frozen-lockfile
pnpm run build
pnpm run dev                     # or: pnpm start
open http://127.0.0.1:3011      # key: local-demo-only
```

Choose **Legg inn demokontoer**, then work through the console:

1. Issue **Kontokobling** for `leder` and `trener`. Nothing else can be issued first — the other claim types require it.
2. Issue **Rolle i idrettslag** for `leder` with `orgId=fjord`.
3. Issue **Instruktørlisens** for `trener` with `discipline=svomming`.
4. In **Begrenset innsyn**, register a police certificate for `trener`. The console's own key is refused; use `local-demo-politiet`.
5. Ask about `trener` as `leder` → _Gyldig attest_. Ask as `medlem`, or as `trener`, or as `leder` on behalf of `marka` → refused, each with its reason.
6. Read the journal. Every question is there, including the refusals.

## Verify a claim from outside

The verifier is a separate program that holds no credentials and never sees the issuer's database. Keep the service from the quickstart running: the status check is a real request to the issuer, and an unreachable issuer is a refusal.

```sh
node dist/src/cli.js trust-policy --out trust-policy.json
node dist/src/cli.js issue --claim-type no.nif.identityLinked --subject did:plc:demo-trener
node dist/src/cli.js issue --claim-type no.nif.instructorLicence \
  --subject did:plc:demo-trener --request discipline=svomming > licence.json
node -e "require('fs').writeFileSync('record.json',JSON.stringify(require('./licence.json').record))"

pnpm run verify:claim record.json --trust trust-policy.json --claim-types ./claim-types \
  --expect-subject did:plc:demo-trener --expect-claim discipline=svomming
```

It prints each check separately and exits 0 accepted, 1 refused, 2 usage error. Revoke the claim and run it again: the signed status answer changes, and the same record is refused. Add `--no-status` to check a record without contacting the issuer at all — useful offline, and honest about what it did not check.

## How trust works

A compact ES256 JWS carries every fact. The record published to a repository wraps it:

```json
{
  "$type": "no.demokratiloftet.attestation",
  "version": 1,
  "jws": "<compact JWS>",
  "view": { "claimType": "…", "subject": "did:plc:…", "expiresAt": "…" }
}
```

`view` exists so the record is legible in a repository browser. Verification decodes the JWS and uses **the signed payload** as the only source of truth; a disagreement between the two fails verification rather than being tolerated.

A consuming application holds a trust policy naming, per claim-type pattern, which issuer it accepts and which keys that issuer may sign with. Pinned keys are the default: they need no network at verification time and cannot be swapped by whoever controls DNS. See `examples/trust-policy.json`.

Being trusted for club roles grants nothing over police certificates. Each entry lists its claim types, and `no.nif.*` does not match `no.politiet.attest`.

Verification reports six checks separately — signature, trust, schema, validity window, repository provenance and signed revocation status — so an application can explain a refusal instead of showing a single red cross. An unreachable issuer is `cannot verify`, never `valid`.

## Authorisation: who may ask, and who may know

Both questions are declared in the claim-type descriptor and evaluated with the same verify library a consuming application uses. The issuer gives itself no shortcut.

**Who may request that a claim be issued.**

```json
"issuance": { "requesters": [
  { "kind": "self" },
  { "kind": "attestation", "claimType": "no.nif.clubRole",
    "where": { "role": "leder", "orgId": "$request.orgId" } } ] }
```

A coach requests their own licence. A club leader requests a role for someone in the club they lead — `$request.orgId` binds the leader's own attestation to the club named in the request, so leading Fjord grants nothing over Marka. Presenting somebody else's attestation proves nothing: the evidence must be about the account that is asking.

**Who may learn that a restricted claim exists.**

```json
"visibility": "restricted",
"disclosure": { "mode": "query-only", "purposes": ["politiattest-kontroll"],
  "requesters": [
    { "kind": "attestation", "claimType": "no.nif.clubRole",
      "where": { "role": "leder", "orgId": "$request.orgId" } } ] }
```

A restricted claim is never published anywhere. It is answered only through `POST /query`, only to a requester who presents a qualifying attestation, and the answer is the smallest useful one: `valid`, `none` or `expired`. No documentation, no dates, no case detail. Every question is written to the audit trail, allowed or refused. A child, a parent, or the leader of another club is refused — not because an application hides a button, but because the issuer will not answer.

A claim type may also name the single client permitted to issue it:

```json
"issuance": { "requesters": [{ "kind": "client", "client": "politiet-backend" }] }
```

An events calendar cannot issue a police certificate, however well it authenticates people.

**How well the subject must be identified** is the same mechanism rather than a special case:

```json
"subjectAssurance": { "claimType": "no.nif.identityLinked",
                      "where": { "assuranceLevel": "substantial" } }
```

The synthetic demo provider issues `identityLinked` today; Idrettens ID with BankID would issue the same claim type at a stated assurance level later. Only the descriptor changes.

Policy evaluation is depth-limited to one level. Presented evidence is verified in full, but the attestations behind it are not chased, so the reason for a decision stays explainable.

## What each organisation supplies

| Here                                        | The organisation                        |
| ------------------------------------------- | --------------------------------------- |
| Claim envelope, signing, key publication    | Its signing key                         |
| Claim-type descriptors and their validation | Which claim types it offers             |
| Issuance and disclosure policy              | Its authority data, through one adapter |
| Status, revocation, audit                   | Its deployment and domain               |
| Verification library and CLI                | —                                       |

Generic software cannot make an organisation authoritative. Every consuming application still decides which issuer it accepts for which claim types.

### Adding a claim type

Add a descriptor to `claim-types/`, named after its id. No code changes. It is validated at start-up and refused loudly if it is inconsistent — a restricted claim that declares itself publishable, a `where` binding that names a field the claim does not have, or query-only disclosure with nobody allowed to ask.

### Writing an adapter

See `src/adapters/README.md`. An adapter answers one question — _is this fact true about this account, right now?_ — and never signs, publishes, or decides who may ask. `src/adapters/demo-nif.ts` is a synthetic example whose "database" is a JSON file. Replacing it with a real integration must not require touching anything else.

## HTTP

|        |                                        |                                                                 |
| ------ | -------------------------------------- | --------------------------------------------------------------- |
| `GET`  | `/.well-known/attestation-issuer.json` | Public. Name, keys, claim types offered.                        |
| `GET`  | `/trust-policy.json`                   | Public. What an application should trust to accept this issuer. |
| `GET`  | `/claim-types`                         | Public. The descriptors.                                        |
| `GET`  | `/status/{id}`                         | Public, signed. `active`, `revoked`, `expired` or `unknown`.    |
| `POST` | `/issue`                               | Scope `issue`.                                                  |
| `POST` | `/revoke`                              | Scope `revoke`.                                                 |
| `POST` | `/query`                               | Scope `query`. Restricted claims.                               |
| `GET`  | `/held?subject=`                       | Scope `query`. Public claims held by an account.                |
| `GET`  | `/audit`                               | Scope `admin`.                                                  |
| `POST` | `/demo/enrol`, `GET /demo/roster`      | Demo deployments only. Synthetic facts.                         |

Clients authenticate with a bearer token and carry scopes. The issuer trusts a registered client to have authenticated the accounts it names in `requesterDid` and `subject`: proving control of an AT Protocol account belongs to the calling application, and this service never sees a password or a login session.

## Deploying it

```sh
cp .env.example .env     # fill in origin, clients and tokens
docker compose --env-file .env up -d --build --wait
```

- Set `ISSUER_ORIGIN` to the HTTPS address the issuer is actually reached at. It appears inside every signature, so changing it later invalidates nothing but makes old claims resolve to a document that is no longer there.
- **Back up the signing key** in `ISSUER_DATA_DIR`. Losing it invalidates every attestation this issuer has ever made.
- Set `ISSUER_DEMO=false` for anything real. That removes the endpoints that invent facts about people.
- Publishing to AT Protocol is optional (`ISSUER_PUBLISHER=atproto`). Public claims are then written to the issuer's own repository. Restricted claims are never published whatever this is set to.
- The service binds to loopback in the supplied Compose file. It holds a signing key; put it behind your own TLS termination rather than exposing it directly.

## Status

Working and tested: the envelope, signing and verification, claim-type descriptors, issuance and disclosure policy, subject assurance, the adapter seam, publication to AT Protocol or nowhere, signed revocation status, the audit trail, the HTTP API, the console and both command-line tools. 44 tests cover forged signatures, unknown keys, rewritten display fields, wrong-club delegation, stolen evidence, expired evidence, untrusted issuers, unreachable status endpoints and stale status answers.

Not built: multi-tenant hosting, W3C Verifiable Credentials or SD-JWT wire formats, selective disclosure, key rotation beyond publishing several keys, delegation chains deeper than one level, and any real personal data.

All four shipped claim types are demonstrations with synthetic data. Nothing here is endorsed by, or connected to, NIF, Idrettens ID or politiet.

## Repository checks and deployment

Run `pnpm check` before committing and `pnpm test:integration` for affiliation or permission changes. The [quality and deployment guide](docs/quality.md) explains each CI check, local fixes and automatic VPS deployment. The direct Node server binds loopback by default; Compose explicitly binds inside its container and publishes only host loopback. Foreign Host/Origin headers and empty client tokens are refused. Shared use needs HTTPS and independently generated client tokens of at least 24 characters.

CI deploys the synthetic affiliation app to the VPS only after all checks pass. The standalone issuer service is not published by this pipeline. No real NIF/police integrations are activated. See [security policy](SECURITY.md).

## Strict TypeScript and the independent verifier

Server, verifier, CLI and unit tests use strict TypeScript; the affiliation browser and operator fixture scripts use JavaScript with Oxlint checks. `pnpm check` runs the complete local quality gate. `pnpm test` builds and runs the emitted code, including the full HTTP issuance/query/revocation journey. The Docker image compiles with pinned Node 24.17.0 and runs only emitted JavaScript; cryptography and SQLite use Node built-ins, with AT Protocol and shared authentication packages for the affiliation app.

`pnpm run pack:verifier` creates `dist/loftet-attestation-verifier-0.1.1.tgz`. Install that archive in a consuming app and import `verifyAttestation` and its public types from `@loftet/attestation-verifier`. The archive contains only compiled `verify/` modules and declarations, with no issuer, signing implementation, private keys or dependencies. Its CLI is `attest-verify`. Trust-policy parsing and runtime payload/schema validation remain mandatory; TypeScript does not make external JSON trustworthy.

The migration also rejects malformed schema metadata and request bodies, refuses nonfinite trust-policy time windows, and checks own schema properties so inherited names such as `__proto__` cannot bypass `additionalProperties: false`. The console constructs selectable labels with DOM text nodes and escapes audit identities.

## License

Licensed under [MIT](LICENSE).
