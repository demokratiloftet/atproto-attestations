// Publication is transport only; trust remains in the verifier and policy.
import { RECORD_TYPE } from "../../verify/record.ts";
import { object } from "../../verify/values.ts";
import type { Publisher } from "../types.ts";
export class PdsError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(`PDS: ${code}`);
  }
}
interface Session {
  did: string;
  accessJwt: string;
}
interface Options {
  service?: string;
  identifier?: string;
  password?: string;
  collection?: string;
  fetchImpl?: typeof fetch;
}
export function createAtprotoPublisher({
  service,
  identifier,
  password,
  collection = RECORD_TYPE,
  fetchImpl = fetch,
}: Options): Publisher {
  if (!service || !identifier || !password)
    throw new Error("The AT Protocol publisher needs service and credentials");
  const origin = new URL(service);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password
  )
    throw new Error("The AT Protocol service must be an HTTP(S) origin");
  let session: Session | undefined;
  const text = (data: Record<string, unknown>, key: string): string => {
    const value = data[key];
    if (typeof value !== "string" || !value)
      throw new Error(`PDS response missing ${key}`);
    return value;
  };
  async function rpc(
    method: string,
    data: Record<string, unknown>,
    token?: string,
    write = false,
  ) {
    const url = new URL(`/xrpc/${method}`, origin);
    if (!write)
      url.search = new URLSearchParams(
        Object.entries(data).map(([key, value]) => [key, String(value)]),
      ).toString();
    const response = await fetchImpl(url, {
      method: write ? "POST" : "GET",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        ...(write && { "content-type": "application/json" }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      ...(write && { body: JSON.stringify(data) }),
    });
    const result = object(
      await response.json().catch(() => ({})),
      "PDS response",
    );
    if (!response.ok)
      throw new PdsError(
        typeof result.error === "string" ? result.error : "Unavailable",
        response.status,
      );
    return result;
  }
  const login = async (): Promise<Session> => {
    const result = await rpc(
      "com.atproto.server.createSession",
      { identifier, password },
      undefined,
      true,
    );
    session = {
      did: text(result, "did"),
      accessJwt: text(result, "accessJwt"),
    };
    return session;
  };
  async function authenticated<T>(
    run: (session: Session) => Promise<T>,
  ): Promise<T> {
    const current = session ?? (await login());
    try {
      return await run(current);
    } catch (error) {
      if (
        !(error instanceof PdsError) ||
        (error.status !== 401 && error.status !== 400)
      )
        throw error;
      return run(await login());
    }
  }
  return {
    id: "atproto",
    async describe() {
      return {
        repo: text(
          await rpc("com.atproto.repo.describeRepo", { repo: identifier }),
          "did",
        ),
        service: origin.href,
      };
    },
    async publish(record) {
      const result = await authenticated((s) =>
        rpc(
          "com.atproto.repo.createRecord",
          { repo: s.did, collection, record, validate: false },
          s.accessJwt,
          true,
        ),
      );
      return { uri: text(result, "uri"), cid: text(result, "cid") };
    },
    async remove(uri) {
      const rkey = uri.split("/").at(-1);
      if (!rkey) return {};
      try {
        return await authenticated((s) =>
          rpc(
            "com.atproto.repo.deleteRecord",
            { repo: s.did, collection, rkey },
            s.accessJwt,
            true,
          ),
        );
      } catch (error) {
        if (error instanceof PdsError && error.code === "RecordNotFound")
          return {};
        throw error;
      }
    },
  };
}
