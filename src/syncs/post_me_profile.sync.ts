import { actions, Frames, Sync } from "@engine";
import { Profiling, Sessioning, Requesting, db } from "@concepts";

/**
 * SYNC 1: CreateProfileRequest
 * Purpose: Authenticate user and trigger profile creation.
 */
export const CreateProfileRequest: Sync = ({ 
  request, accessToken, user, username, displayName, bio, bioImageUrl 
}) => ({
  when: actions([
    Requesting.request,
    // Only include guaranteed required fields
    { path: "/me/profile", method: "POST", accessToken, username, displayName },
    { request }
  ]),
  where: async (frames) => {
    // 1. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 2. Extract optional fields safely from the request document
    const requests = db.collection<any>("Requesting.requests");
    const reqs = await Promise.all(frames.map(f => requests.findOne({ _id: f[request] })));
    
    return frames.map((f, i) => {
      const req = reqs[i];
      if (!req) return null;
      return {
        ...f,
        [bio]: req.input.bio || "",
        [bioImageUrl]: req.input.bioImageUrl || ""
      };
    }).filter(f => f !== null) as any;
  },
  then: actions([
    Profiling.createProfile,
    { user, username, name: displayName, bio, bioImageUrl }
  ]),
});

/**
 * SYNC 2: CreateProfileResponseSuccess
 * Purpose: Respond with the hydrated profile object on success.
 */
export const CreateProfileResponseSuccess: Sync = ({ request, user, profile }) => ({
  when: actions(
    [Requesting.request, { path: "/me/profile", method: "POST" }, { request }],
    [Profiling.createProfile, { user }, { ok: true }]
  ),
  where: async (frames) => {
    // Fetch the created profile for hydration
    frames = await frames.query(Profiling._getProfile, { user }, { profile });
    
    return frames.map(f => {
      const p = f[profile] as any;
      if (!p) return null;

      // MAP ID and Fields for OpenAPI compliance
      // OpenAPI: { _id, userId, username, displayName, bio, createdAt, updatedAt }
      return {
        ...f,
        [profile]: {
          _id: String(p._id),
          userId: String(p._id), // In Profiling concept, _id is the User ID
          username: p.username,
          displayName: p.name,   // Map concept 'name' to API 'displayName'
          bio: p.bio,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt
        }
      };
    }).filter(f => f !== null) as any;
  },
  then: actions([
    Requesting.respond,
    { request, profile, statusCode: 201 }
  ]),
});

/**
 * SYNC 3: CreateProfileResponseErrorExists
 * Purpose: Handle Profile already exists error (403).
 */
export const CreateProfileResponseErrorExists: Sync = ({ request }) => ({
  when: actions(
    [Requesting.request, { path: "/me/profile", method: "POST" }, { request }],
    [Profiling.createProfile, {}, { error: "Profile already exists" }]
  ),
  then: actions([
    Requesting.respond,
    { request, error: "Profile already exists", statusCode: 403 }
  ]),
});

/**
 * SYNC 4: CreateProfileResponseErrorTaken
 * Purpose: Handle Username taken error (400).
 */
export const CreateProfileResponseErrorTaken: Sync = ({ request }) => ({
  when: actions(
    [Requesting.request, { path: "/me/profile", method: "POST" }, { request }],
    [Profiling.createProfile, {}, { error: "Username already taken" }]
  ),
  then: actions([
    Requesting.respond,
    { request, error: "Username already taken", statusCode: 400 }
  ]),
});

/**
 * SYNC 5: CreateProfileAuthErrorInvalid
 * Purpose: Handle invalid authentication token. Binds accessToken in 'when' to avoid redaction.
 */
export const CreateProfileAuthErrorInvalid: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/me/profile", method: "POST", accessToken },
    { request }
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined) as any;
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" }
  ]),
});

/**
 * SYNC 6: CreateProfileAuthErrorMissing
 * Purpose: Handle missing authentication token.
 */
export const CreateProfileAuthErrorMissing: Sync = ({ request }) => ({
  when: actions([
    Requesting.request,
    { path: "/me/profile", method: "POST" },
    { request }
  ]),
  where: async (frames) => {
    const requests = db.collection<any>("Requesting.requests");
    const reqs = await Promise.all(frames.map(f => requests.findOne({ _id: f[request] })));
    return frames.filter((f, i) => {
      const req = reqs[i];
      return !req?.input.accessToken;
    }) as any;
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" }
  ]),
});

/**
 * SYNC 7: CreateProfileValidationError
 * Purpose: Handle missing required fields (username, displayName).
 */
export const CreateProfileValidationError: Sync = ({ request }) => ({
  when: actions([
    Requesting.request,
    { path: "/me/profile", method: "POST" },
    { request }
  ]),
  where: async (frames) => {
    const requests = db.collection<any>("Requesting.requests");
    const reqs = await Promise.all(frames.map(f => requests.findOne({ _id: f[request] })));
    return frames.filter((f, i) => {
      const req = reqs[i];
      // Only fire if accessToken is present (otherwise AuthErrorMissing handles it)
      return req?.input.accessToken && (!req?.input.username || !req?.input.displayName);
    }) as any;
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 400, error: "Missing required fields: username and displayName" }
  ]),
});
