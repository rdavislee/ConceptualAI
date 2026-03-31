import { actions, Frames, Sync } from "@engine";
import {
  CredentialVault,
  GitHubExporting,
  ProjectLedger,
  Requesting,
  Sessioning,
} from "@concepts";

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeVisibility(value: unknown): "public" | "private" {
  return value === "public" ? "public" : "private";
}

function normalizeRepoName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

function matchGitHubExportPath(
  path: string,
  method: string,
): { projectId: string; artifact: "backend" | "frontend" } | null {
  if (method !== "POST") return null;
  const match = path.match(
    /^\/projects\/([^/]+)\/export\/(backend|frontend)\/github$/,
  );
  if (!match) return null;
  return {
    projectId: match[1],
    artifact: match[2] as "backend" | "frontend",
  };
}

function isGitHubExportRoute(path: string, method: string): boolean {
  return matchGitHubExportPath(path, method) !== null;
}

function isGitHubExportStatusRoute(path: string, method: string): boolean {
  return method === "GET" &&
    /^\/projects\/[^/]+\/export\/github\/status$/.test(path);
}

function formatExportJob(job: Record<string, unknown> | null) {
  if (!job) return null;
  return {
    artifact: normalizeString(job.artifact),
    repoName: normalizeString(job.repoName),
    visibility: normalizeString(job.visibility),
    status: normalizeString(job.status),
    repoUrl: normalizeString(job.repoUrl) || null,
    repoOwner: normalizeString(job.repoOwner) || null,
    repoId: normalizeString(job.repoId) || null,
    remoteExists: typeof job.remoteExists === "boolean" ? job.remoteExists : null,
    lastRemoteCheckAt: job.lastRemoteCheckAt ?? null,
    logs: Array.isArray(job.logs) ? job.logs : [],
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
  };
}

async function resolveGithubCredentialForExport(
  user: string,
  unwrapKey: string,
): Promise<Record<string, unknown>> {
  let rows = await CredentialVault._resolveCredential({
    user: user as any,
    provider: "github",
    unwrapKey,
  });
  let resolved = rows[0] ?? {};
  if (resolved && "error" in resolved) {
    return resolved;
  }

  const accessTokenExpiresAt = normalizeString(
    (resolved as Record<string, unknown>).accessTokenExpiresAt,
  );
  const refreshToken = normalizeString(
    (resolved as Record<string, unknown>).refreshToken,
  );
  const expiresAt = accessTokenExpiresAt ? new Date(accessTokenExpiresAt) : null;
  const shouldRefresh = !!expiresAt &&
    !Number.isNaN(expiresAt.getTime()) &&
    expiresAt.getTime() <= Date.now() + 60_000 &&
    refreshToken.length > 0;

  if (shouldRefresh) {
    const refreshResult = await CredentialVault.refreshGithubCredential({
      user: user as any,
      provider: "github",
      unwrapKey,
    });
    if ("error" in refreshResult) {
      return {
        error: refreshResult.error,
        statusCode: 502,
      };
    }
    rows = await CredentialVault._resolveCredential({
      user: user as any,
      provider: "github",
      unwrapKey,
    });
    resolved = rows[0] ?? {};
  }

  return resolved;
}

export const GitHubExportMissingAuth: Sync = (
  { request, path, method, input },
) => ({
  when: actions([Requesting.request, { path, method }, { request }]),
  where: async (frames) => {
    frames = frames.filter((f) =>
      isGitHubExportRoute(
        String(f[path] ?? ""),
        String(f[method] ?? "").toUpperCase(),
      ) ||
      isGitHubExportStatusRoute(
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

export const GitHubExportInvalidAuth: Sync = (
  { request, path, method, accessToken, error },
) => ({
  when: actions([
    Requesting.request,
    { path, method, accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter((f) =>
      isGitHubExportRoute(
        String(f[path] ?? ""),
        String(f[method] ?? "").toUpperCase(),
      ) ||
      isGitHubExportStatusRoute(
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

export const GitHubExportAccessDenied: Sync = (
  { request, path, method, accessToken, projectId, artifact, user, owner },
) => ({
  when: actions([
    Requesting.request,
    { path, method, accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const route = matchGitHubExportPath(
        String(f[path] ?? ""),
        String(f[method] ?? "").toUpperCase(),
      );
      if (route) {
        return {
          ...f,
          [projectId]: route.projectId,
          [artifact]: route.artifact,
        };
      }
      const statusMatch = isGitHubExportStatusRoute(
          String(f[path] ?? ""),
          String(f[method] ?? "").toUpperCase(),
        )
        ? String(f[path] ?? "").match(/^\/projects\/([^/]+)\/export\/github\/status$/)
        : null;
      if (statusMatch) {
        return {
          ...f,
          [projectId]: statusMatch[1],
        };
      }
      return null;
    }).filter((f) => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      ProjectLedger._getOwner,
      { project: projectId },
      { owner },
    );
    return frames.filter((f) => f[user] !== f[owner]);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 403, error: "Access denied" },
  ]),
});

export const GitHubExportUnwrapErrorResponse: Sync = (
  { request, path, method, accessToken, unwrapKey, projectId, user, owner, error, statusCode },
) => ({
  when: actions([
    Requesting.request,
    { path, method, accessToken, unwrapKey },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const route = matchGitHubExportPath(
        String(f[path] ?? ""),
        String(f[method] ?? "").toUpperCase(),
      );
      if (!route) return null;
      return {
        ...f,
        [projectId]: route.projectId,
      };
    }).filter((f) => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      ProjectLedger._getOwner,
      { project: projectId },
      { owner },
    );
    frames = frames.filter((f) => f[user] === f[owner]);

    const nextFrames = new Frames();
    for (const frame of frames) {
      const resolved = await resolveGithubCredentialForExport(
        String(frame[user]),
        normalizeString(frame[unwrapKey]),
      );
      if ("error" in resolved) {
        nextFrames.push({
          ...frame,
          [error]: resolved.error,
          [statusCode]: resolved.statusCode ?? 400,
        });
      }
    }
    return nextFrames;
  },
  then: actions([
    Requesting.respond,
    { request, statusCode, error },
  ]),
});

export const GitHubExportRequest: Sync = (
  {
    request,
    path,
    method,
    accessToken,
    unwrapKey,
    repoName,
    visibility,
    projectId,
    artifact,
    user,
    owner,
    projectDoc,
    resolvedAccessToken,
    resolvedRepoName,
    resolvedVisibility,
    input,
  },
) => ({
  when: actions([
    Requesting.request,
    {
      path,
      method,
      accessToken,
      unwrapKey,
    },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const route = matchGitHubExportPath(
        String(f[path] ?? ""),
        String(f[method] ?? "").toUpperCase(),
      );
      if (!route) return null;
      return {
        ...f,
        [projectId]: route.projectId,
        [artifact]: route.artifact,
      };
    }).filter((f) => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      ProjectLedger._getOwner,
      { project: projectId },
      { owner },
    );
    frames = frames.filter((f) => f[user] === f[owner]);
    frames = await frames.query(
      ProjectLedger._getProject,
      { project: projectId },
      { project: projectDoc },
    );
    frames = await frames.query(Requesting._getInput, { request }, { input });

    const nextFrames = new Frames();
    for (const frame of frames) {
      const resolved = await resolveGithubCredentialForExport(
        String(frame[user]),
        normalizeString(frame[unwrapKey]),
      );
      if ("error" in resolved) continue;

      const project = frame[projectDoc] as any;
      const requestInput = (frame[input] && typeof frame[input] === "object")
        ? frame[input] as Record<string, unknown>
        : {};
      const projectName = normalizeRepoName(project?.name) ||
        normalizeRepoName(frame[projectId]) ||
        "conceptualai-project";
      const routeArtifact = String(frame[artifact]) as "backend" | "frontend";
      const explicitRepoName = normalizeRepoName(requestInput.repoName);
      nextFrames.push({
        ...frame,
        [resolvedAccessToken]: normalizeString(resolved.accessToken),
        [resolvedVisibility]: normalizeVisibility(requestInput.visibility),
        [resolvedRepoName]:
          explicitRepoName || `${projectName}-${routeArtifact}`,
      });
    }
    return nextFrames.filter((f) => normalizeString(f[resolvedAccessToken]).length > 0);
  },
  then: actions([
    GitHubExporting.startExport,
    {
      request,
      user,
      project: projectId,
      artifact,
      repoName: resolvedRepoName,
      visibility: resolvedVisibility,
      accessToken: resolvedAccessToken,
    },
  ]),
});

export const GitHubExportResponse: Sync = (
  { request, path, method, projectId, artifact, repoName, visibility, status },
) => ({
  when: actions(
    [Requesting.request, { path, method }, { request }],
    [GitHubExporting.startExport, { request }, { status, repoName, visibility }],
  ),
  where: (frames) =>
    frames.map((f) => {
      const route = matchGitHubExportPath(
        String(f[path] ?? ""),
        String(f[method] ?? "").toUpperCase(),
      );
      if (!route) return null;
      return {
        ...f,
        [projectId]: route.projectId,
        [artifact]: route.artifact,
      };
    }).filter((f) => f !== null) as any,
  then: actions([
    Requesting.respond,
    { request, project: projectId, artifact, status, repoName, visibility },
  ]),
});

export const GitHubExportErrorResponse: Sync = (
  { request, error, statusCode },
) => ({
  when: actions(
    [Requesting.request, {}, { request }],
    [GitHubExporting.startExport, { request }, { error, statusCode }],
  ),
  where: (frames) => frames.filter((f) => f[error] !== undefined),
  then: actions([
    Requesting.respond,
    { request, statusCode, error },
  ]),
});

export const GetGitHubExportStatusRequest: Sync = (
  { request, accessToken, path, projectId, user, owner, backendJob, frontendJob },
) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = String(f[path] ?? "").match(
        /^\/projects\/([^/]+)\/export\/github\/status$/,
      );
      if (!match) return null;
      return { ...f, [projectId]: match[1] };
    }).filter((f) => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    frames = frames.filter((f) => f[user] !== undefined);
    frames = await frames.query(
      ProjectLedger._getOwner,
      { project: projectId },
      { owner },
    );
    frames = frames.filter((f) => f[user] === f[owner]);

    const nextFrames = new Frames();
    for (const frame of frames) {
      const backendRows = await GitHubExporting._getExport({
        project: frame[projectId] as any,
        artifact: "backend",
      });
      const frontendRows = await GitHubExporting._getExport({
        project: frame[projectId] as any,
        artifact: "frontend",
      });
      nextFrames.push({
        ...frame,
        [backendJob]: formatExportJob((backendRows[0] as any)?.job ?? null),
        [frontendJob]: formatExportJob((frontendRows[0] as any)?.job ?? null),
      });
    }
    return nextFrames;
  },
  then: actions([
    Requesting.respond,
    { request, backend: backendJob, frontend: frontendJob },
  ]),
});

export const syncs = [
  GitHubExportMissingAuth,
  GitHubExportInvalidAuth,
  GitHubExportAccessDenied,
  GitHubExportUnwrapErrorResponse,
  GitHubExportRequest,
  GitHubExportResponse,
  GitHubExportErrorResponse,
  GetGitHubExportStatusRequest,
];
