import type { Client } from "./types.ts";
import { object } from "../verify/values.ts";
// Configuration is read once, validated loudly, and never guessed. A shared
// deployment must state its own origin and its clients explicitly.
import { join } from "node:path";

const bool = (value: string | undefined, fallback: boolean) =>
  value === undefined
    ? fallback
    : ["1", "true", "yes"].includes(String(value).toLowerCase());

export function readConfig(env = process.env, root = process.cwd()) {
  const environment = env.ISSUER_ENV || "local";
  const local = environment === "local";
  const origin = new URL(
    env.ISSUER_ORIGIN || (local ? "http://127.0.0.1:3011" : ""),
  ).origin;
  if (
    local &&
    !["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)
  )
    throw new Error("Local demo credentials require a loopback origin");
  if (!local && !origin.startsWith("https:"))
    throw new Error(
      "A shared issuer must be reached over HTTPS: set ISSUER_ORIGIN",
    );

  const rawClients: unknown = JSON.parse(
    env.ISSUER_CLIENTS_JSON ||
      (local
        ? JSON.stringify([
            {
              id: "local-demo",
              token: "local-demo-only",
              scopes: ["issue", "query", "revoke", "admin"],
            },
            // A separate credential on purpose: no application can issue a police
            // certificate with the key it uses for everything else.
            {
              id: "politiet-backend",
              token: "local-demo-politiet",
              scopes: ["issue"],
            },
          ])
        : "[]"),
  );
  if (!Array.isArray(rawClients) || !rawClients.length)
    throw new Error("Configure at least one client in ISSUER_CLIENTS_JSON");
  const clients: Client[] = rawClients.map((input) => {
    const client = object(input, "client");
    if (
      typeof client.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,40}$/.test(client.id)
    )
      throw new Error(`Invalid client id: ${client.id}`);
    if (
      typeof client.token !== "string" ||
      !client.token ||
      (!local && client.token.length < 24)
    )
      throw new Error(
        `Client ${client.id} needs a nonempty token (at least 24 characters when shared)`,
      );
    if (
      !Array.isArray(client.scopes) ||
      !client.scopes.length ||
      !client.scopes.every((s) => typeof s === "string")
    )
      throw new Error(`Client ${client.id} needs scopes`);
    return { id: client.id, token: client.token, scopes: client.scopes };
  });

  const publisher = env.ISSUER_PUBLISHER || "none";
  if (!["none", "atproto"].includes(publisher))
    throw new Error('ISSUER_PUBLISHER must be "none" or "atproto"');
  if (
    publisher === "atproto" &&
    !(env.ATPROTO_SERVICE && env.ATPROTO_IDENTIFIER && env.ATPROTO_PASSWORD)
  )
    throw new Error(
      "Publishing to AT Protocol needs ATPROTO_SERVICE, ATPROTO_IDENTIFIER and ATPROTO_PASSWORD",
    );

  return {
    environment,
    local,
    origin,
    issuer: `${origin}/.well-known/attestation-issuer.json`,
    name: env.ISSUER_NAME || "Demo-utsteder (syntetisk)",
    contact: env.ISSUER_CONTACT,
    demo: bool(env.ISSUER_DEMO, true),
    port: Number(env.PORT || 3011),
    host: env.HOST || "127.0.0.1",
    dataDir: env.ISSUER_DATA_DIR || join(root, "data"),
    claimTypesDir: env.ISSUER_CLAIM_TYPES_DIR || join(root, "claim-types"),
    keyId: env.ISSUER_KEY_ID || "key-1",
    privateJwk: env.ISSUER_SIGNING_KEY,
    publisher,
    atproto: {
      service: env.ATPROTO_SERVICE,
      identifier: env.ATPROTO_IDENTIFIER,
      password: env.ATPROTO_PASSWORD,
    },
    clients,
  };
}
