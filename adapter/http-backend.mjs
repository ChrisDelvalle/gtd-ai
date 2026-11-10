// Credentials are forwarded only to the fixed private Rust origin. No redirects,
// user-selected URLs, retry loops, cookies, shared tokens or account cache.
export class BackendFailure extends Error {
  constructor(status, body) { super('Backend request failed'); this.status=status; this.body=body; }
}

export async function boundedJson(response, maximum = 16 * 1024 * 1024) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body ?? []) {
    bytes += chunk.length;
    if (bytes > maximum) throw Error('Backend response exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function privateBackend(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || !url.port) throw Error('Backend must be an explicit loopback HTTP origin');
  return async (path, {authorization, requestId, arguments: args, pins = {}, resource, widgetLaunch, signal} = {}) => {
    if (!/^\/internal\/(contract|profile|mcp\/[a-z_]+)$/.test(path)) throw Error('Invalid backend operation');
    const headers = {'Accept':'application/json'};
    if (authorization) headers.Authorization = authorization;
    if (requestId) headers['X-Request-ID'] = requestId;
    if (pins.account !== undefined) headers['X-GTD-Expected-Account'] = pins.account;
    if (pins.environment !== undefined) headers['X-GTD-Expected-Environment'] = pins.environment;
    if (resource) headers['X-GTD-MCP-Resource'] = resource;
    if (widgetLaunch) headers['X-GTD-Widget-Launch'] = widgetLaunch;
    if (args !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(new URL(path,url),{method:args===undefined?'GET':'POST',headers,
      body:args===undefined?undefined:JSON.stringify(args), redirect:'error',
      signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(16_000)]) : AbortSignal.timeout(16_000)});
    const body = await boundedJson(response, path.endsWith('/contract') ? 4*1024*1024 : undefined);
    if (!response.ok) throw new BackendFailure(response.status, body);
    return body;
  };
}
