import { actions, Frames, Sync } from "@engine";
import {
  Authenticating,
  CredentialVault,
  Requesting,
  Sessioning,
} from "@concepts";

function isGeminiCredentialRoute(path: string, method: string): boolean {
  return path === "/me/gemini-credential" &&
    (method === "GET" || method === "PUT" || method === "DELETE");
}

async function verifyGeminiFrames(
  frames: Frames,
  apiKey: symbol,
  geminiTier: symbol,
  verified: symbol,
  statusCode: symbol,
  error: symbol,
): Promise<Frames> {
  const out = new Frames();
  for (const frame of frames) {
    const result = await CredentialVault.verifyGeminiCredential({
      apiKey: String(frame[apiKey] ?? ""),
      geminiTier: String(frame[geminiTier] ?? ""),
    });
    out.push({
      ...frame,
      [verified]: result.ok,
      [statusCode]: result.ok ? 200 : result.statusCode,
      [error]: result.ok ? undefined : result.error,
    });
  }
  return out;
}

export const GeminiCredentialRequestMissingAuth: Sync = (
  { request, path, method, input },
) => ({
  when: actions([Requesting.request, { path, method }, { request }]),
  where: async (frames) => {
    frames = frames.filter((f) =>
      isGeminiCredentialRoute(
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

export const GeminiCredentialRequestInvalidAuth: Sync = (
  { request, path, method, accessToken, error },
) => ({
  when: actions([
    Requesting.request,
    { path, method, accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter((f) =>
      isGeminiCredentialRoute(
        String(f[path] ?? ""),
        String(f[method] ?? "").toUpperCase(),
      )
    );
    frames = await frames.query(Sessioning._getUser, {
      session: accessToken,
    }, { error });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});

export const GetGeminiCredentialStatusRequest: Sync = (
  {
    request,
    accessToken,
    user,
    hasGeminiCredential,
    kdfSalt,
    kdfParams,
    encryptionVersion,
    geminiTier,
  },
) => ({
  when: actions([
    Requesting.request,
    { path: "/me/gemini-credential", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      CredentialVault._getStatus,
      { user, provider: "gemini" },
      { hasGeminiCredential, kdfSalt, kdfParams, encryptionVersion, geminiTier },
    );
    return frames.filter((f) => f[hasGeminiCredential] === true);
  },
  then: actions([
    Requesting.respond,
    { request, hasGeminiCredential, kdfSalt, kdfParams, encryptionVersion, geminiTier },
  ]),
});

export const GetGeminiCredentialStatusEmptyResponse: Sync = (
  { request, accessToken, user, hasGeminiCredential },
) => ({
  when: actions([
    Requesting.request,
    { path: "/me/gemini-credential", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      CredentialVault._getStatus,
      { user, provider: "gemini" },
      { hasGeminiCredential },
    );
    return frames.filter((f) => f[hasGeminiCredential] === false);
  },
  then: actions([
    Requesting.respond,
    { request, hasGeminiCredential },
  ]),
});

export const PutGeminiCredentialValidationError: Sync = (
  { request, input },
) => ({
  when: actions([
    Requesting.request,
    { path: "/me/gemini-credential", method: "PUT" },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Requesting._getInput, { request }, { input });
    return frames.filter((f) => {
      const value = (f[input] as any) ?? {};
      return !value.accessToken ||
        !value.accountPassword ||
        !value.geminiKey ||
        !value.geminiTier ||
        !value.ciphertext ||
        !value.iv ||
        !value.kdfSalt ||
        !value.kdfParams ||
        !value.encryptionVersion;
    });
  },
  then: actions([
    Requesting.respond,
    {
      request,
      statusCode: 400,
      error:
        "Missing required Gemini credential fields: accountPassword, ciphertext, iv, kdfSalt, kdfParams, encryptionVersion, X-Gemini-Api-Key, and X-Gemini-Tier.",
    },
  ]),
});

export const PutGeminiCredentialPasswordError: Sync = (
  { request, accessToken, accountPassword, user, passwordOk, error },
) => ({
  when: actions([
    Requesting.request,
    {
      path: "/me/gemini-credential",
      method: "PUT",
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

export const PutGeminiCredentialGeminiValidationError: Sync = (
  {
    request,
    accessToken,
    accountPassword,
    user,
    passwordOk,
    geminiKey,
    geminiTier,
    verified,
    statusCode,
    error,
  },
) => ({
  when: actions([
    Requesting.request,
    {
      path: "/me/gemini-credential",
      method: "PUT",
      accessToken,
      accountPassword,
      geminiKey,
      geminiTier,
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
    frames = await verifyGeminiFrames(
      frames,
      geminiKey,
      geminiTier,
      verified,
      statusCode,
      error,
    );
    return frames.filter((f) => f[verified] !== true);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode, error },
  ]),
});

export const PutGeminiCredentialRequest: Sync = (
  {
    request,
    accessToken,
    accountPassword,
    user,
    passwordOk,
    error,
    geminiKey,
    geminiTier,
    ciphertext,
    iv,
    kdfSalt,
    kdfParams,
    encryptionVersion,
    verified,
    statusCode,
    redactedMetadata,
  },
) => ({
  when: actions([
    Requesting.request,
    {
      path: "/me/gemini-credential",
      method: "PUT",
      accessToken,
      accountPassword,
      geminiKey,
      geminiTier,
      ciphertext,
      iv,
      kdfSalt,
      kdfParams,
      encryptionVersion,
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
    frames = await verifyGeminiFrames(
      frames,
      geminiKey,
      geminiTier,
      verified,
      statusCode,
      error,
    );
    return new Frames(...frames.filter((f) => f[verified] === true).map((f) => ({
      ...f,
      [redactedMetadata]: {
        geminiTier: f[geminiTier],
      },
    })));
  },
  then: actions([
    CredentialVault.storeCredential,
    {
      user,
      provider: "gemini",
      ciphertext,
      iv,
      redactedMetadata,
      kdfSalt,
      kdfParams,
      encryptionVersion,
    },
  ]),
});

export const PutGeminiCredentialResponse: Sync = (
  {
    request,
    accessToken,
    user,
    hasGeminiCredential,
    kdfSalt,
    kdfParams,
    encryptionVersion,
    geminiTier,
  },
) => ({
  when: actions(
    [
      Requesting.request,
      { path: "/me/gemini-credential", method: "PUT", accessToken },
      { request },
    ],
    [CredentialVault.storeCredential, {}, { ok: true }],
  ),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      CredentialVault._getStatus,
      { user, provider: "gemini" },
      { hasGeminiCredential, kdfSalt, kdfParams, encryptionVersion, geminiTier },
    );
    return new Frames(...frames.map((f) => ({
      ...f,
      [kdfSalt]: f[kdfSalt],
      [kdfParams]: f[kdfParams],
      [encryptionVersion]: f[encryptionVersion],
      [geminiTier]: f[geminiTier],
    })));
  },
  then: actions([
    Requesting.respond,
    { request, hasGeminiCredential, kdfSalt, kdfParams, encryptionVersion, geminiTier },
  ]),
});

export const DeleteGeminiCredentialRequest: Sync = (
  { request, accessToken, user },
) => ({
  when: actions([
    Requesting.request,
    { path: "/me/gemini-credential", method: "DELETE", accessToken },
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
    { user, provider: "gemini" },
  ]),
});

export const DeleteGeminiCredentialResponse: Sync = ({ request }) => ({
  when: actions(
    [Requesting.request, { path: "/me/gemini-credential", method: "DELETE" }, {
      request,
    }],
    [CredentialVault.deleteCredential, {}, { ok: true }],
  ),
  then: actions([
    Requesting.respond,
    { request, ok: true },
  ]),
});
