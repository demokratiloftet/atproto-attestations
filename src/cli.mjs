#!/usr/bin/env node
// Operator commands. Issuance normally happens over HTTP from an application;
// these exist to set a demonstration up and to inspect what the issuer did.
import { writeFileSync } from 'node:fs';
import { readConfig } from './config.mjs';
import { createService } from './service.mjs';

const [command, ...rest] = process.argv.slice(2);
const flag = name => { const i = rest.indexOf(`--${name}`); return i === -1 ? undefined : rest[i + 1]; };
const pairs = name => Object.fromEntries(rest.flatMap((value, i) => value === `--${name}` ? [String(rest[i + 1] || '').split('=')] : []));

const USAGE = `attest-issuer <command>

  document                 print the public issuer document
  trust-policy [--out f]   print what a consuming application should trust
  seed                     create the synthetic demo cast in the local roster
  issue --claim-type <id> --subject <did> [--requester-did <did>] [--request k=v]
  revoke --id <id> [--requester-did <did>]
  held --subject <did>
  audit [--limit n]`;

const config = readConfig();
const { issuer, adapter } = await createService(config);
const out = value => console.log(JSON.stringify(value, null, 2));

// The synthetic cast used by the demonstration: a leader, a coach with a
// swimming licence and a police certificate, and a child with neither.
const CAST = {
  leder: { identity: { assuranceLevel: 'substantial', provider: 'demo-idp', method: 'syntetisk-demo' }, clubs: [{ orgId: 'fjord', orgName: 'Fjord idrettslag', role: 'leder' }] },
  trener: { identity: { assuranceLevel: 'substantial', provider: 'demo-idp', method: 'syntetisk-demo' }, clubs: [{ orgId: 'fjord', orgName: 'Fjord idrettslag', role: 'trener' }], licences: [{ discipline: 'svomming', level: 'instruktor-2', orgId: 'fjord' }], attests: [{ orgId: 'fjord' }] },
  medlem: { identity: { assuranceLevel: 'substantial', provider: 'demo-idp', method: 'syntetisk-demo' }, clubs: [{ orgId: 'fjord', orgName: 'Fjord idrettslag', role: 'medlem' }] },
};

try {
  if (command === 'document') out(issuer.document());
  else if (command === 'trust-policy') {
    const policy = issuer.trustPolicy();
    if (flag('out')) { writeFileSync(flag('out'), `${JSON.stringify(policy, null, 2)}\n`); console.log(`Wrote ${flag('out')}`); }
    else out(policy);
  } else if (command === 'seed') {
    if (!config.demo) throw new Error('Seeding synthetic people is only available in a demo deployment.');
    const people = {};
    for (const [role, facts] of Object.entries(CAST)) people[`did:plc:demo-${role}`] = adapter.enrol(`did:plc:demo-${role}`, facts);
    out({ demo: true, people: Object.keys(people) });
  } else if (command === 'issue') {
    out(await issuer.issue({
      claimType: flag('claim-type'), subject: flag('subject'), request: pairs('request'),
      requester: { did: flag('requester-did') || flag('subject'), client: flag('client') },
    }));
  } else if (command === 'revoke') {
    out(await issuer.revoke({ id: flag('id'), claimType: flag('claim-type'), subject: flag('subject'), requester: { did: flag('requester-did'), client: flag('client') } }));
  } else if (command === 'held') out(issuer.held(flag('subject')));
  else if (command === 'audit') out(issuer.audit(Number(flag('limit')) || 50));
  else { console.error(USAGE); process.exit(2); }
} catch (error) {
  console.error(`${error.status || 500}: ${error.message}`);
  process.exit(1);
}
