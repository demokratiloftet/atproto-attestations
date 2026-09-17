# Working in this repository

- `verify/` must never import from `src/`. An application that only checks
  claims installs the verifier alone, and must not receive code that can issue.
- Trust comes from the signature and the consuming application's trust policy.
  Never add a code path that accepts a claim because of where it was found, who
  served it, or a field inside the record itself.
- Fail closed. An unreachable issuer, a missing descriptor, an unresolved
  policy binding and a stale status answer are all refusals, never "probably
  fine".
- Authorisation belongs in the claim-type descriptor, evaluated by
  `src/core/policy.mjs`. Do not special-case a claim type in the issuer, the
  server or the console.
- Adapters answer whether a fact is true. They never sign, publish, or decide
  who may ask. Keep AT Protocol and HTTP out of them.
- Restricted claims are never published, and a query answers `valid`, `none` or
  `expired` and nothing more. Every query is audited, allowed or refused.
- Keep demonstration data synthetic and labelled. No implied NIF, Idrettens ID
  or politiet integration in code, copy or screenshots.
- Run `npm test` before committing. Add a test for every refusal a change
  introduces, not only the path that succeeds.
- Keep credentials and signing keys out of source, responses, logs and
  screenshots. `data/` is ignored on purpose.
