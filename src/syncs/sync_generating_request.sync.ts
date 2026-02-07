import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning, Sandboxing, Planning, Implementing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

/**
 * TriggerSyncGeneration - Gateway side.
 * Provisions a sandbox to handle the sync generation phase.
 */
export const TriggerSyncGeneration: Sync = ({ projectId, plan, implementations, token, userId, owner, request, path, projectDoc, conceptSpecs, projectName, projectDescription, geminiKey }) => {
  return {
    when: actions([
      Requesting.request,
      { path, method: "POST", accessToken: token },
      { request },
    ]),
    where: async (frames) => {
      if (IS_SANDBOX) return [];

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
      frames = frames.filter(f => f[userId] === f[owner]);

      // Check Project Status
      frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: projectDoc });
      frames = frames.filter(f => {
          const p = f[projectDoc] as any;
          return p && (p.status === "implemented" || p.status === "syncs_generated");
      });

      // Fetch Plan
      frames = await frames.query(Planning._getPlan, { project: projectId }, { plan });
      frames = frames.filter(f => {
          const p = (f[plan] as any)?.plan;
          return p !== undefined;
      });

      // Fetch Implementations and build conceptSpecs
      frames = await frames.query(Implementing._getImplementations, { project: projectId }, { implementations });

      const envKey = Deno.env.get("GEMINI_API_KEY");
      return frames.map(f => {
          const impls = f[implementations] as any;
          if (!impls || Object.keys(impls).length === 0) return null;

          let specs = "";
          for (const [name, impl] of Object.entries(impls)) {
              specs += `--- CONCEPT: ${name} ---\n${(impl as any).spec}\n\n`;
          }

          const p = f[projectDoc] as any;
          return {
              ...f,
              [conceptSpecs]: specs,
              [projectName]: p.name,
              [projectDescription]: p.description,
              [geminiKey]: f[geminiKey] || envKey
          };
      }).filter(f => f !== null) as any;
    },
    then: actions(
      [ProjectLedger.updateStatus, { project: projectId, status: "sync_generating" }],
      [Sandboxing.provision, { userId, apiKey: geminiKey, projectId, name: projectName, description: projectDescription, mode: "syncgenerating" }],
      [Requesting.respond, { request, project: projectId, status: "sync_generation_started" }],
    ),
  };
};

export const syncs = [TriggerSyncGeneration];
