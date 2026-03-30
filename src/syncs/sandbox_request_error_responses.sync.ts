import { actions, Frames, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

type RouteRule = {
  method: "POST" | "PUT";
  regex: RegExp;
  requiresProject: boolean;
  allowedStatuses?: string[];
  invalidStatusMessage: string;
  feature?: "preview";
};

function previewsEnabled(): boolean {
  const raw = (Deno.env.get("PREVIEWS_ENABLED") || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

const ROUTE_RULES: RouteRule[] = [
  {
    method: "POST",
    regex: /^\/projects$/,
    requiresProject: false,
    invalidStatusMessage: "Invalid request state for project creation.",
  },
  {
    method: "POST",
    regex: /^\/projects\/([^\/]+)\/clarify$/,
    requiresProject: true,
    invalidStatusMessage: "Project cannot be clarified in its current status.",
  },
  {
    method: "PUT",
    regex: /^\/projects\/([^\/]+)\/plan$/,
    requiresProject: true,
    invalidStatusMessage: "Project cannot be modified in its current status.",
  },
  {
    method: "POST",
    regex: /^\/projects\/([^\/]+)\/design$/,
    requiresProject: true,
    invalidStatusMessage: "Project cannot be designed in its current status.",
  },
  {
    method: "PUT",
    regex: /^\/projects\/([^\/]+)\/design$/,
    requiresProject: true,
    invalidStatusMessage: "Project cannot be redesigned in its current status.",
  },
  {
    method: "POST",
    regex: /^\/projects\/([^\/]+)\/implement$/,
    requiresProject: true,
    allowedStatuses: ["design_complete"],
    invalidStatusMessage:
      "Project must be in design_complete before implementation.",
  },
  {
    method: "POST",
    regex: /^\/projects\/([^\/]+)\/syncs$/,
    requiresProject: true,
    allowedStatuses: ["implemented", "syncs_generated"],
    invalidStatusMessage:
      "Project must be implemented before sync generation.",
  },
  {
    method: "POST",
    regex: /^\/projects\/([^\/]+)\/assemble$/,
    requiresProject: true,
    allowedStatuses: ["syncs_generated", "assembled", "complete"],
    invalidStatusMessage:
      "Project must have syncs_generated before assembly.",
  },
  {
    method: "POST",
    regex: /^\/projects\/([^\/]+)\/build$/,
    requiresProject: true,
    allowedStatuses: ["syncs_generated", "building", "assembled", "complete"],
    invalidStatusMessage:
      "Project must be syncs_generated/assembled before build.",
  },
  {
    method: "POST",
    regex: /^\/projects\/([^\/]+)\/preview$/,
    requiresProject: true,
    allowedStatuses: ["assembled", "complete"],
    invalidStatusMessage:
      "Project must be assembled before launching a preview.",
    feature: "preview",
  },
  {
    method: "POST",
    regex: /^\/projects\/([^\/]+)\/preview\/teardown$/,
    requiresProject: true,
    invalidStatusMessage: "Preview teardown requires a valid project.",
    feature: "preview",
  },
];

export const SandboxRoutePreconditionErrorResponse: Sync = (
  { request, path, method, token, userId, projectId, project, error, statusCode },
) => ({
  when: actions([
    Requesting.request,
    { path, method, accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);

    const pendingFrames = new Frames();
    const routeRule = Symbol("routeRule");
    for (const frame of frames) {
      const reqId = frame[request] as string;
      const p = frame[path] as string;
      const m = ((frame[method] as string) || "").toUpperCase();
      const rule = ROUTE_RULES.find((r) => r.method === m && r.regex.test(p));
      if (!rule) continue;
      if (rule.feature === "preview" && !previewsEnabled()) continue;

      const pendingMatches = await Requesting._getPendingRequestsByPaths({
        paths: [p],
        method: m,
      } as any);
      if (!pendingMatches.some((x) => x.request === reqId)) continue;

      pendingFrames.push({
        ...frame,
        [routeRule]: rule,
      } as any);
    }

    frames = pendingFrames;
    if (frames.length === 0) return frames;

    frames = await frames.query(Sessioning._getUser, { session: token }, {
      user: userId,
      error,
    });

    const out: any[] = [];
    for (const frame of frames) {
      const rule = frame[routeRule] as RouteRule;
      const uid = frame[userId];
      const authError = frame[error];

      if (authError !== undefined || uid === undefined) {
        out.push({
          ...frame,
          [statusCode]: 401,
          [error]: "Unauthorized",
        });
        continue;
      }

      if (!rule.requiresProject) {
        continue;
      }

      const match = (frame[path] as string).match(rule.regex);
      if (!match) continue;
      const pid = match[1];
      const withPid = { ...frame, [projectId]: pid };

      const projectRows = await ProjectLedger._getProject({ project: pid } as any);
      const projectDoc = (projectRows[0] as any)?.project;
      const projectError = (projectRows[0] as any)?.error;
      if (projectError || !projectDoc) {
        out.push({
          ...withPid,
          [statusCode]: 404,
          [error]: "Project not found",
        });
        continue;
      }

      if (projectDoc.owner !== uid) {
        out.push({
          ...withPid,
          [statusCode]: 403,
          [error]: "Access denied",
        });
        continue;
      }

      if (
        Array.isArray(rule.allowedStatuses) &&
        !rule.allowedStatuses.includes(projectDoc.status)
      ) {
        out.push({
          ...withPid,
          [statusCode]: 409,
          [error]: rule.invalidStatusMessage,
        });
      }
    }

    return out as any;
  },
  then: actions([
    Requesting.respond,
    { request, statusCode, error },
  ]),
});

export const syncs = [
  SandboxRoutePreconditionErrorResponse,
];
