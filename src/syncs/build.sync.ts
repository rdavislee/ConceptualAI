import { Frames } from "@engine";
import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning, Planning, Implementing, SyncGenerating, Assembling, FrontendGenerating } from "@concepts";

// Debug: Verify module is loaded
console.log("[build.sync.ts] Module loaded");

/**
 * POST /projects/:projectId/build
 * 
 * Triggers both backend assembly (Assembling) and frontend generation (FrontendGenerating) in parallel.
 * Since FrontendGenerating runs asynchronously, this endpoint returns immediately with processing status.
 * Use GET /projects/:projectId/build/status to poll for completion.
 */
export const TriggerBuild: Sync = ({ projectId, plan, implementations, syncs, token, userId, owner, request, path, projectDoc, apiDefinition }) => {
  const syncsList = Symbol("syncsList");
  const apiDef = Symbol("apiDef");
  const bundles = Symbol("bundles");

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

      // Fetch Syncs (for API definition needed by frontend)
      frames = await frames.query(SyncGenerating._getSyncs, { project: projectId }, { syncs: syncsList, apiDefinition: apiDef, endpointBundles: bundles });
      console.log("[TriggerBuild] After syncs fetch, frames:", frames.length);

      frames = frames.map(f => {
        const s = f[syncsList];
        const a = f[apiDef];
        const b = f[bundles];
        if (!s) return null;
        return {
          ...f,
          [syncs]: { syncs: s, apiDefinition: a, endpointBundles: b },
          [apiDefinition]: a
        };
      }).filter(f => f !== null) as any;
      console.log("[TriggerBuild] Final frames:", frames.length);

      return frames;
    },
    then: actions(
      [ProjectLedger.updateStatus, { project: projectId, status: "building" }],
      // Trigger backend assembly (synchronous)
      [Assembling.assemble, { project: projectId, plan, implementations, syncs }],
      // Trigger frontend generation (asynchronous - returns immediately)
      [FrontendGenerating.generate, { project: projectId, plan, apiDefinition }],
      // Respond immediately after triggering both - frontend runs async, backend is done
      [Requesting.respond, { 
        request, 
        status: "processing",
        backend: { status: "complete" },
        frontend: { status: "processing" },
        message: "Build started. Backend assembly complete. Frontend generation in progress. Poll /build/status for completion."
      }]
    )
  };
};

/**
 * When Assembling completes after a build request, check if frontend is also done
 * and respond accordingly.
 */
export const BuildAssemblyComplete: Sync = ({ projectId, downloadUrl, request, path, frontendJob }) => ({
  when: actions(
    [Assembling.assemble, { project: projectId }, { downloadUrl }],
    [Requesting.request, { path }, { request }]
  ),
  where: async (frames) => {
    console.log("[BuildAssemblyComplete] Starting where clause, frames:", frames.length);
    
    // Ensure request path matches '/projects/:id/build'
    frames = frames.filter(f => {
      const p = f[path] as string;
      const pid = f[projectId] as string;
      console.log("[BuildAssemblyComplete] Checking path:", p, "projectId:", pid);
      return p === `/projects/${pid}/build`;
    });
    console.log("[BuildAssemblyComplete] After path filter, frames:", frames.length);

    // Check frontend status
    frames = await frames.query(FrontendGenerating._getJob, { project: projectId }, { job: frontendJob });
    console.log("[BuildAssemblyComplete] After frontend job query, frames:", frames.length);

    return frames;
  },
  then: actions(
    // Respond with combined status
    [Requesting.respond, {
      request,
      status: "processing",
      backend: { status: "complete", downloadUrl },
      frontend: { status: "processing" },
      message: "Backend assembly complete. Frontend generation in progress. Poll /build/status for updates."
    }]
  )
});

/**
 * GET /projects/:projectId/build/status
 * 
 * Returns the combined status of both backend and frontend generation.
 */
export const GetBuildStatus: Sync = ({ projectId, token, userId, owner, request, path, projectDoc, backendStatus, frontendStatus, overallStatus }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    console.log("[GetBuildStatus] Starting where clause, frames:", frames.length);
    
    // Parse path
    frames = frames.map(f => {
      const p = f[path] as string;
      if (!p) return null;
      const match = p.match(/^\/projects\/([^\/]+)\/build\/status$/);
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
        : { status: "pending" };

      const frontend = frontendJob
        ? { status: frontendJob.status, downloadUrl: frontendJob.downloadUrl || null }
        : { status: "pending" };

      // Determine overall status
      let status = "pending";
      if (backend.status === "complete" && frontend.status === "complete") {
        status = "complete";
      } else if (backend.status === "complete" || frontend.status === "processing") {
        status = "processing";
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

export const syncs = [TriggerBuild, BuildAssemblyComplete, GetBuildStatus, DownloadBackend, DownloadFrontend];

// Debug: Verify exports
console.log("[build.sync.ts] Exports:", {
    TriggerBuild: typeof TriggerBuild,
    BuildAssemblyComplete: typeof BuildAssemblyComplete,
    GetBuildStatus: typeof GetBuildStatus,
    DownloadBackend: typeof DownloadBackend,
    DownloadFrontend: typeof DownloadFrontend
});
