export function testOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Browser tests require an absolute HTTP(S) origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Browser tests require an HTTP(S) origin without credentials, a path, query, or fragment.",
    );
  }
  return url.origin;
}

export async function assertTestEnvironment(baseURL) {
  const origin = testOrigin(baseURL);
  const refusal = `Refusing browser tests against ${origin}: /api/health must report environment "test". Use the disposable test server; never point mutation tests at production.`;
  let response;
  try {
    response = await fetch(`${origin}/api/health`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new Error(`${refusal} The health check could not be reached.`);
  }
  if (!response.ok)
    throw new Error(
      `${refusal} Received HTTP ${response.status}; redirects are not followed.`,
    );
  let health;
  try {
    health = await response.json();
  } catch {
    throw new Error(`${refusal} The health response was not JSON.`);
  }
  if (health?.environment !== "test") throw new Error(refusal);
}
