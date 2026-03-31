import { actions, Frames, Sync } from "@engine";
import {
  Authenticating,
  CredentialVault,
  Requesting,
  Sessioning,
} from "@concepts";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_STATE_TTL_MS = 10 * 60 * 1000;

interface GitHubStatePayload {
  user: string;
  frontendOrigin: string;
  returnPath: string;
  expiresAt: string;
  nonce: string;
}

interface GitHubAuthExchange {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
}

interface GitHubUserProfile {
  login: string;
  externalAccountId: string;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProtectedGitHubRoute(path: string, method: string): boolean {
  return (
    (path === "/me/github" && (method === "GET" || method === "DELETE")) ||
    (path === "/me/github/link/start" && method === "POST") ||
    (path === "/me/github/link/complete" && method === "POST")
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padding = normalized.length % 4 === 0
      ? ""
      : "=".repeat(4 - (normalized.length % 4));
    const binary = atob(normalized + padding);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function buildHtmlResponse(payload: Record<string, unknown>, targetOrigin: string): string {
  const serializedPayload = JSON.stringify(payload);
  const serializedOrigin = JSON.stringify(targetOrigin || "*");
  const message = payload.ok === true
    ? "GitHub link completed. You can close this window."
    : `GitHub link failed: ${String(payload.error ?? "Unknown error")}`;
  const escapedMessage = JSON.stringify(message);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>GitHub Link</title>
  </head>
  <body>
    <script>
      const payload = ${serializedPayload};
      const targetOrigin = ${serializedOrigin};
      if (window.opener && typeof window.opener.postMessage === "function") {
        window.opener.postMessage(payload, targetOrigin);
      }
      document.body.innerText = ${escapedMessage};
      window.close();
    </script>
  </body>
</html>`;
}

function htmlToStream(html: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(html);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

function textStream(value: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function importStateKey(secret: string): Promise<CryptoKey> {
  const rawKey = new TextEncoder().encode(secret).slice().buffer as ArrayBuffer;
  return await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function signStateToken(
  payload: GitHubStatePayload,
  secret: string,
): Promise<string> {
  const body = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importStateKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body).slice().buffer as ArrayBuffer,
  );
  return `${body}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function verifyStateToken(
  token: string,
  secret: string,
): Promise<GitHubStatePayload | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const signatureBytes = decodeBase64Url(signature);
  if (!signatureBytes) return null;
  const key = await importStateKey(secret);
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes.slice().buffer as ArrayBuffer,
    new TextEncoder().encode(body).slice().buffer as ArrayBuffer,
  );
  if (!verified) return null;
  const payloadBytes = decodeBase64Url(body);
  if (!payloadBytes) return null;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(payloadBytes),
    ) as GitHubStatePayload;
    const expiresAt = new Date(payload.expiresAt);
    if (!payload.user || !payload.frontendOrigin || !payload.returnPath) {
      return null;
    }
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function extractGitHubErrorMessage(payloadText: string): string {
  const trimmed = payloadText.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message = normalizeString(parsed.error_description) ||
      normalizeString(parsed.message) ||
      normalizeString(parsed.error);
    if (message) return message;
  } catch {
    // Fall back to raw text.
  }
  return trimmed.slice(0, 500);
}

async function githubJsonRequest(
  url: string,
  init: RequestInit,
  accessToken?: string,
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  headers.set("Accept", "application/json");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
  }
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    headers.set("Accept", "application/vnd.github+json");
  }
  return await fetch(url, {
    ...init,
    headers,
  });
}

async function exchangeGitHubCode(
  code: string,
): Promise<GitHubAuthExchange | { error: string }> {
  const clientId = normalizeString(Deno.env.get("GITHUB_APP_CLIENT_ID"));
  const clientSecret = normalizeString(Deno.env.get("GITHUB_APP_CLIENT_SECRET"));
  const callbackUrl = normalizeString(Deno.env.get("GITHUB_APP_CALLBACK_URL"));
  if (!clientId || !clientSecret || !callbackUrl) {
    return { error: "GitHub OAuth is not fully configured on the server." };
  }

  const response = await githubJsonRequest(
    GITHUB_TOKEN_URL,
    {
      method: "POST",
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: callbackUrl,
      }).toString(),
    },
  );
  const payloadText = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadText) as Record<string, unknown>;
  } catch {
    return {
      error: extractGitHubErrorMessage(payloadText) ||
        "GitHub token exchange returned an invalid response.",
    };
  }
  if (!response.ok) {
    return {
      error: extractGitHubErrorMessage(payloadText) ||
        "GitHub token exchange failed.",
    };
  }

  const accessToken = normalizeString(payload.access_token);
  if (!accessToken) {
    return { error: "GitHub token exchange did not return an access token." };
  }

  const expiresIn = typeof payload.expires_in === "number"
    ? payload.expires_in
    : 0;
  const refreshExpiresIn = typeof payload.refresh_token_expires_in === "number"
    ? payload.refresh_token_expires_in
    : 0;

  return {
    accessToken,
    refreshToken: normalizeString(payload.refresh_token),
    tokenType: normalizeString(payload.token_type) || "bearer",
    accessTokenExpiresAt: expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000).toISOString()
      : "",
    refreshTokenExpiresAt: refreshExpiresIn > 0
      ? new Date(Date.now() + refreshExpiresIn * 1000).toISOString()
      : "",
  };
}

async function fetchGitHubProfile(
  accessToken: string,
): Promise<GitHubUserProfile | { error: string }> {
  const response = await githubJsonRequest(
    `${GITHUB_API_BASE}/user`,
    { method: "GET" },
    accessToken,
  );
  const payloadText = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadText) as Record<string, unknown>;
  } catch {
    return { error: "GitHub user lookup returned an invalid response." };
  }
  if (!response.ok) {
    return {
      error: extractGitHubErrorMessage(payloadText) || "Failed to fetch GitHub user.",
    };
  }
  const login = normalizeString(payload.login);
  const externalAccountId = String(payload.id ?? "").trim();
  if (!login || !externalAccountId) {
    return { error: "GitHub user lookup did not return account metadata." };
  }
  return { login, externalAccountId };
}

async function fetchGitHubInstallation(
  accessToken: string,
  login: string,
): Promise<{
  installationId: string;
  permissions: Record<string, unknown>;
}> {
  const response = await githubJsonRequest(
    `${GITHUB_API_BASE}/user/installations`,
    { method: "GET" },
    accessToken,
  );
  if (!response.ok) {
    return { installationId: "", permissions: {} };
  }

  try {
    const payload = await response.json() as Record<string, unknown>;
    if (!Array.isArray(payload.installations)) {
      return { installationId: "", permissions: {} };
    }
    const match = payload.installations.find((candidate) => {
      if (!candidate || typeof candidate !== "object") return false;
      const account = "account" in candidate &&
          candidate.account &&
          typeof candidate.account === "object"
        ? candidate.account as Record<string, unknown>
        : null;
      return normalizeString(account?.login) === login &&
        normalizeString(account?.type) === "User";
    }) as Record<string, unknown> | undefined;
    if (!match) {
      return { installationId: "", permissions: {} };
    }
    return {
      installationId: String(match.id ?? "").trim(),
      permissions: isObject(match.permissions) ? match.permissions : {},
    };
  } catch {
    return { installationId: "", permissions: {} };
  }
}

export const GitHubLinkMissingAuth: Sync = (
  { request, path, method, input },
) => ({
  when: actions([Requesting.request, { path, method }, { request }]),
  where: async (frames) => {
    frames = frames.filter((f) =>
      isProtectedGitHubRoute(
        String(f[path] ?? ""),
        String(f[method] ?? "").toUpperCase(),
      )
    );
    frames = await frames.query(Requesting._getInput, { request }, { input });
    return frames.filter((f) => !(f[input] as any)?.accessToken);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});

export const GitHubLinkInvalidAuth: Sync = (
  { request, path, method, accessToken, error },
) => ({
  when: actions([
    Requesting.request,
    { path, method, accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter((f) =>
      isProtectedGitHubRoute(
        String(f[path] ?? ""),
        String(f[method] ?? "").toUpperCase(),
      )
    );
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      error,
    });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});

export const GetGitHubStatusRequest: Sync = (
  {
    request,
    accessToken,
    user,
    hasGithubCredential,
    kdfSalt,
    kdfParams,
    encryptionVersion,
    githubLogin,
    externalAccountId,
    githubInstallationId,
    githubPermissions,
    githubTokenType,
    githubAccessTokenExpiresAt,
    githubRefreshTokenExpiresAt,
  },
) => ({
  when: actions([
    Requesting.request,
    { path: "/me/github", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      CredentialVault._getStatus,
      { user, provider: "github" },
      {
        hasGithubCredential,
        kdfSalt,
        kdfParams,
        encryptionVersion,
        githubLogin,
        externalAccountId,
        githubInstallationId,
        githubPermissions,
        githubTokenType,
        githubAccessTokenExpiresAt,
        githubRefreshTokenExpiresAt,
      },
    );
    return frames.filter((f) => f[hasGithubCredential] === true);
  },
  then: actions([
    Requesting.respond,
    {
      request,
      hasGithubCredential,
      kdfSalt,
      kdfParams,
      encryptionVersion,
      githubLogin,
      externalAccountId,
      githubInstallationId,
      githubPermissions,
      githubTokenType,
      githubAccessTokenExpiresAt,
      githubRefreshTokenExpiresAt,
    },
  ]),
});

export const GetGitHubStatusEmptyResponse: Sync = (
  { request, accessToken, user, hasGithubCredential },
) => ({
  when: actions([
    Requesting.request,
    { path: "/me/github", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      CredentialVault._getStatus,
      { user, provider: "github" },
      { hasGithubCredential },
    );
    return frames.filter((f) => f[hasGithubCredential] === false);
  },
  then: actions([
    Requesting.respond,
    { request, hasGithubCredential },
  ]),
});

export const StartGitHubLinkValidationError: Sync = (
  { request, frontendOrigin },
) => ({
  when: actions([
    Requesting.request,
    { path: "/me/github/link/start", method: "POST", frontendOrigin },
    { request },
  ]),
  where: (frames) =>
    frames.filter((f) => !normalizeString(f[frontendOrigin])),
  then: actions([
    Requesting.respond,
    {
      request,
      statusCode: 400,
      error: "Missing required field: frontendOrigin.",
    },
  ]),
});

export const StartGitHubLinkConfigError: Sync = (
  { request, accessToken, user },
) => ({
  when: actions([
    Requesting.request,
    {
      path: "/me/github/link/start",
      method: "POST",
      accessToken,
    },
    { request },
  ]),
  where: async (frames) => {
    const clientId = normalizeString(Deno.env.get("GITHUB_APP_CLIENT_ID"));
    const callbackUrl = normalizeString(Deno.env.get("GITHUB_APP_CALLBACK_URL"));
    const stateSecret = normalizeString(
      Deno.env.get("CREDENTIAL_VAULT_ENCRYPTION_KEY"),
    );
    if (clientId && callbackUrl && stateSecret) return new Frames();
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    return frames.filter((f) => f[user] !== undefined);
  },
  then: actions([
    Requesting.respond,
    {
      request,
      statusCode: 503,
      error: "GitHub OAuth is not fully configured on the server.",
    },
  ]),
});

export const StartGitHubLinkRequest: Sync = (
  {
    request,
    accessToken,
    frontendOrigin,
    returnPath,
    input,
    user,
    authorizationUrl,
    stateExpiresAt,
    statusCode,
  },
) => ({
  when: actions([
    Requesting.request,
    {
      path: "/me/github/link/start",
      method: "POST",
      accessToken,
      frontendOrigin,
    },
    { request },
  ]),
  where: async (frames) => {
    const clientId = normalizeString(Deno.env.get("GITHUB_APP_CLIENT_ID"));
    const callbackUrl = normalizeString(Deno.env.get("GITHUB_APP_CALLBACK_URL"));
    const stateSecret = normalizeString(
      Deno.env.get("CREDENTIAL_VAULT_ENCRYPTION_KEY"),
    );
    if (!clientId || !callbackUrl || !stateSecret) return new Frames();

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(Requesting._getInput, { request }, { input });

    const nextFrames = new Frames();
    for (const frame of frames) {
      const requestInput = isObject(frame[input]) ? frame[input] : {};
      const statePayload: GitHubStatePayload = {
        user: String(frame[user]),
        frontendOrigin: normalizeString(frame[frontendOrigin]),
        returnPath: normalizeString(requestInput.returnPath) || "/settings",
        expiresAt: new Date(Date.now() + GITHUB_STATE_TTL_MS).toISOString(),
        nonce: crypto.randomUUID(),
      };
      const stateToken = await signStateToken(statePayload, stateSecret);
      const url = new URL(GITHUB_AUTHORIZE_URL);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", callbackUrl);
      url.searchParams.set("state", stateToken);
      nextFrames.push({
        ...frame,
        [authorizationUrl]: url.toString(),
        [stateExpiresAt]: statePayload.expiresAt,
        [statusCode]: 200,
      });
    }
    return nextFrames;
  },
  then: actions([
    Requesting.respond,
    { request, statusCode, authorizationUrl, stateExpiresAt },
  ]),
});

export const GitHubCallbackRequest: Sync = (
  { request, code, state, callbackStream, callbackStatusCode },
) => ({
  when: actions([
    Requesting.request,
    { path: "/auth/github/callback", method: "GET", code, state },
    { request },
  ]),
  where: async (frames) => {
    const stateSecret = normalizeString(
      Deno.env.get("CREDENTIAL_VAULT_ENCRYPTION_KEY"),
    );
    const nextFrames = new Frames();

    for (const frame of frames) {
      const codeValue = normalizeString(frame[code]);
      const stateValue = normalizeString(frame[state]);
      if (!stateSecret || !codeValue || !stateValue) {
        const html = buildHtmlResponse({
          type: "conceptualai:github-link-callback",
          ok: false,
          error: "Missing GitHub callback parameters.",
        }, "*");
        nextFrames.push({
          ...frame,
          [callbackStream]: htmlToStream(html),
          [callbackStatusCode]: 400,
        });
        continue;
      }

      const verifiedState = await verifyStateToken(stateValue, stateSecret);
      if (!verifiedState) {
        const html = buildHtmlResponse({
          type: "conceptualai:github-link-callback",
          ok: false,
          error: "GitHub callback state mismatch or expiration.",
        }, "*");
        nextFrames.push({
          ...frame,
          [callbackStream]: htmlToStream(html),
          [callbackStatusCode]: 400,
        });
        continue;
      }

      const tokenExchange = await exchangeGitHubCode(codeValue);
      if ("error" in tokenExchange) {
        const html = buildHtmlResponse({
          type: "conceptualai:github-link-callback",
          ok: false,
          error: tokenExchange.error,
        }, verifiedState.frontendOrigin);
        nextFrames.push({
          ...frame,
          [callbackStream]: htmlToStream(html),
          [callbackStatusCode]: 502,
        });
        continue;
      }

      const profile = await fetchGitHubProfile(tokenExchange.accessToken);
      if ("error" in profile) {
        const html = buildHtmlResponse({
          type: "conceptualai:github-link-callback",
          ok: false,
          error: profile.error,
        }, verifiedState.frontendOrigin);
        nextFrames.push({
          ...frame,
          [callbackStream]: htmlToStream(html),
          [callbackStatusCode]: 502,
        });
        continue;
      }

      const linkedRows = await CredentialVault._getLinkedUser({
        provider: "github",
        externalAccountId: profile.externalAccountId,
      });
      const linkedUser = linkedRows[0]?.user;
      if (linkedUser && String(linkedUser) !== verifiedState.user) {
        const html = buildHtmlResponse({
          type: "conceptualai:github-link-callback",
          ok: false,
          error:
            "This GitHub account is already linked to another ConceptualAI account.",
        }, verifiedState.frontendOrigin);
        nextFrames.push({
          ...frame,
          [callbackStream]: htmlToStream(html),
          [callbackStatusCode]: 409,
        });
        continue;
      }

      const installation = await fetchGitHubInstallation(
        tokenExchange.accessToken,
        profile.login,
      );
      const html = buildHtmlResponse({
        type: "conceptualai:github-link-callback",
        ok: true,
        returnPath: verifiedState.returnPath,
        githubCredential: {
          accessToken: tokenExchange.accessToken,
          refreshToken: tokenExchange.refreshToken,
          tokenType: tokenExchange.tokenType,
          accessTokenExpiresAt: tokenExchange.accessTokenExpiresAt,
          refreshTokenExpiresAt: tokenExchange.refreshTokenExpiresAt,
          githubLogin: profile.login,
          externalAccountId: profile.externalAccountId,
          installationId: installation.installationId,
          permissions: installation.permissions,
        },
      }, verifiedState.frontendOrigin);
      nextFrames.push({
        ...frame,
        [callbackStream]: htmlToStream(html),
        [callbackStatusCode]: 200,
      });
    }

    return nextFrames;
  },
  then: actions([
    Requesting.respond,
    {
      request,
      statusCode: callbackStatusCode,
      stream: callbackStream,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  ]),
});

export const GitHubLinkCompleteValidationError: Sync = (
  {
    request,
    accountPassword,
    ciphertext,
    iv,
    kdfSalt,
    kdfParams,
    encryptionVersion,
    externalAccountId,
    githubLogin,
  },
) => ({
  when: actions([
    Requesting.request,
    {
      path: "/me/github/link/complete",
      method: "POST",
      accountPassword,
      ciphertext,
      iv,
      kdfSalt,
      kdfParams,
      encryptionVersion,
      externalAccountId,
      githubLogin,
    },
    { request },
  ]),
  where: (frames) =>
    frames.filter((f) =>
      !normalizeString(f[accountPassword]) ||
      !normalizeString(f[ciphertext]) ||
      !normalizeString(f[iv]) ||
      !normalizeString(f[kdfSalt]) ||
      !isObject(f[kdfParams]) ||
      !normalizeString(f[encryptionVersion]) ||
      !normalizeString(f[externalAccountId]) ||
      !normalizeString(f[githubLogin])
    ),
  then: actions([
    Requesting.respond,
    {
      request,
      statusCode: 400,
      error:
        "Missing required GitHub credential fields: accountPassword, ciphertext, iv, kdfSalt, kdfParams, encryptionVersion, externalAccountId, and githubLogin.",
    },
  ]),
});

export const GitHubLinkCompletePasswordError: Sync = (
  { request, accessToken, accountPassword, user, passwordOk, error },
) => ({
  when: actions([
    Requesting.request,
    {
      path: "/me/github/link/complete",
      method: "POST",
      accessToken,
      accountPassword,
    },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      Authenticating._verifyPasswordByUser,
      { user, password: accountPassword },
      { ok: passwordOk, error },
    );
    return frames.filter((f) => f[error] !== undefined && f[passwordOk] === undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Invalid email or password" },
  ]),
});

export const GitHubLinkCompleteRequest: Sync = (
  {
    request,
    accessToken,
    accountPassword,
    user,
    passwordOk,
    error,
    ciphertext,
    iv,
    kdfSalt,
    kdfParams,
    encryptionVersion,
    externalAccountId,
    githubLogin,
    installationId,
    permissions,
    tokenType,
    accessTokenExpiresAt,
    refreshTokenExpiresAt,
    input,
    redactedMetadata,
  },
) => ({
  when: actions([
    Requesting.request,
    {
      path: "/me/github/link/complete",
      method: "POST",
      accessToken,
      accountPassword,
      ciphertext,
      iv,
      kdfSalt,
      kdfParams,
      encryptionVersion,
      externalAccountId,
      githubLogin,
    },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      Authenticating._verifyPasswordByUser,
      { user, password: accountPassword },
      { ok: passwordOk, error },
    );
    frames = frames.filter((f) => f[passwordOk] === true);
    frames = await frames.query(Requesting._getInput, { request }, { input });
    return new Frames(...frames.map((f) => {
      const requestInput = isObject(f[input]) ? f[input] : {};
      return {
        ...f,
        [installationId]: normalizeString(requestInput.installationId),
        [permissions]: isObject(requestInput.permissions) ? requestInput.permissions : {},
        [tokenType]: normalizeString(requestInput.tokenType),
        [accessTokenExpiresAt]: normalizeString(requestInput.accessTokenExpiresAt),
        [refreshTokenExpiresAt]: normalizeString(requestInput.refreshTokenExpiresAt),
        [redactedMetadata]: {
          login: f[githubLogin],
          installationId: normalizeString(requestInput.installationId),
          permissions: isObject(requestInput.permissions) ? requestInput.permissions : {},
          tokenType: normalizeString(requestInput.tokenType),
          accessTokenExpiresAt: normalizeString(requestInput.accessTokenExpiresAt),
          refreshTokenExpiresAt: normalizeString(requestInput.refreshTokenExpiresAt),
        },
      };
    }));
  },
  then: actions([
    CredentialVault.storeCredential,
    {
      request,
      user,
      provider: "github",
      ciphertext,
      iv,
      redactedMetadata,
      externalAccountId,
      kdfSalt,
      kdfParams,
      encryptionVersion,
    },
  ]),
});

export const GitHubLinkCompleteStoreError: Sync = (
  { request, error },
) => ({
  when: actions(
    [Requesting.request, {
      path: "/me/github/link/complete",
      method: "POST",
    }, {
      request,
    }],
    [CredentialVault.storeCredential, { request }, { error }],
  ),
  then: actions([
    Requesting.respond,
    {
      request,
      statusCode: 409,
      error,
    },
  ]),
});

export const GitHubLinkCompleteResponse: Sync = (
  {
    request,
    accessToken,
    user,
    hasGithubCredential,
    kdfSalt,
    kdfParams,
    encryptionVersion,
    githubLogin,
    externalAccountId,
    githubInstallationId,
    githubPermissions,
    githubTokenType,
    githubAccessTokenExpiresAt,
    githubRefreshTokenExpiresAt,
  },
) => ({
  when: actions(
    [Requesting.request, {
      path: "/me/github/link/complete",
      method: "POST",
      accessToken,
    }, { request }],
    [CredentialVault.storeCredential, { request }, { ok: true }],
  ),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    return await frames.query(
      CredentialVault._getStatus,
      { user, provider: "github" },
      {
        hasGithubCredential,
        kdfSalt,
        kdfParams,
        encryptionVersion,
        githubLogin,
        externalAccountId,
        githubInstallationId,
        githubPermissions,
        githubTokenType,
        githubAccessTokenExpiresAt,
        githubRefreshTokenExpiresAt,
      },
    );
  },
  then: actions([
    Requesting.respond,
    {
      request,
      hasGithubCredential,
      kdfSalt,
      kdfParams,
      encryptionVersion,
      githubLogin,
      externalAccountId,
      githubInstallationId,
      githubPermissions,
      githubTokenType,
      githubAccessTokenExpiresAt,
      githubRefreshTokenExpiresAt,
    },
  ]),
});

export const DeleteGitHubCredentialRequest: Sync = (
  { request, accessToken, user },
) => ({
  when: actions([
    Requesting.request,
    { path: "/me/github", method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    return frames.filter((f) => f[user] !== undefined);
  },
  then: actions([
    CredentialVault.deleteCredential,
    { user, provider: "github" },
  ]),
});

export const DeleteGitHubCredentialResponse: Sync = ({ request }) => ({
  when: actions(
    [Requesting.request, { path: "/me/github", method: "DELETE" }, { request }],
    [CredentialVault.deleteCredential, {}, { ok: true }],
  ),
  then: actions([
    Requesting.respond,
    { request, ok: true },
  ]),
});

export const syncs = [
  GitHubLinkMissingAuth,
  GitHubLinkInvalidAuth,
  GetGitHubStatusRequest,
  GetGitHubStatusEmptyResponse,
  StartGitHubLinkValidationError,
  StartGitHubLinkConfigError,
  StartGitHubLinkRequest,
  GitHubCallbackRequest,
  GitHubLinkCompleteValidationError,
  GitHubLinkCompletePasswordError,
  GitHubLinkCompleteRequest,
  GitHubLinkCompleteStoreError,
  GitHubLinkCompleteResponse,
  DeleteGitHubCredentialRequest,
  DeleteGitHubCredentialResponse,
];
