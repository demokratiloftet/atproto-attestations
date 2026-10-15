// A synthetic stand-in for an organisation's own systems. The "database" is a
// JSON roster on disk, so a demonstration can add a person without a migration.
// Replacing this file with a real integration must not change anything else.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { object } from "../../verify/values.ts";
import type { AdapterRequest, AdapterAnswer, Person } from "../types.ts";
import { parsePerson } from "./person.ts";

export function createDemoAdapter({ file }: { file: string }) {
  const read = (): { people: Record<string, Person> } => {
    try {
      const data = object(
        JSON.parse(readFileSync(file, "utf-8")),
        "demo roster"
      );
      return {
        people: Object.fromEntries(
          Object.entries(object(data.people, "demo people")).map(
            ([did, facts]) => [did, parsePerson(facts)]
          )
        ),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { people: {} };
      }
      throw error;
    }
  };
  const write = (roster: { people: Record<string, Person> }) => {
    mkdirSync(dirname(file), { mode: 0o700, recursive: true });
    writeFileSync(file, JSON.stringify(roster, null, 2), { mode: 0o600 });
  };

  return {
    async check({
      claimType,
      subject,
      request,
    }: AdapterRequest): Promise<AdapterAnswer> {
      const person = read().people[subject];
      if (!person) {
        return {
          granted: false,
          reason:
            "Kontoen finnes ikke i det syntetiske demoregisteret. Legg den inn i demopanelet forst.",
        };
      }

      if (claimType === "no.nif.identityLinked") {
        if (!person.identity) {
          return {
            granted: false,
            reason: "Kontoen er ikke koblet til en demo-identitet.",
          };
        }
        return {
          claim: {
            assuranceLevel: person.identity.assuranceLevel || "low",
            provider: person.identity.provider || "demo-idp",
            ...(person.identity.method
              ? { method: person.identity.method }
              : {}),
          },
          granted: true,
          maxLifetimeDays: 90,
        };
      }
      if (claimType === "no.nif.clubRole") {
        const membership = (person.clubs || []).find(
          (c) => c.orgId === request.orgId
        );
        if (!membership) {
          return {
            granted: false,
            reason:
              "Utstederen har ingen rolle registrert for denne kontoen i dette laget.",
          };
        }
        return {
          claim: {
            orgId: membership.orgId,
            orgName: membership.orgName,
            role: membership.role,
          },
          granted: true,
          maxLifetimeDays: 90,
        };
      }
      if (claimType === "no.nif.instructorLicence") {
        const licence = (person.licences || []).find(
          (l) => l.discipline === request.discipline
        );
        if (!licence) {
          return {
            granted: false,
            reason:
              "Utstederen har ingen gyldig lisens registrert i denne grenen.",
          };
        }
        if (licence.expiresAt && Date.parse(licence.expiresAt) <= Date.now()) {
          return {
            granted: false,
            reason: "Lisensen er utlopt hos utstederen.",
          };
        }
        return {
          claim: {
            discipline: licence.discipline,
            level: licence.level,
            ...(licence.orgId ? { orgId: licence.orgId } : {}),
          },
          granted: true,
          maxLifetimeDays: 180,
        };
      }
      if (claimType === "no.politiet.attest") {
        const attest = (person.attests || []).find(
          (a) => a.orgId === request.orgId
        );
        if (!attest) {
          return {
            granted: false,
            reason: "Ingen registrert attest for dette laget.",
          };
        }
        return {
          claim: { orgId: attest.orgId, purpose: "politiattest-kontroll" },
          granted: true,
          maxLifetimeDays: 1095,
        };
      }
      return { granted: false, reason: `Utstederen tilbyr ikke ${claimType}.` };
    },

    claimTypes: [
      "no.nif.identityLinked",
      "no.nif.clubRole",
      "no.nif.instructorLicence",
      "no.politiet.attest",
    ],

    demo: true,

    // Demonstration only: a real adapter has no way to write facts about people.
    enrol(subject: string, input: unknown) {
      const facts = parsePerson(input);
      const roster = read();
      roster.people[subject] = { ...roster.people[subject], ...facts };
      write(roster);
      return roster.people[subject];
    },

    id: "demo-nif",
    roster: () => read().people,
  };
}
