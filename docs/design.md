# Attestation issuer — design

An organisation runs this service to state a narrow, checkable fact about an
account it does not own: *"this account holds a valid swimming instructor
licence"*, *"this account may publish events for club X"*. Any application can
check that statement without contacting the organisation's databases, and
without trusting whoever hosts the data.

The demo issuer inside `calendar-app` proved the shape. This repository is the
reusable version: NIF runs it against their systems, politiet could run their
own instance against theirs, and neither has to adopt our calendar.

## What is generic, and what each organisation supplies

| Supplied here | Supplied by the organisation |
| --- | --- |
| Claim envelope, signing, key publication | Its signing key |
| Claim-type descriptors and their validation | Which claim types it offers |
| Issuance and disclosure policy evaluation | Its own authority data, via one adapter |
| Status, revocation, audit | Its deployment and domain |
| Verification library and CLI | — |

Generic software cannot make an organisation authoritative. Every consuming
application still decides, in its own trust policy, which issuer it accepts for
which claim types. Being trusted for club roles does not make an issuer trusted
for professional qualifications.

## The three units

```
issuer service (organisation's infrastructure)
  adapter ──> the organisation's own systems        (they write this)
  core ─────> descriptor, policy, sign, status      (generic)
  publish ──> AT Protocol repo, or nothing          (pluggable)
        │
        ├─ https://org.example/.well-known/attestation-issuer.json   (public keys)
        ├─ https://org.example/status/<id>                           (revocation)
        └─ https://org.example/query                                 (restricted claims)
        │
        v
consuming application (calendar, CLI, third party)
  verify library + trust policy ──> verdict
```

`verify/` imports nothing from `src/`. An application that only checks claims
never installs the issuer.

## The wire format

A signed JWS carries the truth. Everything outside it is decoration.

```json
{
  "$type": "no.demokratiloftet.attestation",
  "version": 1,
  "jws": "<compact JWS, ES256>",
  "view": { "claimType": "...", "subject": "did:plc:...", "expiresAt": "..." }
}
```

`view` exists so a record is legible in a repository browser. Verification
decodes the JWS, checks the signature, and then uses **the signed payload** as
the only source of truth. A mismatch between `view` and the payload is reported,
never tolerated. This avoids canonicalisation disagreements between
implementations: there is exactly one byte sequence that was signed.

The signed payload:

```json
{
  "v": 1,
  "id": "01J...",                     "jti", unique per attestation
  "iss": "https://nif.example/.well-known/attestation-issuer.json",
  "sub": "did:plc:...",               the holder's account
  "claimType": "no.nif.instructorLicence",
  "claim": { "discipline": "swimming", "level": "instruktor-2" },
  "iat": "2026-09-17T12:00:00.000Z",
  "exp": "2027-09-17T12:00:00.000Z",
  "status": "https://nif.example/status/01J..."
}
```

`iss` is the URL of the issuer's key document, so a verifier can always find the
keys from the claim itself, and a trust policy is a statement about that URL.

## Trust

A consuming application holds a trust policy naming, per claim-type pattern,
which issuer it accepts and which keys that issuer may sign with:

```json
{ "version": 1,
  "trust": [
    { "claimTypes": ["no.nif.*"],
      "issuer": "https://nif.example/.well-known/attestation-issuer.json",
      "keys": [ { "kid": "key-1", "kty": "EC", "crv": "P-256", "x": "...", "y": "..." } ] } ],
  "maxClockSkewSeconds": 60 }
```

Pinned keys are the default because they need no network at verification time
and cannot be swapped by whoever controls DNS. A policy may instead allow
fetching the key document over HTTPS, at the cost of that dependency.

Verification reports each check separately — signature, trust, schema, validity
window, status, and optional repository provenance — so an application can
explain *why* something failed instead of showing a single red cross.

## Authorisation: who may ask, and who may know

Two questions the issuer answers before it does anything, both expressed in the
claim-type descriptor, both evaluated with the same verify library.

**Issuance.** Who may request this claim for this subject.

```json
"issuance": { "requesters": [
  { "kind": "self" },
  { "kind": "attestation", "claimType": "no.nif.clubRole",
    "where": { "role": "leder", "orgId": "$request.orgId" } } ] }
```

A coach requests their own licence. A club leader requests a role for someone in
the club they lead — `$request.orgId` binds the leader's own attestation to the
club in the request, so leading Fjord grants nothing over Marka.

**Disclosure.** Who may learn that the claim exists.

```json
"visibility": "restricted",
"disclosure": { "mode": "query-only", "purposes": ["politiattest-kontroll"],
  "requesters": [
    { "kind": "attestation", "claimType": "no.nif.clubRole",
      "where": { "role": "leder", "orgId": "$request.orgId" } } ] }
```

A restricted claim is never published to any repository. It is answered only
through `POST /query`, only to a requester who presents a qualifying
attestation, and the answer is the smallest useful one: `valid`, `none` or
`expired`, with no evidence, no dates and no case detail. Every query is
audited against the requester. A child, a parent, or the leader of a different
club is refused — not because the application hides a button, but because the
issuer will not answer.

**Assurance.** How well the subject must be identified is the same mechanism
again, not a special case:

```json
"subjectAssurance": { "claimType": "no.nif.identityLinked",
                      "where": { "assuranceLevel": "substantial" } }
```

The synthetic demo provider issues `identityLinked` today; Idrettens ID with
BankID would issue the same claim type at a higher `assuranceLevel` later. Only
the descriptor changes.

Policy evaluation is depth-limited to one level. A presented attestation is
verified in full, but attestations it depends on are not chased, so the reason
for a decision stays explainable.

## Revocation

Public claims: the status endpoint is authoritative, and revocation also deletes
the published record so the fast path agrees. Restricted claims: status only.

A signed claim that has been copied elsewhere stays signed. That is why status
is a separate, signed, timestamped answer, and why `requireStatusCheck` defaults
to on for anything that grants a permission. An unreachable status endpoint is
"cannot verify", never "valid".

## Claim types shipped

| Claim type | Visibility | Purpose |
| --- | --- | --- |
| `no.nif.identityLinked` | public | The account was linked to an authenticated identity at a stated assurance level. No personal identifiers. |
| `no.nif.clubRole` | public | Role in a named club: `leder`, `trener`, `medlem`. Basis for delegation. |
| `no.nif.instructorLicence` | public | Discipline and level, e.g. swimming instructor. The first NIF case. |
| `no.politiet.attest` | restricted | Demonstrates query-only disclosure. Synthetic, and not a police integration. |

All four are demonstrations with synthetic data. Nothing here is endorsed by
NIF, Idrettens ID or politiet.

## Deliberately not built

Multi-tenant hosting, W3C VC / SD-JWT wire formats, selective disclosure,
key rotation ceremonies beyond publishing several keys, delegation chains
deeper than one level, and any real personal data.
