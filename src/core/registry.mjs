// Claim types are loaded from files at start-up and refused loudly if broken.
// An organisation adds a claim type by adding a descriptor, not by writing code.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDescriptor } from '../../verify/claim-type.mjs';

export function loadClaimTypes(directory) {
  const types = {};
  for (const file of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
    let descriptor;
    try { descriptor = parseDescriptor(JSON.parse(readFileSync(join(directory, file), 'utf8'))); }
    catch (error) { throw new Error(`${file}: ${error.message}`); }
    if (`${descriptor.id}.json` !== file) throw new Error(`${file}: the file must be named after the claim type id`);
    types[descriptor.id] = descriptor;
  }
  if (!Object.keys(types).length) throw new Error(`No claim types found in ${directory}`);
  return types;
}
