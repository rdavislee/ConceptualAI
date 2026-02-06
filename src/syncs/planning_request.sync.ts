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
    [Sandboxing.provision, { userId, apiKey: geminiKey, projectId, name, description }],
    [Requesting.respond, { request, project: projectId, status: "planning_started" }],
  ),
});
