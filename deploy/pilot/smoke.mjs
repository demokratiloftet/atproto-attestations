import assert from "node:assert/strict";
// Explicit operator check against the deployed synthetic demo. Credentials stay in memory.
// Usage: node deploy/pilot/smoke.mjs /private/path/demo-logins.json
import { readFile } from "node:fs/promises";

const { url, accounts } = JSON.parse(await readFile(process.argv[2], "utf-8"));
const { origin } = new URL(url);
assert.equal(new URL(origin).protocol, "https:");
async function request(
  path,
  body,
  cookie,
  expected = 200,
  originHeader = origin,
) {
  const res = await fetch(origin + path, {
    headers: {
      ...(body === undefined
        ? {}
        : { "content-type": "application/json", origin: originHeader }),
      ...(cookie ? { cookie } : {}),
    },
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(
    res.status,
    expected,
    `${path}: expected ${expected}, got ${res.status}`,
  );
  const data = await res.json().catch(() => ({}));
  return { cookie: res.headers.get("set-cookie")?.split(";")[0], data };
}
const publicState = (await request("/api/state")).data;
assert.equal(
  publicState.demo,
  true,
  "Only run against an explicitly labelled sandbox demo",
);
const signedIn = [];
for (const account of accounts) {
  const { cookie } = await request("/api/login", {
    handle: account.handle,
    password: account.password,
  });
  assert.ok(cookie);
  signedIn.push({
    cookie,
    state: (await request("/api/state", undefined, cookie)).data,
  });
}
// Discover independent actors and scopes from configuration, without organisation or person names.
const org = publicState.organisations.find(
  (candidate) =>
    candidate.scopes.length >= 2 &&
    signedIn.some((actor) =>
      actor.state.organisations.some(
        (row) => row.did === candidate.did && row.canReview,
      ),
    ),
);
assert.ok(
  org,
  "Smoke test needs an organisation with two scopes and an enrolled reviewer",
);
const reviewer = signedIn.find((actor) =>
  actor.state.organisations.some((row) => row.did === org.did && row.canReview),
);
const person = signedIn.find(
  (actor) =>
    !actor.state.organisations.some((row) => row.canReview) &&
    !actor.state.grants.some(
      (grant) => !grant.revoked && Date.parse(grant.expiresAt) > Date.now(),
    ),
);
const outsider = signedIn.find(
  (actor) =>
    actor.state.organisations.some(
      (row) => row.did !== org.did && row.canReview,
    ) &&
    !actor.state.organisations.some(
      (row) => row.did === org.did && row.canReview,
    ),
);
assert.ok(
  reviewer && person && outsider,
  "Smoke test needs a person without grants and reviewers from two organisations",
);
const sessions = {
  outsider: outsider.cookie,
  person: person.cookie,
  reviewer: reviewer.cookie,
};
const getState = async (name) =>
  (await request("/api/state", undefined, sessions[name])).data;
const { state } = person;
const otherOrg = state.organisations.find((row) => row.did !== org.did);
assert.ok(otherOrg);
const [scope, otherScope] = org.scopes;
const now = Date.now();
const terms = {
  expiresAt: new Date(now + 86_400_000).toISOString(),
  organisationDid: org.did,
  relationship: "employee",
  roleId: "demo.smoke",
  roleLabel: "System test · synthetic affiliation",
  scope,
  subject: state.person.did,
  validFrom: new Date(now - 60_000).toISOString(),
  visibility: "public",
};
const event = {
  organisationDid: org.did,
  scope: terms.scope,
  startsAt: new Date(now + 3_600_000).toISOString(),
  title: "System test · publishing with approved access",
};
await request("/api/proposals", { terms }, undefined, 401);
await request(
  "/api/proposals",
  { terms },
  sessions.person,
  403,
  "https://untrusted.example",
);
await request("/api/events", event, sessions.person, 403);
for (const path of [
  "/.env",
  "/xrpc/com.atproto.server.describeServer",
  "/api/issue",
]) {
  await request(path, undefined, undefined, 404);
}
const cleanup = [];
try {
  const { id } = (await request("/api/proposals", { terms }, sessions.person))
    .data;
  cleanup.push({ id, revision: 1 });
  await request(
    "/api/proposals/approve",
    { id, revision: 1 },
    sessions.outsider,
    403,
  );
  await request(
    "/api/proposals/approve",
    { id, revision: 1 },
    sessions.reviewer,
  );
  let proof = (await request(`/api/credential?id=${id}`)).data;
  assert.equal(proof.verification.valid, true);
  assert.ok(proof.affiliation.cid && proof.acceptance.cid);
  await request("/api/events", event, sessions.person, 403);
  const grant = {
    action: "events.publish",
    expiresAt: terms.expiresAt,
    id,
    revision: 1,
    scope: terms.scope,
  };
  await request("/api/grants", grant, sessions.outsider, 403);
  const grantId = (await request("/api/grants", grant, sessions.reviewer)).data
    .id;
  await request(
    "/api/events",
    { ...event, scope: otherScope },
    sessions.person,
    403,
  );
  await request(
    "/api/events",
    { ...event, organisationDid: otherOrg.did },
    sessions.person,
    403,
  );
  await request("/api/events", event, sessions.person);
  await request("/api/grants/revoke", { id: grantId }, sessions.reviewer);
  await request("/api/events", event, sessions.person, 403);
  await request("/api/grants", grant, sessions.reviewer);
  const revised = { ...terms, roleLabel: "System test · revised role" };
  await request(
    "/api/proposals/change",
    { id, revision: 1, terms: revised },
    sessions.reviewer,
  );
  cleanup[0].revision = 2;
  await request(
    "/api/proposals/approve",
    { id, revision: 1 },
    sessions.person,
    409,
  );
  await request("/api/events", event, sessions.person, 403);
  await request("/api/proposals/approve", { id, revision: 2 }, sessions.person);
  proof = (await request(`/api/credential?id=${id}`)).data;
  assert.equal(proof.verification.valid, true);
  await request("/api/events", event, sessions.person, 403);
  await request("/api/grants", { ...grant, revision: 2 }, sessions.reviewer);
  await request("/api/proposals/revoke", { id, revision: 2 }, sessions.person);
  cleanup.shift();
  await request("/api/events", event, sessions.person, 403);
  await request(`/api/credential?id=${id}`, undefined, undefined, 404);

  const privateId = (
    await request(
      "/api/proposals",
      { terms: { ...terms, roleId: "demo.private", visibility: "private" } },
      sessions.reviewer,
    )
  ).data.id;
  cleanup.push({ id: privateId, revision: 1 });
  let proposal = (await getState("person")).proposals.find(
    (p) => p.id === privateId,
  );
  assert.equal(proposal.subjectApproved, false);
  assert.equal(proposal.state, "pending");
  await request(
    "/api/proposals/approve",
    { id: privateId, revision: 1 },
    sessions.person,
  );
  proposal = (await getState("person")).proposals.find(
    (p) => p.id === privateId,
  );
  assert.equal(proposal.verification.valid, true);
  await request(`/api/credential?id=${privateId}`, undefined, undefined, 404);
  assert.equal(
    (await getState("outsider")).proposals.some((p) => p.id === privateId),
    false,
  );
  assert.equal(
    (await request("/api/state")).data.publicCredentials.some(
      (p) => p.id === privateId,
    ),
    false,
  );
  console.log(
    "PASS: live HTTPS sessions, both initiation directions, signed public proof, private visibility, organisation/scope isolation, explicit grant, publish, grant revocation, revision invalidation, stale approval, subject withdrawal and gateway refusal.",
  );
} finally {
  for (const p of cleanup) {
    await request("/api/proposals/revoke", p, sessions.person);
  }
  for (const { cookie } of signedIn) {
    await request("/api/logout", {}, cookie);
  }
}
