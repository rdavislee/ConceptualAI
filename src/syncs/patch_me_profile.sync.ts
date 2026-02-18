import { actions, Sync, Frames } from "@engine";
import { Requesting, Sessioning, Profiling, db } from "@concepts";

/**
 * SYNC 1: UpdateProfileRequest
 * Purpose: Authenticate user and trigger the profile update action.
 */
export const UpdateProfileRequest: Sync = ({
  request,
  accessToken,
  user,
  profile,
  username,
  displayName,
  bio,
}) => ({
  when: actions([
    Requesting.request,
    // accessToken is required for this authenticated endpoint
    { path: "/me/profile", method: "PATCH", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Authenticate user
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter((f) => f[user] !== undefined);

    // 2. Fetch current profile to handle partial updates and avoid unbound symbols
    frames = await frames.query(Profiling._getProfile, { user }, { profile });

    // 3. Extract optional fields from the request body
    const requests = db.collection<any>("Requesting.requests");
    const newFrames = await Promise.all(frames.map(async (f) => {
      const req = await requests.findOne({ _id: f[request] });
      if (!req) return null;

      const input = req.input;

      // Ensure at least one field is provided for update (Rule 6)
      if (input.username === undefined && input.displayName === undefined && input.bio === undefined) {
        return null;
      }

      const current = (f[profile] as any) || {};

      return {
        ...f,
        // Map API 'displayName' to Concept 'name'
        // Use current value if not provided in input to avoid 'undefined' bindings
        [username]: input.username ?? current.username,
        [displayName]: input.displayName ?? current.name,
        [bio]: input.bio ?? current.bio,
      };
    }));

    return new Frames(...newFrames.filter((f) => f !== null) as any);
  },
  then: actions([
    Profiling.updateProfile,
    { user, username, name: displayName, bio },
  ]),
});

/**
 * SYNC 1.5: UpdateProfileNoFieldsError
 * Purpose: Respond with 400 if no update fields are provided.
 */
export const UpdateProfileNoFieldsError: Sync = ({ request, accessToken, user }) => ({
  when: actions([
    Requesting.request,
    { path: "/me/profile", method: "PATCH", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Authenticate user (401 takes precedence over 400)
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter((f) => f[user] !== undefined);

    // 2. Check for empty request body
    const requests = db.collection<any>("Requesting.requests");
    const newFrames = await Promise.all(frames.map(async (f) => {
      const req = await requests.findOne({ _id: f[request] });
      if (!req) return null;

      const input = req.input;
      const noFields = input.username === undefined && input.displayName === undefined && input.bio === undefined;
      return noFields ? f : null;
    }));

    return new Frames(...newFrames.filter((f) => f !== null) as any);
  },
  then: actions([
    Requesting.respond,
    { request, error: "No fields provided for update", statusCode: 400 },
  ]),
});

/**
 * SYNC 2: UpdateProfileResponseSuccess
 * Purpose: Respond with the updated profile on success.
 */
export const UpdateProfileResponseSuccess: Sync = ({
  request,
  user,
  profile,
}) => ({
  when: actions(
    [Requesting.request, { path: "/me/profile", method: "PATCH" }, { request }],
    [Profiling.updateProfile, { user }, { ok: true }],
  ),
  where: async (frames) => {
    // Fetch the updated profile to return in the response
    frames = await frames.query(Profiling._getProfile, { user }, { profile });
    return frames.map((f) => {
      const p = f[profile] as any;
      if (!p) return null;

      // Map Concept fields to OpenAPI Schema
      // Profiling uses User ID as the _id of the profile
      return {
        ...f,
        [profile]: {
          _id: p._id,
          userId: p._id,
          username: p.username,
          displayName: p.name,
          bio: p.bio,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        },
      };
    }).filter((f) => f !== null) as any;
  },
  then: actions([
    Requesting.respond,
    { request, profile },
  ]),
});

/**
 * SYNC 3: UpdateProfileResponseError
 * Purpose: Respond with error if the update action fails.
 */
export const UpdateProfileResponseError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/me/profile", method: "PATCH" }, { request }],
    [Profiling.updateProfile, {}, { error }],
  ),
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});

/**
 * SYNC 4: UpdateProfileAuthError
 * Purpose: Respond with 401 if authentication fails.
 */
export const UpdateProfileAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/me/profile", method: "PATCH", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, error: "Unauthorized", statusCode: 401 },
  ]),
});