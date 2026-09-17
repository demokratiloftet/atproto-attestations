// Publication to an AT Protocol repository. This is an adapter on purpose: the
// trust model does not depend on it, and an organisation that must not publish
// publicly uses a different one without changing any verification rule.
import { RECORD_TYPE } from '../../verify/record.mjs';

export class PdsError extends Error {
  constructor(code, status) { super(`PDS: ${code}`); this.code = code; this.status = status; }
}

export function createAtprotoPublisher({ service, identifier, password, collection = RECORD_TYPE, fetchImpl = fetch }) {
  const origin = new URL(service);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('The AT Protocol service must be an HTTP(S) origin');
  let session;

  async function rpc(method, data, token, write = false) {
    const url = new URL(`/xrpc/${method}`, origin);
    if (!write) url.search = new URLSearchParams(data);
    const response = await fetchImpl(url, {
      method: write ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { ...(write && { 'content-type': 'application/json' }), ...(token && { authorization: `Bearer ${token}` }) },
      ...(write && { body: JSON.stringify(data) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new PdsError(result.error || 'Unavailable', response.status);
    return result;
  }
  // Sessions expire; a write retries once with a fresh one rather than failing.
  const login = async () => (session = await rpc('com.atproto.server.createSession', { identifier, password }, null, true));
  async function authenticated(run) {
    if (!session) await login();
    try { return await run(session); }
    catch (error) { if (error.status !== 401 && error.status !== 400) throw error; await login(); return run(session); }
  }

  return {
    id: 'atproto',
    async describe() { return { repo: (await rpc('com.atproto.repo.describeRepo', { repo: identifier })).did, service: origin.href }; },
    async publish(record) {
      const result = await authenticated(s => rpc('com.atproto.repo.createRecord', { repo: s.did, collection, record, validate: false }, s.accessJwt, true));
      return { uri: result.uri, cid: result.cid };
    },
    async remove(uri) {
      const rkey = String(uri || '').split('/').at(-1);
      if (!rkey) return {};
      try { return await authenticated(s => rpc('com.atproto.repo.deleteRecord', { repo: s.did, collection, rkey }, s.accessJwt, true)); }
      catch (error) { if (error.code === 'RecordNotFound') return {}; throw error; }
    },
  };
}
