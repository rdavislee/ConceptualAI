import { actions, Sync } from "@engine";
import { Requesting, Sessioning, Liking, Paginating } from "@concepts";

// Regex to extract postId from /posts/{postId}/like
const UNLIKE_POST_PATH_REGEX = /^\/posts\/([^\/]+)\/like$/;

/**
 * SYNC 1: UnlikePostRequest
 * Purpose: Authenticate and trigger the unlike action.
 */
export const UnlikePostRequest: Sync = ({ request, accessToken, user, postId, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Extract postId from path
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(UNLIKE_POST_PATH_REGEX);
      return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    return frames.filter(f => f[user] !== undefined);
  },
  then: actions([
    Liking.unlike,
    { item: postId, user },
  ]),
});

/**
 * SYNC 2: UnlikePostSuccess
 * Purpose: Update pagination score and respond with new state.
 */
export const UnlikePostSuccess: Sync = ({ request, path, postId, likeCount }) => ({
  when: actions(
    // Bind path here so we can validate it in where
    [Requesting.request, { path, method: "DELETE" }, { request }],
    [Liking.unlike, {}, {}], // Success = no error
  ),
  where: async (frames) => {
    // 1. Validate Path & Extract postId
    // This prevents collision with other unlike endpoints (e.g. comments)
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(UNLIKE_POST_PATH_REGEX);
      return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Get the new like count
    frames = await frames.query(Liking._countForItem, { item: postId }, { n: likeCount });
    return frames;
  },
  then: actions(
    // Side effect: Update the score in the global feed
    [Paginating.setEntryScore, { bound: "common", itemType: "posts", item: postId, score: likeCount, mode: "score" }],
    // Respond to client
    [Requesting.respond, { request, likeCount, isLiked: false }]
  ),
});

/**
 * SYNC 3: UnlikePostError
 * Purpose: Handle errors (e.g., not liked yet).
 */
export const UnlikePostError: Sync = ({ request, path, error }) => ({
  when: actions(
    [Requesting.request, { path, method: "DELETE" }, { request }],
    [Liking.unlike, {}, { error }],
  ),
  where: async (frames) => {
    // Filter by path pattern to ensure we only catch errors for this specific endpoint
    return frames.filter(f => UNLIKE_POST_PATH_REGEX.test(f[path] as string));
  },
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});

/**
 * SYNC 4: UnlikePostAuthError
 * Purpose: Handle invalid tokens.
 */
export const UnlikePostAuthError: Sync = ({ request, accessToken, error, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Filter for this endpoint
    frames = frames.filter(f => UNLIKE_POST_PATH_REGEX.test(f[path] as string));
    if (frames.length === 0) return frames;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});