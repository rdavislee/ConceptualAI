import { actions, Sync } from "@engine";
import { Requesting, Sessioning, Liking, Commenting } from "@concepts";

const COMMENT_LIKE_PATH_REGEX = /^\/comments\/([^\/]+)\/like$/;

/**
 * SYNC 1: LikeCommentRequest
 * Purpose: Authenticate, verify comment existence, and trigger like action.
 */
export const LikeCommentRequest: Sync = ({ request, accessToken, user, commentId, path, comment }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Parse commentId from path
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(COMMENT_LIKE_PATH_REGEX);
      return match ? { ...f, [commentId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 3. Verify Comment Exists
    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    return frames.filter(f => f[comment] !== null);
  },
  then: actions([
    Liking.like,
    { item: commentId, user },
  ]),
});

/**
 * SYNC 2: LikeCommentResponseSuccess
 * Purpose: Respond with updated like count and status.
 */
export const LikeCommentResponseSuccess: Sync = ({ request, path, commentId, user, accessToken, count, liked }) => ({
  when: actions(
    [Requesting.request, { path, method: "POST", accessToken }, { request }],
    [Liking.like, {}, { ok: true }],
  ),
  where: async (frames) => {
    // 1. Parse commentId again for the response context
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(COMMENT_LIKE_PATH_REGEX);
      return match ? { ...f, [commentId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Get User (needed for _isLiked check)
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });

        // 3. Fetch updated count
    frames = await frames.query(Liking._countForItem, { item: commentId }, { n: count });

    // 4. Fetch isLiked status
    frames = await frames.query(Liking._isLiked, { item: commentId, user }, { liked });

    return frames;
  },
  then: actions([
    Requesting.respond,
    { request, likeCount: count, isLiked: liked },
  ]),
});

/**
 * SYNC 3: LikeCommentResponseError
 * Purpose: Handle errors (e.g., already liked).
 */
export const LikeCommentResponseError: Sync = ({ request, error, path }) => ({
  when: actions(
    [Requesting.request, { path, method: "POST" }, { request }],
    [Liking.like, {}, { error }],
  ),
  where: async (frames) => {
    return frames.filter(f => COMMENT_LIKE_PATH_REGEX.test(f[path] as string));
  },
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});

/**
 * SYNC 4: LikeCommentAuthError
 * Purpose: Handle authentication failures.
 */
export const LikeCommentAuthError: Sync = ({ request, accessToken, error, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Filter for relevant path first
    frames = frames.filter(f => COMMENT_LIKE_PATH_REGEX.test(f[path] as string));
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
 * SYNC 5: LikeCommentNotFound
 * Purpose: Handle case where comment does not exist.
 */
export const LikeCommentNotFound: Sync = ({ request, accessToken, user, commentId, path, comment }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(COMMENT_LIKE_PATH_REGEX);
      return match ? { ...f, [commentId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    return frames.filter(f => !f[comment]);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Comment not found" },
  ]),
});