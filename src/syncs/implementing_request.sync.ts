import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning, Sandboxing, ConceptDesigning } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

/**
 * TriggerImplementation - Gateway side.
 * Provisions a sandbox to handle the implementation phase.
 */
export const TriggerImplementation: Sync = ({ projectId, token, userId, owner, request, path, projectName, projectDescription, geminiKey, projectDoc }) => {
  const designDoc = Symbol("designDoc");
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
          const match = p.match(/^\/projects\/([^\/]+)\/implement$/);
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
          return p && p.status === "design_complete";
      });

      // Verify Design exists
      frames = await frames.query(ConceptDesigning._getDesign, { project: projectId }, { design: designDoc });
      frames = frames.filter(f => f[designDoc] !== undefined);

      const envKey = Deno.env.get("GEMINI_API_KEY");
      return frames.map(f => {
          const p = f[projectDoc] as any;
          return {
              ...f,
              [projectName]: p.name,
              [projectDescription]: p.description,
              [geminiKey]: f[geminiKey] || envKey
          };
      });
    },
    then: actions(
      [ProjectLedger.updateStatus, { project: projectId, status: "implementing" }],
      [Sandboxing.provision, { userId, apiKey: geminiKey, projectId, name: projectName, description: projectDescription, mode: "implementing" }],
      [Requesting.respond, { request, project: projectId, status: "implementing_started" }],
    ),
  };
};

export const syncs = [TriggerImplementation];
