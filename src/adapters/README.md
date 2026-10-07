# Writing an adapter

An adapter is the only file an organisation has to write. It answers one
question, from the organisation's own systems:

> Is this fact true about this account, right now?

It never signs, never publishes, never decides who may ask, and never sees the
signing key. If it cannot answer, it says so, and nothing is issued.

```ts
import type { AdapterRequest, AdapterAnswer } from "../types.js";

export default {
  id: "nif",
  claimTypes: ["no.nif.clubRole", "no.nif.instructorLicence"],

  async check({ subject, request }: AdapterRequest): Promise<AdapterAnswer> {
    // subject   the account the claim would be about (a DID)
    // request   what was asked for; only the returned claim is schema-validated
    // requester who is asking, after the issuance policy allowed them
    const person = await lookUpInOurOwnSystems(subject);
    if (!person)
      return { granted: false, reason: "Ukjent konto hos utstederen." };

    return {
      granted: true,
      claim: {
        orgId: request.orgId,
        orgName: person.club.name,
        role: person.role,
      },
      maxLifetimeDays: 90, // optional: shorter than the claim type allows
    };
  },
};
```

Rules the core enforces around you:

- The returned `claim` is validated against the claim type's schema. A claim
  that does not match is not issued, however confident the adapter was.
- `maxLifetimeDays` can only shorten the claim type's own limit, never extend it.
- `granted: false` must carry a `reason` that is safe to show the person asking.
  Do not put evidence, case details or personal identifiers in it.
- The adapter is called only after the issuance policy has allowed the
  requester. It is not a place to implement access control.

Keep the adapter free of AT Protocol, signing and HTTP concerns. Replacing the
synthetic adapter with a real integration must not require touching anything
else in this repository.
