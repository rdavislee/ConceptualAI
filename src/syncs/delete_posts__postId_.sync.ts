import { actions, Sync, Frames } from "@engine";
import { Requesting, Sessioning, Posting, Commenting, Liking, Paginating } from "@concepts";

const POST_PATH_REGEX = /^\/posts\/([^\/]+)$/;

/**
 * SYNC: DeletePostRequest
 * Authenticates the user, extracts postId from path, verifies authorship,
 * and triggers the deletion action.
 */
export const DeletePostRequest: Sync = ({ request, accessToken, user, postId, post, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Extract postId from path
    frames = frames.map(f => {
      const match = (f[path] as string).match(POST_PATH_REGEX);
      return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 3. Fetch Post and Authorize
    frames = await frames.query(Posting._getPost, { postId }, { post });
    return frames.filter(f => {
      const p = f[post] as any;
      return p && p.author === f[user];
    });
  },
  then: actions([
    Posting.deletePost,
    { postId, author: user },
  ]),
});

/**
 * SYNC: DeletePostSideEffects
 * When a post is deleted, remove all associated comments, likes, and pagination entries.
 */
export const DeletePostSideEffects: Sync = ({ postId }) => ({
  when: actions([
    Posting.deletePost,
    { postId },
    { ok: true },
  ]),
  then: actions(
    [Commenting.deleteByItem, { item: postId }],
    [Liking.deleteByItem, { item: postId }],
    [Paginating.deleteByItem, { item: postId }],
  ),
});

/**
 * SYNC: DeletePostResponseSuccess
 * Responds with 200 OK (empty object) upon successful deletion.
 */
export const DeletePostResponseSuccess: Sync = ({ request, path }) => ({
  when: actions(
    [Requesting.request, { path, method: "DELETE" }, { request }],
    [Posting.deletePost, {}, { ok: true }],
  ),
  where: async (frames) => {
    return frames.filter(f => POST_PATH_REGEX.test(f[path] as string));
  },
  then: actions([
    Requesting.respond,
    { request },
  ]),
});

/**
 * SYNC: DeletePostResponseForbidden
 * Responds with 403 if the post is not found or the user is not the author.
 */
export const DeletePostResponseForbidden: Sync = ({ request, accessToken, user, postId, post, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Extract postId
    frames = frames.map(f => {
      const match = (f[path] as string).match(POST_PATH_REGEX);
      return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // Check authorship/existence
    frames = await frames.query(Posting._getPost, { postId }, { post });
    return frames.filter(f => {
      const p = f[post] as any;
      return !p || p.author !== f[user];
    });
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 403, error: "Not authorized" },
  ]),
});

/**
 * SYNC: DeletePostResponseUnauthorized
 * Responds with 401 if the access token is invalid.
 */
export const DeletePostResponseUnauthorized: Sync = ({ request, accessToken, error, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    if (!POST_PATH_REGEX.test(frames[0][path] as string)) return frames.filter(() => false);
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});