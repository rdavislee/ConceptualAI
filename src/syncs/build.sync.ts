import { Frames } from "@engine";
import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning, Planning, Implementing, SyncGenerating, Assembling, FrontendGenerating } from "@concepts";

// Debug: Verify module is loaded
console.log("[build.sync.ts] Module loaded");

/**
 * POST /projects/:projectId/build
 * 
 * Triggers both backend assembly (Assembling) and frontend generation (FrontendGenerating) in parallel.
 * Both run asynchronously. Poll GET /projects/:projectId/build/status to check progress.
 * Project status changes to "assembled" only when BOTH are complete.
 */
export const TriggerBuild: Sync = ({ projectId, plan, implementations, syncs, token, userId, owner, request, path, projectDoc, apiDefinition, frontendGuide }) => {
  const syncsList = Symbol("syncsList");
  const apiDef = Symbol("apiDef");
  const bundles = Symbol("bundles");
  const guide = Symbol("guide");

  return {
    when: actions([
      Requesting.request,
      { path, method: "POST", accessToken: token },
      { request },
    ]),
    where: async (frames) => {
      console.log("[TriggerBuild] Starting where clause, frames:", frames.length);
      
      // Parse path to extract projectId
      frames = frames.map(f => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/build$/);
        if (match) {
          return { ...f, [projectId]: match[1] };
        }
        return null;
      }).filter(f => f !== null) as any;
      console.log("[TriggerBuild] After path parse, frames:", frames.length);

      // Authenticate
      frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
      console.log("[TriggerBuild] After auth, frames:", frames.length);

      // Authorization
      frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
      frames = frames.filter(f => f[userId] === f[owner]);
      console.log("[TriggerBuild] After owner check, frames:", frames.length);

      // Check Project Status - must have syncs generated
      frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectDoc });
      frames = frames.filter(f => {
        const p = f[projectDoc] as any;
        console.log("[TriggerBuild] Project status:", p?.status);
        return p && (p.status === "syncs_generated" || p.status === "building" || p.status === "assembled" || p.status === "complete");
      });
      console.log("[TriggerBuild] After status check, frames:", frames.length);

      // Fetch Plan
      frames = await frames.query(Planning._getPlan, { project: projectId }, { plan });
      frames = frames.map(f => ({ ...f, [plan]: (f[plan] as any).plan }));
      console.log("[TriggerBuild] After plan fetch, frames:", frames.length);

      // Fetch Implementations
      frames = await frames.query(Implementing._getImplementations, { project: projectId }, { implementations });
      console.log("[TriggerBuild] After impl fetch, frames:", frames.length);

      // Fetch Syncs (for API definition and frontend guide)
      frames = await frames.query(SyncGenerating._getSyncs, { project: projectId }, { syncs: syncsList, apiDefinition: apiDef, endpointBundles: bundles, frontendGuide: guide });
      console.log("[TriggerBuild] After syncs fetch, frames:", frames.length);

      frames = frames.map(f => {
        const s = f[syncsList];
        const a = f[apiDef];
        const b = f[bundles];
        const g = f[guide];
        if (!s) return null;
        return {
          ...f,
          [syncs]: { syncs: s, apiDefinition: a, endpointBundles: b },
          [apiDefinition]: a,
          [frontendGuide]: g || ""
        };
      }).filter(f => f !== null) as any;
      console.log("[TriggerBuild] Final frames:", frames.length);

      return frames;
    },
    then: actions(
      [ProjectLedger.updateStatus, { project: projectId, status: "building" }],
      // Trigger backend assembly
      [Assembling.assemble, { project: projectId, plan, implementations, syncs }],
      // Trigger frontend generation with the frontend guide
      [FrontendGenerating.generate, { project: projectId, plan, apiDefinition, frontendGuide }],
      // Respond immediately - both processes run, poll /build/status for completion
      [Requesting.respond, { 
        request, 
        status: "processing",
        message: "Build started. Poll /projects/{id}/build/status for completion."
      }]
    )
  };
};

/**
 * GET /projects/:projectId/build/status
 * Also handles /projects/:projectId/assemble/status for backwards compatibility
 * 
 * Returns the combined status of both backend and frontend generation.
 * Updates project status to "assembled" when BOTH are complete.
 */
export const GetBuildStatus: Sync = ({ projectId, token, userId, owner, request, path, backendStatus, frontendStatus, overallStatus }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    console.log("[GetBuildStatus] Starting where clause, frames:", frames.length);
    
    // Parse path - accepts both /build/status and /assemble/status
    frames = frames.map(f => {
      const p = f[path] as string;
      if (!p) return null;
      // Match /projects/{id}/build/status OR /projects/{id}/assemble/status
      const match = p.match(/^\/projects\/([^\/]+)\/(build|assemble)\/status$/);
      if (match) {
        return { ...f, [projectId]: match[1] };
      }
      return null;
    }).filter(f => f !== null) as any;
    console.log("[GetBuildStatus] After path parse, frames:", frames.length);

    // Authenticate
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    console.log("[GetBuildStatus] After auth, frames:", frames.length);

    // Authorization
    frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
    frames = frames.filter(f => f[userId] === f[owner]);
    console.log("[GetBuildStatus] After owner check, frames:", frames.length);

    // Get backend and frontend status
    const newFrames = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId] as string;

      // Get Assembling status
      const assemblyUrl = await Assembling._getDownloadUrl({ project: pid } as any);

      // Get FrontendGenerating status
      const frontendJobs = await FrontendGenerating._getJob({ project: pid } as any);
      const frontendJob = frontendJobs.length > 0 ? frontendJobs[0] : null;

      const backend = assemblyUrl.downloadUrl
        ? { status: "complete", downloadUrl: assemblyUrl.downloadUrl }
        : { status: "processing" };

      const frontend = frontendJob
        ? { status: frontendJob.status, downloadUrl: frontendJob.downloadUrl || null }
        : { status: "processing" };

      // Determine overall status - only "complete" when BOTH are complete
      let status = "processing";
      if (backend.status === "complete" && frontend.status === "complete") {
        status = "complete";
        // Update project status to assembled when both complete
        await ProjectLedger.updateStatus({ project: pid as any, status: "assembled" });
      } else if (frontend.status === "error") {
        status = "error";
      }

      newFrames.push({
        ...frame,
        [backendStatus]: backend,
        [frontendStatus]: frontend,
        [overallStatus]: status
      });
    }

    return newFrames;
  },
  then: actions([
    Requesting.respond, {
      request,
      status: overallStatus,
      backend: backendStatus,
      frontend: frontendStatus
    }
  ])
});

/**
 * GET /downloads/:projectId_backend.zip
 * 
 * Downloads the assembled backend project.
 */
export const DownloadBackend: Sync = ({ projectId, token, userId, owner, request, path, stream }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request }
  ]),
  where: async (frames) => {
    // Parse path - pattern: /downloads/:projectId_backend.zip
    frames = frames.map(f => {
      const p = f[path] as string;
      if (!p) return null;
      const match = p.match(/^\/downloads\/([^_]+)_backend\.zip$/);
      if (match) {
        return { ...f, [projectId]: match[1] };
      }
      return null;
    }).filter(f => f !== null) as any;

    // Authenticate & Authorize
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
    frames = frames.filter(f => f[userId] === f[owner]);

    // Fetch Stream from Assembling
    const newFrames = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId];
      const fileStream = await Assembling.getFileStream({ project: pid } as any);
      if (fileStream) {
        newFrames.push({ ...frame, [stream]: fileStream });
      }
    }
    return newFrames;
  },
  then: actions([
    Requesting.respond,
    {
      request,
      stream: stream,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=\"backend.zip\""
      }
    }
  ])
});

/**
 * GET /downloads/:projectId_frontend.zip
 * 
 * Downloads the generated frontend project.
 */
export const DownloadFrontend: Sync = ({ projectId, token, userId, owner, request, path, stream }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request }
  ]),
  where: async (frames) => {
    // Parse path - pattern: /downloads/:projectId_frontend.zip
    frames = frames.map(f => {
      const p = f[path] as string;
      if (!p) return null;
      const match = p.match(/^\/downloads\/([^_]+)_frontend\.zip$/);
      if (match) {
        return { ...f, [projectId]: match[1] };
      }
      return null;
    }).filter(f => f !== null) as any;

    // Authenticate & Authorize
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
    frames = frames.filter(f => f[userId] === f[owner]);

    // Fetch Stream from FrontendGenerating
    const newFrames = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId];
      const fileStream = await FrontendGenerating.getFileStream({ project: pid } as any);
      if (fileStream) {
        newFrames.push({ ...frame, [stream]: fileStream });
      }
    }
    return newFrames;
  },
  then: actions([
    Requesting.respond,
    {
      request,
      stream: stream,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=\"frontend.zip\""
      }
    }
  ])
});

/**
 * GET /downloads/:projectId.zip
 * 
 * Downloads the assembled backend project (generic path for backwards compatibility).
 */
export const DownloadProject: Sync = ({ projectId, token, userId, owner, request, path, stream }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request }
  ]),
  where: async (frames) => {
    // Parse path - pattern: /downloads/:projectId.zip (no _backend or _frontend suffix)
    frames = frames.map(f => {
      const p = f[path] as string;
      if (!p) return null;
      // Match /downloads/{id}.zip but NOT /downloads/{id}_backend.zip or /downloads/{id}_frontend.zip
      const match = p.match(/^\/downloads\/([^_\.]+)\.zip$/);
      if (match) {
        return { ...f, [projectId]: match[1] };
      }
      return null;
    }).filter(f => f !== null) as any;

    // Authenticate & Authorize
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
    frames = frames.filter(f => f[userId] === f[owner]);

    // Fetch Stream from Assembling (backend)
    const newFrames = new Frames();
    for (const frame of frames) {
      const pid = frame[projectId];
      const fileStream = await Assembling.getFileStream({ project: pid } as any);
      if (fileStream) {
        newFrames.push({ ...frame, [stream]: fileStream });
      }
    }
    return newFrames;
  },
  then: actions([
    Requesting.respond,
    {
      request,
      stream: stream,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=\"project.zip\""
      }
    }
  ])
});

export const syncs = [
  TriggerBuild,
  GetBuildStatus,
  DownloadBackend,
  DownloadFrontend,
  DownloadProject
];

// Debug: Verify exports
console.log("[build.sync.ts] Exports:", {
    TriggerBuild: typeof TriggerBuild,
    GetBuildStatus: typeof GetBuildStatus,
    DownloadBackend: typeof DownloadBackend,
    DownloadFrontend: typeof DownloadFrontend,
    DownloadProject: typeof DownloadProject
});
