import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parsePilotConfig } from "../src/pilot/config.ts";
import { enrolFile, enrolOrganisation } from "../src/pilot/enrol.ts";
import { PilotService } from "../src/pilot/service.ts";
import type { PilotConfig, Ref, Repository } from "../src/pilot/types.ts";

function did(index: number) {
  return `did:plc:${String.fromCodePoint(97 + index).repeat(24)}`;
}
function initial(dataDir = "/tmp/affiliation-enrolment-test"): PilotConfig {
  return parsePilotConfig({
    dataDir,
    organisations: [
      {
        approvers: [did(0)],
        description: "Synthetic example",
        did: did(2),
        issuerHandle: "example.test",
        issuerPassword: "synthetic-example-password",
        name: "Example organisation",
        scopes: ["*"],
      },
    ],
    origin: "http://127.0.0.1:3013",
    pds: "http://fixture:3000",
    people: [
      { did: did(0), handle: "reviewer.test", name: "Reviewer" },
      { did: did(1), handle: "person.test", name: "Person" },
    ],
    plc: "http://fixture:3001",
    sandbox: true,
  });
}
function enrolment() {
  return {
    organisation: {
      approvers: [did(0)],
      description: "Synthetic new organisation",
      did: did(3),
      domain: "additional.test",
      issuerHandle: "additional.test",
      issuerPassword: "synthetic-enrolment-password",
      name: "Additional organisation",
      scopes: ["*", "unit:one"],
    },
  };
}
function repository(config: PilotConfig): Repository {
  const records = new Map<
    string,
    { cid: string; record: Record<string, unknown> }
  >();
  return {
    login(identifier) {
      const org = config.organisations.find(
        (row) => row.issuerHandle === identifier
      );
      if (!org) {
        return Promise.reject(new Error("Unenrolled fixture account"));
      }
      return Promise.resolve({ did: org.did, handle: identifier });
    },
    put(subject, collection, key, record) {
      const uri = `at://${subject}/${collection}/${key}`;
      const cid = createHash("sha256")
        .update(JSON.stringify(record))
        .digest("hex");
      records.set(uri, { cid, record });
      return Promise.resolve({ cid, uri });
    },
    read(ref: Ref) {
      const row = records.get(ref.uri);
      if (row?.cid !== ref.cid) {
        return Promise.reject(new Error("Changed record"));
      }
      return Promise.resolve(structuredClone(row.record));
    },
    remove(subject, collection, key) {
      records.delete(`at://${subject}/${collection}/${key}`);
      return Promise.resolve();
    },
  };
}
void test("the same workflow supports employers, assemblies, federations and clubs", async () => {
  const cases = [
    { name: "Employer", relationship: "employee", role: "company.engineer" },
    {
      name: "Assembly",
      relationship: "electedRepresentative",
      role: "assembly.representative",
    },
    { name: "Federation", relationship: "member", role: "federation.delegate" },
    { name: "Club", relationship: "volunteer", role: "club.coach" },
  ];
  for (const example of cases) {
    const directory = mkdtempSync(join(tmpdir(), "generic-affiliation-"));
    const input = enrolment();
    input.organisation.name = example.name;
    const config = enrolOrganisation(initial(directory), input);
    const service = new PilotService(config, repository(config));
    try {
      await service.init();
      const proposal = await service.propose(did(1), {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        organisationDid: did(3),
        relationship: example.relationship,
        roleId: example.role,
        roleLabel: example.role,
        scope: "unit:one",
        subject: did(1),
        validFrom: new Date(Date.now() - 1000).toISOString(),
        visibility: "public",
      });
      const active = await service.approve(
        did(0),
        proposal.id,
        proposal.revision
      );
      assert.equal((await service.verify(active)).valid, true);
      assert.equal(active.terms.roleId, example.role);
      assert.equal(
        await service.permission(did(1), did(3), "unit:one"),
        undefined
      );
      await service.grant(did(0), active.id, active.revision, {
        action: "events.publish",
        expiresAt: active.terms.expiresAt,
        scope: "unit:one",
      });
      assert.ok(await service.permission(did(1), did(3), "unit:one"));
      assert.equal(
        await service.permission(did(1), did(2), "unit:one"),
        undefined
      );
      await service.end(did(1), active.id, active.revision, "revoked");
      assert.equal(
        await service.permission(did(1), did(3), "unit:one"),
        undefined
      );
    } finally {
      service.close();
      rmSync(directory, { force: true, recursive: true });
    }
  }
});
void test("enrolment refuses duplicate identities and unauthorised approvers", () => {
  const config = initial();
  const input = enrolment();
  const enrolled = enrolOrganisation(config, input);
  assert.throws(() => enrolOrganisation(enrolled, input), /Duplicate/u);
  assert.throws(
    () =>
      enrolOrganisation(config, {
        organisation: { ...input.organisation, did: did(1) },
      }),
    /Duplicate/u
  );
  assert.throws(
    () =>
      enrolOrganisation(config, {
        organisation: { ...input.organisation, issuerHandle: "person.test" },
      }),
    /Duplicate/u
  );
  assert.throws(
    () =>
      enrolOrganisation(config, {
        organisation: { ...input.organisation, approvers: [did(20)] },
      }),
    /enrolled/u
  );
  assert.throws(
    () =>
      enrolOrganisation(enrolled, {
        organisation: {
          ...input.organisation,
          did: did(4),
          issuerHandle: "another.test",
        },
      }),
    /Duplicate organisation domain/u
  );
  assert.throws(
    () => parsePilotConfig({ ...config, sandbox: "true" }),
    /Explicit sandbox/u
  );
  assert.throws(
    () => parsePilotConfig({ ...config, pds: "https://public.example" }),
    /isolated/u
  );
  assert.equal(
    parsePilotConfig({
      ...config,
      pdsCanonical: "https://another-sandbox.example",
    }).pdsCanonical,
    "https://another-sandbox.example"
  );
  assert.equal(config.organisations[0]?.domain, undefined);
});
void test("operator enrolment writes atomically with private permissions and preserves failed input", () => {
  const directory = mkdtempSync(join(tmpdir(), "affiliation-config-"));
  const file = join(directory, "config.json");
  const input = join(directory, "enrolment.json");
  try {
    writeFileSync(file, JSON.stringify(initial(directory)), { mode: 0o600 });
    writeFileSync(input, JSON.stringify(enrolment()), { mode: 0o600 });
    assert.equal(enrolFile(file, input), 2);
    // oxlint-disable-next-line no-bitwise -- Check POSIX file permission bits.
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const saved = readFileSync(file, "utf-8");
    assert.throws(() => enrolFile(file, input), /Duplicate/u);
    assert.equal(readFileSync(file, "utf-8"), saved);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
