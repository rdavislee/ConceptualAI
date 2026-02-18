import { actions, Sync } from "@engine";
import { Requesting, Sessioning, Posting, Liking, Paginating } from "@concepts";

const LIKE_PATH_REGEX = /^\/posts\/([^\/]+)\/like$/;

/**
 * SYNC 1: LikePostRequest
 * Purpose: Authenticate, validate prerequisites, and trigger like action.
 */
export const LikePostRequest: Sync = ({ request, accessToken, user, postId, path, post, liked }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Parse postId from path
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(LIKE_PATH_REGEX);
      return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 3. Check Post Existence
    frames = await frames.query(Posting._getPost, { postId }, { post });
    frames = frames.filter(f => f[post] !== null);

    // 4. Check if Already Liked (Prerequisite: MUST NOT be liked)
    frames = await frames.query(Liking._isLiked, { item: postId, user }, { liked });
    // Keep only if NOT liked (liked === false)
    return frames.filter(f => f[liked] === false);
  },
  then: actions([
    Liking.like,
    { item: postId, user },
  ]),
});

/**
 * SYNC 2: LikePostUpdateScore
 * Purpose: When like succeeds, update the score in Paginating.
 */
export const LikePostUpdateScore: Sync = ({ request, postId, count }) => ({
  when: actions(
    [Requesting.request, { method: "POST" }, { request }],
    [Liking.like, { item: postId }, { ok: true }],
  ),
  where: async (frames) => {
    // Get new count to update score
    frames = await frames.query(Liking._countForItem, { item: postId }, { n: count });
    return frames;
  },
  then: actions([
    Paginating.setEntryScore,
    { bound: "common", itemType: "posts", item: postId, score: count },
  ]),
});

/**
 * SYNC 3: LikePostRespond
 * Purpose: When score update succeeds (chain complete), respond to client.
 */
export const LikePostRespond: Sync = ({ request, postId, count }) => ({
  when: actions(
    [Requesting.request, { method: "POST" }, { request }],
    // We match the score update to ensure the whole chain finished
    [Paginating.setEntryScore, { item: postId }, { ok: true }],
  ),
  where: async (frames) => {
    // Fetch count again for the response (or could have passed it through if engine supported it easily)
    frames = await frames.query(Liking._countForItem, { item: postId }, { n: count });
    return frames;
  },
  then: actions([
    Requesting.respond,
    { request, likeCount: count, isLiked: true },
  ]),
});

/**
 * SYNC 4: LikePostAlreadyLikedError
 * Purpose: Respond 400 if user has already liked the post.
 */
export const LikePostAlreadyLikedError: Sync = ({ request, accessToken, user, postId, path, post, liked }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(LIKE_PATH_REGEX);
      return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    frames = await frames.query(Posting._getPost, { postId }, { post });
    frames = frames.filter(f => f[post] !== null);

    frames = await frames.query(Liking._isLiked, { item: postId, user }, { liked });
    // Filter for ALREADY LIKED
    return frames.filter(f => f[liked] === true);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 400, error: "Already liked" },
  ]),
});

/**
 * SYNC 5: LikePostNotFoundError
 * Purpose: Respond 404 if post does not exist.
 */
export const LikePostNotFoundError: Sync = ({ request, accessToken, user, postId, path, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(LIKE_PATH_REGEX);
      return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    frames = await frames.query(Posting._getPost, { postId }, { post });
    // Filter for NOT FOUND
    return frames.filter(f => f[post] === null);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Post not found" },
  ]),
});

/**
 * SYNC 6: LikePostAuthError
 * Purpose: Respond 401 if unauthorized.
 */
export const LikePostAuthError: Sync = ({ request, accessToken, error, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter(f => LIKE_PATH_REGEX.test(f[path] as string));
    if (frames.length === 0) return frames;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});

/**
 * SYNC 7: LikePostActionError
 * Purpose: Catch-all for Liking.like failures (e.g. race conditions).
 */
export const LikePostActionError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { method: "POST" }, { request }],
    [Liking.like, {}, { error }],
  ),
  where: async (frames) => {
      // Ensure this error corresponds to a like request
      // We can't strictly check path here easily without re-parsing, 
      // but since the action is Liking.like, it's specific enough for this context.
      return frames;
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 400, error },
  ]),
});