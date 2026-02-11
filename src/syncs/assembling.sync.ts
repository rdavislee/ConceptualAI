import { Frames } from "@engine";
import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning, Planning, Implementing, SyncGenerating, Assembling, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";
const SANDBOX_FEEDBACK = Deno.env.get("SANDBOX_FEEDBACK") || "";
const ASSEMBLING_MARKER = "__ASSEMBLING__";
const SANDBOX_META_RAW = Deno.env.get("SANDBOX_CLARIFICATION_ANSWERS");
let SANDBOX_META: Record<string, string> = {};
if (SANDBOX_META_RAW) {
  try {
    SANDBOX_META = JSON.parse(SANDBOX_META_RAW);
  } catch (error) {
    console.error("[AssemblySandboxStartup] Failed to parse SANDBOX_CLARIFICATION_ANSWERS:", error);
  }
}
const ROLLBACK_STATUS = SANDBOX_META.rollbackStatus || "syncs_generated";

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
    frames = frames.map(f => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/assemble$/);
        if (match) {
            return { ...f, [projectId]: match[1] };
        }
        return null;
    }).filter(f => f !== null) as any;

    // Authenticate
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    
    // Authorization
    frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
    frames = frames.filter(f => f[userId] === f[owner]);

    // Check Project Status
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectDoc });
    frames = frames.filter(f => {
        const p = f[projectDoc] as any;
        return p && (p.status === "syncs_generated" || p.status === "assembled" || p.status === "complete"); 
    });
    frames = frames.map(f => ({ ...f, [rollbackStatus]: (f[projectDoc] as any).status }));
    const envKey = Deno.env.get("GEMINI_API_KEY");
    frames = frames.map(f => {
      const p = f[projectDoc] as any;
      return {
        ...f,
        [geminiKey]: f[geminiKey] || envKey,
        [projectName]: p.name,
        [projectDescription]: p.description,
      };
    });

    // Fetch Plan
    frames = await frames.query(Planning._getPlan, { project: projectId }, { plan });
    frames = frames.map(f => ({...f, [plan]: (f[plan] as any).plan }));

    // Fetch Implementations
    frames = await frames.query(Implementing._getImplementations, { project: projectId }, { implementations });
    console.log("Frames after Impl Query:", frames.length);
    if (frames.length > 0) {
        // console.log("First frame implementations wrapper:", (frames[0] as any)[implementations]);
    }
    
    // Implementations are already extracted by the query
    // frames = frames.map(f => { ... }); 

    
    console.log("Frames after Impl Map:", frames.length);

    // Fetch Syncs
    frames = await frames.query(SyncGenerating._getSyncs, { project: projectId }, { syncs: syncsList, apiDefinition: apiDef, endpointBundles: bundles });
    
    frames = frames.map(f => {
        const s = f[syncsList];
        const a = f[apiDef];
        const b = f[bundles];
        if (!s) return null;
        // Assembling.assemble expects { syncs: { syncs: [], apiDefinition: {}, endpointBundles: [] } }
        return { ...f, [syncs]: { syncs: s, apiDefinition: a, endpointBundles: b } };
    }).filter(f => f !== null) as any;

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
    }]
  )
  };
};

export const TriggerAssemblyStarted: Sync = ({ projectId, request, path, downloadUrl }) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.provision, { projectId, mode: "syncgenerating" }, { project: projectId, status: "complete", downloadUrl }],
  ),
  where: async (frames) => {
      if (IS_SANDBOX) return frames.filter(() => false);
      return frames.filter(f => {
          const p = f[path] as string;
          const pid = f[projectId] as string;
          return p === `/projects/${pid}/assemble`;
      });
  },
  then: actions(
    [Requesting.respond, { request, project: projectId, status: "complete", downloadUrl }]
  )
});

export const TriggerAssemblyFailed: Sync = ({ projectId, request, path, error, rollbackStatus }) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Sandboxing.provision, { projectId, mode: "syncgenerating", rollbackStatus }, { error }],
  ),
  where: async (frames) => {
      if (IS_SANDBOX) return frames.filter(() => false);
      return frames.filter(f => {
          const p = f[path] as string;
          const pid = f[projectId] as string;
          return p === `/projects/${pid}/assemble`;
      });
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: rollbackStatus }],
    [Requesting.respond, { request, project: projectId, statusCode: 500, error }],
  )
});

/**
 * AssemblySandboxStartup - Sandbox side.
 * Reuses startSyncGenerating action with a marker to run assembly in sandbox.
 */
export const AssemblySandboxStartup: Sync = ({ projectId, plan, implementations, syncs }) => {
  const syncsList = Symbol("syncsList");
  const apiDef = Symbol("apiDef");
  const bundles = Symbol("bundles");
  return {
    when: actions([
      Sandboxing.startSyncGenerating, { projectId }, {}
    ]),
    where: async (frames) => {
      if (!IS_SANDBOX) return frames.filter(() => false);
      if (!SANDBOX_FEEDBACK.startsWith(ASSEMBLING_MARKER)) return frames.filter(() => false);

      frames = await frames.query(Planning._getPlan, { project: projectId }, { plan });
      frames = frames.map(f => ({...f, [plan]: (f[plan] as any).plan }));

      frames = await frames.query(Implementing._getImplementations, { project: projectId }, { implementations });
      frames = await frames.query(SyncGenerating._getSyncs, { project: projectId }, { syncs: syncsList, apiDefinition: apiDef, endpointBundles: bundles });

      frames = frames.map(f => {
          const s = f[syncsList];
          const a = f[apiDef];
          const b = f[bundles];
          if (!s) return null;
          return { ...f, [syncs]: { syncs: s, apiDefinition: a, endpointBundles: b } };
      }).filter(f => f !== null) as any;

      return frames;
    },
    then: actions(
      [Assembling.assemble, { project: projectId, plan, implementations, syncs }]
    ),
  };
};

export const AssemblySandboxComplete: Sync = ({ projectId, downloadUrl }) => ({
  when: actions(
    [Assembling.assemble, { project: projectId }, { downloadUrl }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    if (!SANDBOX_FEEDBACK.startsWith(ASSEMBLING_MARKER)) return frames.filter(() => false);
    return frames;
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "complete" }],
    [Sandboxing.exit, {}],
  )
});

export const AssemblySandboxError: Sync = ({ projectId, error }) => ({
  when: actions(
    [Assembling.assemble, { project: projectId }, { error }],
  ),
  where: async (frames) => {
    if (!IS_SANDBOX) return frames.filter(() => false);
    if (!SANDBOX_FEEDBACK.startsWith(ASSEMBLING_MARKER)) return frames.filter(() => false);
    return frames;
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: ROLLBACK_STATUS }],
    [Sandboxing.exit, {}],
  )
});

// Since we cannot easily pass a Stream through the JSON-based Requesting.respond mechanism without specialized handling in Requesting,
// We will bypass the standard sync flow for serving the file content for now, OR rely on a specialized Requesting action.
// However, the cleanest way within the "NO PASSTHROUGH" architecture is to have a sync that:
// 1. Intercepts the GET /downloads request
// 2. Fetches the stream from Assembling
// 3. Calls a new Requesting.streamResponse action (if we added it).
// But Requesting.respond only takes a JSON object currently.
//
// Workaround: We will let Requesting.respond take a special object `{ stream: ReadableStream, headers: Record<string, string> }`
// and update RequestingConcept to handle it.
//
// Let's implement the Sync.

export const DownloadProject: Sync = ({ projectId, token, userId, owner, request, path, stream }) => ({
    when: actions([
        Requesting.request,
        { path, method: "GET", accessToken: token },
        { request }
    ]),
    where: async (frames) => {
        // Parse path
        frames = frames.map(f => {
            const p = f[path] as string;
            if (!p) return null;
            // Pattern: /downloads/:projectId.zip
            const match = p.match(/^\/downloads\/([^\.]+)\.zip$/);
            if (match) {
                return { ...f, [projectId]: match[1] };
            }
            return null;
        }).filter(f => f !== null) as any;

        // Authenticate & Authorize
        // We verify the user owns the project being downloaded
        frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
        frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
        frames = frames.filter(f => f[userId] === f[owner]);

        // Fetch Stream
        // We can't call async methods easily inside `where` that return streams to bind to variables unless we wrap them.
        // We'll trust `where` can execute arbitrary async code.
        // We need to call Assembling.getFileStream(projectId)
        
        // Assembling is a concept instance. We can access it via the closure if we import it.
        // But `where` runs with `concepts` passed in? No, `where` in `sync.ts` runs on frames.
        // The `sync.ts` engine doesn't inject `concepts` into `where` automatically except via query.
        // But we imported `Assembling` at the top of this file. So we can use it directly if it's the instance.
        // Yes, `@concepts` exports instantiated concepts.

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
            stream: stream, // This needs Requesting to handle it
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": "attachment" // Browser trigger
            }
        }
    ])
});

export const syncs = [
  TriggerAssembly,
  TriggerAssemblyStarted,
  TriggerAssemblyFailed,
  AssemblySandboxStartup,
  AssemblySandboxComplete,
  AssemblySandboxError,
  DownloadProject,
];
