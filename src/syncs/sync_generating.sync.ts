import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning, Planning, ConceptDesigning, Implementing, SyncGenerating } from "@concepts";

export const TriggerSyncGeneration: Sync = ({ projectId, plan, design, implementations, token, userId, owner, request, path, projectDoc, conceptSpecs }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    // Parse path to extract projectId
    frames = frames.map(f => {
        const p = f[path] as string;
        if (!p) return null;
        const match = p.match(/^\/projects\/([^\/]+)\/syncs$/);
        if (match) {
            return { ...f, [projectId]: match[1] };
        }
        return null;
    }).filter(f => f !== null) as any;

    // Authenticate
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
    
    // Authorization: Check if user owns the project
    frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
    
    // Ensure user owns project
    frames = frames.filter(f => f[userId] === f[owner]);

    // Check Project Status
    // We only allow sync generation if status is 'implemented'
    frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectDoc });
    frames = frames.filter(f => {
        const p = f[projectDoc] as any;
        return p && p.status === "implemented";
    });

    // Fetch Plan
    frames = await frames.query(Planning._getPlan, { project: projectId }, { plan });
    // Filter out if no plan (or plan not complete)
    frames = frames.filter(f => {
        const p = f[plan] as any;
        if (p && p.plan) { // PlanDoc structure has nested 'plan'
             return true;
        }
        return false;
    }).map(f => ({...f, [plan]: (f[plan] as any).plan }));

    // Fetch Design (We don't strictly need it for generate() call but good to verify integrity? Actually generate() needs conceptSpecs which come from Implementations, but maybe design helps? The generate method signature only asks for plan and implementations.)
    // Actually, looking at `SyncGeneratingConcept.generate`, it takes `plan` and `implementations`.
    // It constructs `conceptSpecs` internally or expects it passed?
    // Wait, `SyncGeneratingConcept.generate` signature is:
    // generate({ project, plan, conceptSpecs, implementations })
    // So we need to construct `conceptSpecs` string here?
    // Or we can pass implementations and let the concept handle it?
    // The concept's `generate` method takes `conceptSpecs` as a string.
    // So we need to fetch implementations, extract specs, and concat them.
    // Syncs can't easily do string concatenation loops on complex objects in the `where` clause cleanly.
    // However, `SyncGeneratingConcept.generate` is the one calling the agent.
    // The `SyncGeneratingConcept.generate` method in the class takes `conceptSpecs`.
    // But `ImplementingConcept` stores specs inside implementations.
    // Let's look at `manual_test_full_flow.ts`. It constructs the string.
    // "Prepare concept specs string for the agent"
    
    // Ideally, the `SyncGeneratingConcept` should handle this preparation if it's purely mechanical from the inputs.
    // But the current implementation of `SyncGeneratingConcept.generate` expects the string.
    // I should probably update `SyncGeneratingConcept.ts` to optionally take raw implementations and build the string itself, 
    // OR I have to do it in the Sync `where` clause (which is JS, so it's fine).
    
    // Let's fetch implementations.
    frames = await frames.query(Implementing._getImplementations, { project: projectId }, { implementations });
    
    return frames.map(f => {
        const impls = f[implementations] as any;
        if (!impls || Object.keys(impls).length === 0) return null;
        
        let specs = "";
        for (const [name, impl] of Object.entries(impls)) {
            specs += `--- CONCEPT: ${name} ---\n${(impl as any).spec}\n\n`;
        }
        
        // Bind the computed string to a new variable name 'conceptSpecs'
        // We need to define this variable in the Sync arguments above if we want TS to be happy,
        // but for now we just attach it to the frame.
        // To reference it in 'then', we need it in the frame.
        return { ...f, [conceptSpecs]: specs }; 
    }).filter(f => f !== null) as any;
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "sync_generating" }],
    [SyncGenerating.generate, { project: projectId, plan, conceptSpecs, implementations }]
  ),
});

export const SyncGenerationComplete: Sync = ({ projectId, apiDefinition, endpointBundles, request, path }) => ({
  when: actions(
    // The generation action completes
    [SyncGenerating.generate, { project: projectId }, { apiDefinition, endpointBundles }],
    // AND we have the original request frame in context
    [Requesting.request, { path }, { request }]
  ),
  where: async (frames) => {
      // Ensure the request path corresponds to this sync job
      return frames.filter(f => {
          const p = f[path] as string;
          const pid = f[projectId] as string;
          return p === `/projects/${pid}/syncs`;
      });
  },
  then: actions(
    [ProjectLedger.updateStatus, { project: projectId, status: "syncs_generated" }],
    [Requesting.respond, { request, status: "complete", apiDefinition, endpointBundles }]
  )
});

export const GetSyncs: Sync = ({ projectId, syncs, apiDefinition, endpointBundles, token, userId, owner, request, path }) => ({
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
            const match = p.match(/^\/projects\/([^\/]+)\/syncs$/);
            if (match) {
                return { ...f, [projectId]: match[1] };
            }
            return null;
        }).filter(f => f !== null) as any;

        // Authenticate
        frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });
        
        // Authorize
        frames = await frames.query(ProjectLedger._getOwner, { project: projectId }, { owner });
        frames = frames.filter(f => f[userId] === f[owner]);

        // Fetch Syncs
        frames = await frames.query(SyncGenerating._getSyncs, { project: projectId }, { syncs, apiDefinition, endpointBundles });
        
        // Ensure syncs exist
        return frames.filter(f => f[syncs]);
    },
    then: actions([
        Requesting.respond,
        { request, syncs, apiDefinition, endpointBundles }
    ])
});

export const syncs = [TriggerSyncGeneration, SyncGenerationComplete, GetSyncs];
