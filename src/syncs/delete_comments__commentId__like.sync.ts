import { actions, Sync, Frames } from "@engine";
import { Liking, Sessioning, Commenting, Requesting, Paginating, db } from "@concepts";

const COMMENT_LIKE_PATH_REGEX = /^\/comments\/([^\/]+)\/like$/;

/**
 * UnlikeCommentRequest
 * Purpose: Authenticate user, verify comment exists, and trigger the unlike action.
 */
export const UnlikeCommentRequest: Sync = ({
  request,
  path,
  accessToken,
  commentId,
  userId,
  comment,
}) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Extract commentId from path
    frames = frames.map((f) => {
      const match = (f[path] as string).match(COMMENT_LIKE_PATH_REGEX);
      return match ? { ...f, [commentId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    if (frames.length === 0) return frames;

    // 2. Authenticate user
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user: userId });
    frames = frames.filter((f) => f[userId] !== undefined);

    // 3. Verify comment exists
    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    return frames.filter((f) => f[comment] !== null);
  },
  then: actions([
    Liking.unlike,
    { item: commentId, user: userId },
  ]),
});

/**
 * UnlikeCommentResponseSuccess
 * Purpose: Respond with the updated like count after successful unlike.
 */
export const UnlikeCommentResponseSuccess: Sync = ({
  request,
  path,
  commentId,
  likeCount,
}) => ({
  when: actions(
    [Requesting.request, { path, method: "DELETE" }, { request }],
    [Liking.unlike, {}, { ok: true }],
  ),
  where: async (frames) => {
    // Extract commentId to query count
    frames = frames.map((f) => {
      const match = (f[path] as string).match(COMMENT_LIKE_PATH_REGEX);
      return match ? { ...f, [commentId]: match[1] } : null;
    }).filter((f) => f !== null) as any;

    if (frames.length === 0) return frames;

    // Get updated count
    frames = await frames.query(Liking._countForItem, { item: commentId }, { n: likeCount });
    return frames;
  },
  then: actions([
    Requesting.respond,
    { request, likeCount, isLiked: false },
  ]),
});

/**
 * UpdateCommentScoreOnUnlike
 * Purpose: Update pagination score when a comment is unliked.
 */
export const UpdateCommentScoreOnUnlike: Sync = ({ commentId, likeCount, comment, postId }) => ({
  when: actions(
    [Liking.unlike, { item: commentId }, { ok: true }],
  ),
  where: async (frames) => {
    // 1. Get updated count
    frames = await frames.query(Liking._countForItem, { item: commentId }, { n: likeCount });
    // 2. Get comment to find the postId (the bound for pagination)
    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    return frames.map(f => {
      const c = f[comment] as any;
      return c ? { ...f, [postId]: c.item } : null;
    }).filter(f => f !== null) as any;
  },
  then: actions([
    Paginating.setEntryScore,
    { bound: postId, itemType: "comments", item: commentId, score: likeCount, mode: "score" },
  ]),
});

/**
 * UnlikeCommentResponseError
 * Purpose: Handle errors from the unlike action.
 */
export const UnlikeCommentResponseError: Sync = ({ request, path, error }) => ({
  when: actions(
    [Requesting.request, { path, method: "DELETE" }, { request }],
    [Liking.unlike, {}, { error }],
  ),
  where: async (frames) => {
    return frames.filter((f) => COMMENT_LIKE_PATH_REGEX.test(f[path] as string));
  },
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});

/**
 * UnlikeCommentAuthError
 * Purpose: Handle unauthorized requests with invalid token.
 */
export const UnlikeCommentAuthError: Sync = ({ request, path, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter((f) => COMMENT_LIKE_PATH_REGEX.test(f[path] as string));
    if (frames.length === 0) return frames;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, error: "Unauthorized", statusCode: 401 },
  ]),
});

/**
 * UnlikeCommentMissingToken
 * Purpose: Handle requests where accessToken is missing.
 */
export const UnlikeCommentMissingToken: Sync = ({ request, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE" },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter((f) => COMMENT_LIKE_PATH_REGEX.test(f[path] as string));
    if (frames.length === 0) return frames;

    const requests = db.collection<any>("Requesting.requests");
    const newFrames = await Promise.all(frames.map(async f => {
      const req = await requests.findOne({ _id: f[request] });
      return req?.input?.accessToken === undefined ? f : null;
    }));
    return new Frames(...newFrames.filter(f => f !== null));
  },
  then: actions([
    Requesting.respond,
    { request, error: "Unauthorized", statusCode: 401 },
  ]),
});

/**
 * UnlikeCommentNotFound
 * Purpose: Handle requests for non-existent comments.
 */
export const UnlikeCommentNotFound: Sync = ({ request, path, accessToken, commentId, comment, userId }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map((f) => {
      const match = (f[path] as string).match(COMMENT_LIKE_PATH_REGEX);
      return match ? { ...f, [commentId]: match[1] } : null;
    }).filter((f) => f !== null) as any;
    if (frames.length === 0) return frames;

    // Auth check
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    // Check if comment exists
    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    return frames.filter((f) => f[comment] === null);
  },
  then: actions([
    Requesting.respond,
    { request, error: "Comment not found", statusCode: 404 },
  ]),
});