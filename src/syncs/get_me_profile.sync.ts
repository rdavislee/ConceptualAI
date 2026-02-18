import { actions, Sync, Frames } from "@engine";
import { Requesting, Sessioning, Profiling } from "@concepts";

/**
 * GET /me/profile - Success Case
 * Retrieves the authenticated user's profile and maps fields to match OpenAPI spec.
 */
export const GetMeProfileSuccess: Sync = ({ request, accessToken, user, profile }) => ({
  when: actions([
    Requesting.request,
    { path: "/me/profile", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter((f) => f[user] !== undefined);

    // 2. Fetch Profile
    frames = await frames.query(Profiling._getProfile, { user }, { profile });

    // 3. Map fields for OpenAPI compliance and filter for existence
    const mappedFrames = frames.map((f) => {
      const p = f[profile] as any;
      if (!p) return null;

      return {
        ...f,
        [profile]: {
          _id: p._id,
          userId: p._id, // Profiling uses User ID as document _id
          username: p.username,
          displayName: p.name, // Map 'name' to 'displayName'
          bio: p.bio,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        },
      };
    }).filter((f) => f !== null);

    return new Frames(...mappedFrames);
  },
  then: actions([
    Requesting.respond,
    { request, profile },
  ]),
});

/**
 * GET /me/profile - Not Found Case (404)
 * Triggered when a user is authenticated but hasn't created a profile yet.
 */
export const GetMeProfileNotFound: Sync = ({ request, accessToken, user, profile }) => ({
  when: actions([
    Requesting.request,
    { path: "/me/profile", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter((f) => f[user] !== undefined);

    // 2. Check Profile existence
    frames = await frames.query(Profiling._getProfile, { user }, { profile });

    // 3. Filter for null profile
    return frames.filter((f) => f[profile] === null);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Profile not yet created" },
  ]),
});

/**
 * GET /me/profile - Auth Error Case (401)
 */
export const GetMeProfileAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/me/profile", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});