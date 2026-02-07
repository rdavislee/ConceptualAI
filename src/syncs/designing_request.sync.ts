import { actions, Sync } from "@engine";
import { ProjectLedger, Requesting, Sessioning, Sandboxing } from "@concepts";

const IS_SANDBOX = Deno.env.get("SANDBOX") === "true";

/**
 * TriggerDesign - Gateway side.
 * Provisions a sandbox to handle the design phase.
 */
export const TriggerDesign: Sync = ({ projectId, token, userId, owner, request, path, projectName, projectDescription, geminiKey }) => {
  const doc = Symbol("doc");
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
          const match = p.match(/^\/projects\/([^\/]+)\/design$/);
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
      [ProjectLedger.updateStatus, { project: projectId, status: "designing" }],
      [Sandboxing.provision, { userId, apiKey: geminiKey, projectId, name: projectName, description: projectDescription, mode: "designing" }],
      [Requesting.respond, { request, project: projectId, status: "designing_started" }],
    ),
  };
};

/**
 * UserModifiesDesign - Gateway side.
 * Provisions a sandbox to handle the design modification phase.
 */
export const UserModifiesDesign: Sync = ({ projectId, token, userId, owner, request, path, projectName, projectDescription, geminiKey, feedback }) => {
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
          const match = p.match(/^\/projects\/([^\/]+)\/design$/);
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
      [ProjectLedger.updateStatus, { project: projectId, status: "designing" }],
      [Sandboxing.provision, { userId, apiKey: geminiKey, projectId, name: projectName, description: projectDescription, mode: "designing", feedback }],
      [Requesting.respond, { request, project: projectId, status: "designing_started" }],
    ),
  };
};
