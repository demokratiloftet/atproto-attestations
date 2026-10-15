import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { AuthStore, hash, random } from "@loftet/auth";

import { object } from "../../verify/values.ts";
import { readPilotConfig } from "./config.ts";
import { descriptors } from "./descriptors.ts";
import { refuse, text } from "./domain.ts";
import { PilotRepository } from "./repository.ts";
import { PilotService } from "./service.ts";
import type { PilotConfig } from "./types.ts";

type Input = Record<string, unknown>;
interface Context {
  actor: string | undefined;
  request: IncomingMessage;
  response: ServerResponse;
  sessionKey: string | undefined;
  url: URL;
}
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/assets/pilot.css", ["pilot.css", "text/css"]],
  ["/assets/pilot.js", ["app.js", "text/javascript"]],
]);
function send(response: ServerResponse, status: number, data: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(data));
}
function sendError(response: ServerResponse, error: unknown) {
  const status =
    error instanceof Error &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : 500;
  let message = "Ugyldig forespørsel.";
  if (error instanceof Error) {
    ({ message } = error);
  }
  if (status >= 500) {
    console.error(
      "Pilot operation failed",
      error instanceof Error ? error.name : "UnknownError"
    );
    message = "Tjenesten kunne ikke fullføre. Prøv igjen.";
  }
  if (response.headersSent) {
    response.destroy();
    return;
  }
  send(response, status, { error: message });
}
function securityHeaders(response: ServerResponse) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  );
}
async function readInput(request: IncomingMessage): Promise<Input> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of request) {
    const chunk: unknown = value;
    if (!Buffer.isBuffer(chunk)) {
      refuse("Ugyldig innhold.");
    }
    size += chunk.length;
    if (size > 8192) {
      refuse("Forespørselen er for stor.", 413);
    }
    chunks.push(chunk);
  }
  try {
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    return object(input, "request");
  } catch {
    return refuse("Ugyldig JSON.");
  }
}
function mutationRoutes(service: PilotService) {
  return new Map<
    string,
    (actor: string, input: Input) => Promise<{ id: string }>
  >([
    [
      "/api/proposals",
      (actor, input) => service.propose(actor, object(input.terms, "terms")),
    ],
    [
      "/api/proposals/approve",
      (actor, input) =>
        service.approve(actor, text(input, "id"), input.revision),
    ],
    [
      "/api/proposals/change",
      (actor, input) =>
        service.change(
          actor,
          text(input, "id"),
          input.revision,
          object(input.terms, "terms")
        ),
    ],
    [
      "/api/proposals/decline",
      (actor, input) =>
        service.end(actor, text(input, "id"), input.revision, "declined"),
    ],
    [
      "/api/proposals/revoke",
      (actor, input) =>
        service.end(actor, text(input, "id"), input.revision, "revoked"),
    ],
    [
      "/api/proposals/retry",
      (actor, input) => service.retry(actor, text(input, "id")),
    ],
    [
      "/api/grants",
      (actor, input) =>
        service.grant(actor, text(input, "id"), input.revision, input),
    ],
    [
      "/api/grants/revoke",
      (actor, input) => service.revokeGrant(actor, text(input, "id")),
    ],
    ["/api/events", (actor, input) => service.publishEvent(actor, input)],
  ]);
}
async function publicCredential(service: PilotService, id: string) {
  return service.exclusive(async () => {
    const proposal = service.getProposal(id);
    if (proposal.terms.visibility !== "public" || proposal.state !== "active") {
      refuse("Bekreftelsen er ikke offentlig tilgjengelig.", 404);
    }
    return {
      acceptance: proposal.acceptanceRef,
      affiliation: proposal.ref,
      demo: true,
      record: proposal.record,
      verification: await service.verify(proposal),
    };
  });
}
async function serveGet(
  context: Context,
  config: PilotConfig,
  service: PilotService
) {
  const { actor, response, url } = context;
  const asset = assets.get(url.pathname);
  if (asset) {
    const [file, contentType] = asset;
    const data = await readFile(
      new URL(`../../public/pilot/${file}`, import.meta.url)
    );
    response.writeHead(200, { "content-type": contentType });
    response.end(data);
    return;
  }
  let data: unknown;
  switch (url.pathname) {
    case "/api/state": {
      data = await service.exclusive(() => service.view(actor));
      break;
    }
    case "/api/demo": {
      data = {
        accounts: config.people.map(({ handle, name }) => ({ handle, name })),
        demo: true,
        notice:
          "Isolert demonstrasjon. Alle personer og tilknytninger er syntetiske.",
      };
      break;
    }
    case "/api/trust": {
      data = {
        claimTypes: descriptors,
        demo: true,
        notice:
          "Trust configuration must be explicitly approved by the consuming application.",
        trustPolicy: service.trust,
      };
      break;
    }
    case "/api/credential": {
      data = await publicCredential(service, url.searchParams.get("id") ?? "");
      break;
    }
    default: {
      if (!/^\/status\/[a-zA-Z0-9-]+$/u.test(url.pathname)) {
        refuse("Ikke funnet.", 404);
      }
      const id = url.pathname.slice("/status/".length);
      data = await service.exclusive(() => service.status(id));
    }
  }
  send(response, 200, data);
}
class WriteRateLimiter {
  private readonly rates = new Map<string, { count: number; until: number }>();
  check(context: Context) {
    const now = Date.now();
    for (const [key, rate] of this.rates) {
      if (rate.until <= now) {
        this.rates.delete(key);
      }
    }
    const login = context.url.pathname === "/api/login";
    const peer = context.request.socket.remoteAddress ?? "unknown";
    const key = login ? `${peer}:login` : `${context.actor ?? peer}:write`;
    const rate = this.rates.get(key) ?? { count: 0, until: now + 60_000 };
    rate.count += 1;
    if (rate.count > (login ? 20 : 90) || this.rates.size > 5000) {
      refuse("For mange forsøk. Vent et minutt.", 429);
    }
    this.rates.set(key, rate);
  }
}
export function createPilotServer(
  config: PilotConfig,
  service: PilotService,
  auth: AuthStore
) {
  const secure = new URL(config.origin).protocol === "https:";
  const cookieName = secure
    ? "__Host-affiliation-session"
    : "affiliation-session";
  const cookieHeader = (value: string, maxAge: number) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const rates = new WriteRateLimiter();
  const mutations = mutationRoutes(service);
  async function authenticate(context: Context, input: Input) {
    let cookieValue = "";
    let maxAge = 0;
    if (context.url.pathname === "/api/login") {
      const handle = text(input, "handle", 200);
      if (!config.people.some((person) => person.handle === handle)) {
        refuse("Ugyldig demokonto eller passord.", 401);
      }
      const logged = await service.exclusive(() =>
        service.repo.login(handle, text(input, "password", 1000))
      );
      cookieValue = random();
      maxAge = 8 * 3600;
      auth.set(
        "pilot-browser",
        hash(cookieValue),
        { did: logged.did },
        maxAge * 1000
      );
    }
    if (context.sessionKey) {
      auth.del("pilot-browser", hash(context.sessionKey));
    }
    context.response.setHeader("Set-Cookie", cookieHeader(cookieValue, maxAge));
    send(context.response, 200, { ok: true });
  }
  async function servePost(context: Context) {
    const { actor, request, response, url } = context;
    if (
      request.headers.origin !== config.origin ||
      !/^application\/json(?:;|$)/u.test(request.headers["content-type"] ?? "")
    ) {
      refuse("Forespørselen må komme fra denne siden.", 403);
    }
    rates.check(context);
    const input = await readInput(request);
    if (["/api/login", "/api/logout"].includes(url.pathname)) {
      await authenticate(context, input);
      return;
    }
    if (!actor) {
      refuse("Logg inn for å fortsette.", 401);
    }
    const action = mutations.get(url.pathname);
    if (!action) {
      refuse("Ikke funnet.", 404);
    }
    const result = await service.exclusive(async () => {
      try {
        return await action(actor, input);
      } catch (error) {
        service.store.audit(
          actor,
          "request-denied",
          undefined,
          undefined,
          url.pathname
        );
        throw error;
      }
    });
    send(response, 200, { id: result.id, ok: true });
  }
  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse
  ) {
    securityHeaders(response);
    if (request.url === "/health" && request.method === "GET") {
      send(response, 200, { ok: true, service: "affiliation-pilot" });
      return;
    }
    const origin = new URL(config.origin);
    if (request.headers.host !== origin.host) {
      refuse("Ugyldig vert.", 403);
    }
    if (
      !request.url ||
      request.url.length > 4096 ||
      /[\\\s]/u.test(request.url)
    ) {
      refuse("Ugyldig adresse.");
    }
    const sessionKey = request.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const session = sessionKey
      ? auth.get<{ did: string }>("pilot-browser", hash(sessionKey))
      : undefined;
    const context = {
      actor: session?.did,
      request,
      response,
      sessionKey,
      url: new URL(request.url, origin),
    };
    if (request.method === "GET") {
      await serveGet(context, config, service);
      return;
    }
    if (request.method === "POST") {
      await servePost(context);
      return;
    }
    refuse("Ikke funnet.", 404);
  }
  return http.createServer((request, response) => {
    handleRequest(request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  });
}

if (process.argv[1] === import.meta.filename) {
  const config = readPilotConfig();
  const auth = new AuthStore(
    join(config.dataDir, "auth"),
    process.env.AUTH_ENCRYPTION_KEY_FILE
      ? readFileSync(process.env.AUTH_ENCRYPTION_KEY_FILE, "utf-8").trim()
      : process.env.AUTH_ENCRYPTION_KEY
  );
  const repo = new PilotRepository(config, auth);
  const service = new PilotService(config, repo);
  await service.init();
  const server = createPilotServer(config, service, auth);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(
    Number(process.env.PORT ?? 3013),
    process.env.HOST ?? "127.0.0.1",
    () => console.log("Affiliation pilot ready")
  );
  const worker = setInterval(() => {
    service
      .exclusive(() => service.tick())
      .catch(() => {
        console.error("Pilot reconciliation failed");
      });
  }, 30_000);
  worker.unref();
  const stop = () => {
    clearInterval(worker);
    server.close(() => {
      service.close();
      auth.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
