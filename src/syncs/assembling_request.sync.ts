import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning, Planning, Implementing, SyncGenerating, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const ASSEMBLING_MARKER = "__ASSEMBLING__";

/**
 * TriggerAssembly - Gateway side.
 * Provisions a sandbox to run backend assembly.
 */
export const TriggerAssembly: Sync = ({ projectId, plan, implementations, syncs, token, userId, owner, request, path, projectDoc, geminiKey, projectName, projectDescription }) => {
  const syncsList = Symbol("syncsList");
  const apiDef = Symbol("apiDef");
  const bundles = Symbol("bundles");
  const rollbackStatus = Symbol("rollbackStatus");

  return {
    when: actions([
      Requesting.request,
      { path, method: "POST", accessToken: token },
      { request },
    ]),
    where: async (frames) => {
      if (IS_SANDBOX) return frames.filter(() => false);

      // Parse path to extract projectId
      frames = frames.map((f) => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/assemble$/);
        if (match) {
          return { ...f, [projectId]: match[1] };
        }
        return null;
      }).filter((f) => f !== null) as any;

      // Authenticate
      frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });

      // Authorization
      frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
      frames = frames.filter((f) => f[userId] === f[owner]);

      // Check project status
      frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectDoc });
      frames = frames.filter((f) => {
        const p = f[projectDoc] as any;
        return p && (p.status === "syncs_generated" || p.status === "assembled" || p.status === "complete");
      });
      frames = frames.map((f) => ({ ...f, [rollbackStatus]: (f[projectDoc] as any).status }));

      // Project context for sandbox provisioning
      const envKey = Deno.env.get("GEMINI_API_KEY");
      frames = frames.map((f) => {
        const p = f[projectDoc] as any;
        return {
          ...f,
          [geminiKey]: f[geminiKey] || envKey,
          [projectName]: p.name,
          [projectDescription]: p.description,
        };
      });

      // Fetch plan
      frames = await frames.query(Planning._getPlan, { project: projectId }, { plan });
      frames = frames.map((f) => ({ ...f, [plan]: (f[plan] as any).plan }));

      // Fetch implementations
      frames = await frames.query(Implementing._getImplementations, { project: projectId }, { implementations });

      // Fetch sync artifacts
      frames = await frames.query(SyncGenerating._getSyncs, { project: projectId }, { syncs: syncsList, apiDefinition: apiDef, endpointBundles: bundles });
      frames = frames.map((f) => {
        const s = f[syncsList];
        const a = f[apiDef];
        const b = f[bundles];
        if (!s) return null;
        return { ...f, [syncs]: { syncs: s, apiDefinition: a, endpointBundles: b } };
      }).filter((f) => f !== null) as any;

      return frames;
    },
    then: actions(
      [ProjectLedger.updateStatus, { project: projectId, status: "assembling" }],
      [Sandboxing.provision, {
        userId,
        apiKey: geminiKey,
        projectId,
        name: projectName,
        description: projectDescription,
        mode: "syncgenerating",
        feedback: ASSEMBLING_MARKER,
        answers: { rollbackStatus },
        rollbackStatus,
      }],
    ),
  };
};

export const TriggerAssemblyStarted: Sync = ({ projectId, request, path, downloadUrl }) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.provision, { projectId, mode: "syncgenerating" }, { project: projectId, status: "complete", downloadUrl }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/assemble`;
    });
  },
  then: actions(
    [Requesting.respond, { request, project: projectId, status: "complete", downloadUrl }],
  ),
});

export const TriggerAssemblyFailed: Sync = ({ projectId, request, path, error, rollbackStatus }) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.provision, { projectId, mode: "syncgenerating", rollbackStatus }, { error }],
  ),
  where: async (frames) => {
    if (IS_SANDBOX) return frames.filter(() => false);
    return frames.filter((f) => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      return p === `/projects/${pid}/assemble`;
    });
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: rollbackStatus }],
    [Requesting.respond, { request, project: projectId, statusCode: 500, error }],
  ),
});

export const syncs = [
  TriggerAssembly,
  TriggerAssemblyStarted,
  TriggerAssemblyFailed,
];
