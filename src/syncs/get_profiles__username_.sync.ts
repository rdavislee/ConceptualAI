import { actions, Sync, Frames } from "@engine";
import { Requesting, Profiling } from "@concepts";

const PROFILE_PATH_REGEX = /^\/profiles\/([^\/]+)$/;

/**
 * SYNC: GetProfileByUsernameSuccess
 * Purpose: Retrieves a public profile by username and responds with 200.
 * Pattern: Self-Contained Read (GET)
 */
export const GetProfileByUsernameSuccess: Sync = ({ request, path, username, profile }) => ({
  when: actions([
    Requesting.request,
    // Rule 0: Include method. Rule 1: Use generic path for regex matching.
    { path, method: "GET" },
    { request },
  ]),
  where: async (frames) => {
    // 1. Extract username from path
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(PROFILE_PATH_REGEX);
      return match ? { ...f, [username]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Query profile
    frames = await frames.query(Profiling._getProfileByUsername, { username }, { profile });

    // 3. Filter for success and map to OpenAPI schema (Rule 6)
    return frames.map(f => {
      const p = f[profile] as any;
      if (!p) return null;

      // Mapping concept state to OpenAPI Profile schema
      const apiProfile = {
        _id: String(p._id),
        userId: String(p._id), // In Profiling, _id is the user ID
        username: p.username,
        displayName: p.name, // Concept 'name' -> API 'displayName'
        bio: p.bio,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      };

      return { ...f, [profile]: apiProfile };
    }).filter(f => f !== null) as any;
  },
  then: actions([
    Requesting.respond,
    { request, profile },
  ]),
});

/**
 * SYNC: GetProfileByUsernameNotFound
 * Purpose: Responds with 404 if the profile does not exist.
 */
export const GetProfileByUsernameNotFound: Sync = ({ request, path, username, profile }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET" },
    { request },
  ]),
  where: async (frames) => {
    // 1. Extract username from path
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(PROFILE_PATH_REGEX);
      return match ? { ...f, [username]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Query profile
    frames = await frames.query(Profiling._getProfileByUsername, { username }, { profile });

    // 3. Filter for Not Found
    return frames.filter(f => !f[profile]);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Profile not found" },
  ]),
});