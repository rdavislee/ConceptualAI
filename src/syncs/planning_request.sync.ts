import { actions, Sync } from "@engine";
import { Requesting, Sandboxing, Sessioning, ProjectLedger, Planning } from "@concepts";
import { freshID } from "@utils/database.ts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

/**
 * PlanningRequest - Catch the initial planning request on the Gateway.
 * Provisions a sandbox and creates a project record.
 */
export const PlanningRequest: Sync = ({ name, description, token, userId, projectId, request, geminiKey }) => ({
  when: actions([
    Requesting.request,
    { path: "/projects", method: "POST", name, description, accessToken: token },
    { request },
  ]),
  where: async (frames) => {
    if (IS_SANDBOX) return [];

    // Authenticate user
    frames = await frames.query(Sessioning._getUser, { session: token }, { user: userId });

    // Filter out unauthorized requests
    frames = frames.filter(f => f[userId] !== undefined);

    // Bind a fresh project ID (gateway side) and get GEMINI_API_KEY from env
    const envKey = Deno.env.get("GEMINI_API_KEY");
    return frames.map(f => ({
      ...f,
      [projectId]: freshID(),
      [geminiKey]: f[geminiKey] || envKey
    }));
  },
  then: actions(
    [ProjectLedger.create, { owner: userId, project: projectId, name, description }],
    [Sandboxing.provision, { userId, apiKey: geminiKey, projectId, name, description, mode: "planning" }],
    [Requesting.respond, { request, project: projectId, status: "planning_started" }],
  ),
});

/**
 * UserModifiesPlanRequest - Gateway side.
 * Provisions a sandbox to handle plan modification.
 */
export const UserModifiesPlanRequest: Sync = ({ projectId, feedback, token, userId, owner, request, path, projectName, projectDescription, geminiKey }) => {
  const doc = Symbol("doc");
  return {
    when: actions([
      Requesting.request,
      { path, method: "PUT", feedback, accessToken: token },
      { request },
    ]),
    where: async (frames) => {
      if (IS_SANDBOX) return [];

      // Parse path to extract projectId
      frames = frames.map(f => {
          const p = f[path] as string;
          if (!p) return null;
          const match = p.match(/^\/projects\/([^\/]+)\/plan$/);
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

      // Get project context for sandbox
      frames = await frames.query(ProjectLedger._getProject, { project: projectId }, { project: doc });

      const envKey = Deno.env.get("GEMINI_API_KEY");
      return frames.map(f => {
          const p = f[doc] as any;
          if (!p) return null;
          return {
              ...f,
              [projectName]: p.name,
              [projectDescription]: p.description,
              [geminiKey]: f[geminiKey] || envKey
          };
      }).filter(f => f !== null) as any;
    },
    then: actions(
      [ProjectLedger.updateStatus, { project: projectId, status: "planning" }],
      [Sandboxing.provision, { userId, apiKey: geminiKey, projectId, name: projectName, description: projectDescription, mode: "planning", feedback }],
      [Requesting.respond, { request, project: projectId, status: "planning_started" }],
    ),
  };
};
