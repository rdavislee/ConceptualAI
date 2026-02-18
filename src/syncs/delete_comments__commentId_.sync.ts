import { actions, Sync, Frames } from "@engine";
import { Commenting, Liking, Paginating, Requesting, Sessioning } from "@concepts";

const COMMENT_PATH_REGEX = /^\/comments\/([^\/]+)$/;

/**
 * SYNC: DeleteCommentRequest
 * Purpose: Authenticate and trigger comment deletion.
 */
export const DeleteCommentRequest: Sync = ({
  request,
  accessToken,
  user,
  commentId,
  path,
}) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Parse commentId from path
    frames = frames.map((f) => {
      const p = f[path] as string;
      const match = p.match(COMMENT_PATH_REGEX);
      return match ? { ...f, [commentId]: match[1] } : null;
    }).filter((f) => f !== null) as any;

    // 2. Authenticate user
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    return frames.filter((f) => f[user] !== undefined);
  },
  then: actions([
    Commenting.deleteComment,
    { commentId, author: user },
  ]),
});

/**
 * SYNC: DeleteCommentCleanup
 * Purpose: Handle side effects (Liking and Paginating) after successful deletion.
 */
export const DeleteCommentCleanup: Sync = ({ commentId }) => ({
  when: actions([
    Commenting.deleteComment,
    { commentId },
    { ok: true },
  ]),
  then: actions([
    Liking.deleteByItem,
    { item: commentId },
  ], [
    Paginating.deleteByItem,
    { item: commentId },
  ]),
});

/**
 * SYNC: DeleteCommentResponseSuccess
 * Purpose: Respond with 200 OK on success.
 */
export const DeleteCommentResponseSuccess: Sync = ({ request, path, commentId }) => ({
  when: actions(
    [Requesting.request, { path, method: "DELETE" }, { request }],
    [Commenting.deleteComment, { commentId }, { ok: true }],
  ),
  where: async (frames) => {
    return frames.filter((f) => {
      const match = (f[path] as string).match(COMMENT_PATH_REGEX);
      return match && match[1] === f[commentId];
    });
  },
  then: actions([
    Requesting.respond,
    { request },
  ]),
});

/**
 * SYNC: DeleteCommentResponseError
 * Purpose: Respond with error if deletion fails (not found or author mismatch).
 */
export const DeleteCommentResponseError: Sync = ({ request, error, path, commentId }) => ({
  when: actions(
    [Requesting.request, { path, method: "DELETE" }, { request }],
    [Commenting.deleteComment, { commentId }, { error }],
  ),
  where: async (frames) => {
    return frames.filter((f) => {
      const match = (f[path] as string).match(COMMENT_PATH_REGEX);
      return match && match[1] === f[commentId];
    });
  },
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 403 },
  ]),
});

/**
 * SYNC: DeleteCommentAuthError
 * Purpose: Respond with 401 if authentication fails.
 */
export const DeleteCommentAuthError: Sync = ({ request, accessToken, error, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter((f) => COMMENT_PATH_REGEX.test(f[path] as string));
    if (frames.length === 0) return frames;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});