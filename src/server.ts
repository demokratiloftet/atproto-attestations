import type { IncomingMessage } from "node:http";
import type { Client } from "./types.ts";
import { object, message } from "../verify/values.ts";
import { parsePerson } from "./adapters/person.ts";
// HTTP surface. The issuer trusts a registered client to have authenticated the
// accounts it names: proving control of an AT Protocol account belongs to the
// application, and this service never sees a password or a login session.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { readConfig } from "./config.ts";
import { createService } from "./service.ts";

const config = readConfig();
const { issuer, adapter, store } = await createService(config);
const pages: Record<string, [string, string]> = {
  "/": ["index.html", "text/html"],
  "/console.js": ["console.js", "text/javascript"],
  "/console.css": ["console.css", "text/css"],
};
const attempts = new Map<string, { count: number; until: number }>();

function client(req: IncomingMessage) {
  const presented =
    /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1] || "";
  for (const candidate of config.clients) {
    const a = Buffer.from(presented),
      b = Buffer.from(candidate.token);
    if (a.length === b.length && timingSafeEqual(a, b)) return candidate;
  }
  return undefined;
}

function throttle(req: IncomingMessage) {
  const key = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || record.until < now) {
    attempts.set(key, { count: 1, until: now + 60000 });
    return false;
  }
  record.count += 1;
  if (attempts.size > 5000) attempts.clear();
  return record.count > 120;
}

async function body(req: IncomingMessage, limit = 65536) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > limit)
      throw Object.assign(new Error("Forespørselen er for stor"), {
        status: 413,
      });
  }
  try {
    return object(JSON.parse(text || "{}"), "request");
  } catch {
    throw Object.assign(new Error("Ugyldig JSON"), { status: 400 });
  }
}

// What the caller asserts about who is asking. `did` is accepted only from a
// client that is trusted to have authenticated that account.
const requesterOf = (input: Record<string, unknown>, caller: Client) => ({
  client: caller.id,
  did: typeof input.requesterDid === "string" ? input.requesterDid : undefined,
  attestations: Array.isArray(input.attestations) ? input.attestations : [],
});

const server = http.createServer(async (req, res) => {
  const send = (
    code: number,
    data: unknown,
    type = "application/json; charset=utf-8",
  ) => {
    res.writeHead(code, { "content-type": type });
    res.end(
      type.startsWith("application/json")
        ? JSON.stringify(data)
        : typeof data === "string"
          ? data
          : String(data),
    );
  };
  try {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    const url = new URL(req.url || "/", config.origin);
    const path = url.pathname;

    if (req.method === "GET" && path === "/health")
      return send(200, { ok: true, environment: config.environment });
    if (req.headers.host !== new URL(config.origin).host)
      return send(403, { error: "Unknown host" });
    // API clients need no Origin header; browser calls must match this issuer.
    if (req.headers.origin && req.headers.origin !== config.origin)
      return send(403, { error: "Unexpected origin" });
    // The key document and the trust policy must be fetchable by anyone: an
    // application cannot verify a claim without them.
    if (req.method === "GET" && path === "/.well-known/attestation-issuer.json")
      return send(200, issuer.document());
    if (req.method === "GET" && path === "/trust-policy.json")
      return send(200, issuer.trustPolicy());
    if (req.method === "GET" && path === "/claim-types")
      return send(200, Object.values(issuer.claimTypes()));
    if (req.method === "GET" && path.startsWith("/status/"))
      return send(
        200,
        await issuer.status(decodeURIComponent(path.slice("/status/".length))),
      );
    if (req.method === "GET" && pages[path]) {
      const [file, type] = pages[path];
      return send(
        200,
        await readFile(new URL(`../public/${file}`, import.meta.url), "utf8"),
        `${type}; charset=utf-8`,
      );
    }

    if (throttle(req))
      return send(429, { error: "For mange forespørsler. Vent litt." });
    const caller = client(req);
    if (!caller)
      return send(401, { error: "Mangler eller ugyldig klientnøkkel." });
    const allowed = (scope: string) => {
      if (caller.scopes.includes(scope)) return true;
      send(403, { error: `Klienten mangler tilgangen «${scope}».` });
      return false;
    };

    if (req.method === "GET" && path === "/held") {
      if (!allowed("query")) return;
      const subject = url.searchParams.get("subject");
      if (!subject) return send(400, { error: "Oppgi subject." });
      return send(200, { subject, attestations: issuer.held(subject) });
    }
    if (req.method === "GET" && path === "/audit") {
      if (!allowed("admin")) return;
      return send(200, {
        entries: issuer.audit(Number(url.searchParams.get("limit")) || 50),
      });
    }
    if (req.method === "GET" && path === "/demo/roster") {
      if (!config.demo) return send(404, { error: "Not found" });
      if (!allowed("admin")) return;
      return send(200, { demo: true, people: adapter.roster() });
    }

    if (req.method !== "POST") return send(404, { error: "Not found" });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return send(415, { error: "Send JSON." });
    const input = await body(req);
    const field = (name: string, optional = false): string => {
      const value = input[name];
      if (optional && value === undefined) return "";
      if (typeof value !== "string")
        throw Object.assign(new Error(`Oppgi ${name} som tekst.`), {
          status: 400,
        });
      return value;
    };
    const fields = (name: string): Record<string, unknown> => {
      try {
        return object(input[name] ?? {}, name);
      } catch (error) {
        throw Object.assign(new Error(message(error)), { status: 400 });
      }
    };
    const evidence = (name: string): unknown[] | undefined => {
      const value = input[name];
      if (value === undefined) return undefined;
      if (!Array.isArray(value))
        throw Object.assign(new Error(`Oppgi ${name} som en liste.`), {
          status: 400,
        });
      return value;
    };
    evidence("attestations");

    if (path === "/issue") {
      if (!allowed("issue")) return;
      const result = await issuer.issue({
        claimType: field("claimType"),
        subject: field("subject"),
        request: fields("request"),
        requester: requesterOf(input, caller),
        subjectAttestations: evidence("subjectAttestations"),
      });
      return send(201, result);
    }
    if (path === "/revoke") {
      if (!allowed("revoke")) return;
      return send(
        200,
        await issuer.revoke({
          id: field("id", true) || undefined,
          claimType: field("claimType", true) || undefined,
          subject: field("subject", true) || undefined,
          requester: requesterOf(input, caller),
        }),
      );
    }
    if (path === "/query") {
      if (!allowed("query")) return;
      return send(
        200,
        await issuer.query({
          claimType: field("claimType"),
          subject: field("subject"),
          request: fields("request"),
          requester: requesterOf(input, caller),
        }),
      );
    }
    // Synthetic data only. A real deployment has no endpoint that invents facts.
    if (path === "/demo/enrol") {
      if (!config.demo) return send(404, { error: "Not found" });
      if (!allowed("admin")) return;
      if (
        typeof input.subject !== "string" ||
        !input.subject.startsWith("did:")
      )
        return send(400, { error: "Oppgi en konto (DID)." });
      let facts;
      try {
        facts = parsePerson(fields("facts"));
      } catch (error) {
        return send(400, { error: message(error) });
      }
      return send(200, {
        demo: true,
        person: adapter.enrol(input.subject, facts),
      });
    }
    return send(404, { error: "Not found" });
  } catch (error) {
    const status =
      error instanceof Error &&
      "status" in error &&
      typeof error.status === "number" &&
      error.status >= 400 &&
      error.status < 600
        ? error.status
        : 500;
    if (status >= 500)
      console.error(
        "Issuer request failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    send(status, {
      error:
        status >= 500
          ? "Utstederen kunne ikke behandle forespørselen."
          : message(error),
    });
  }
});

server.listen(config.port, config.host, () =>
  console.log(
    `Attestation issuer: ${config.origin} (${config.environment}, publisher: ${config.publisher})`,
  ),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
