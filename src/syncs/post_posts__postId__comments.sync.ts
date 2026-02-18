import { actions, Sync, Frames } from "@engine";
import { 
  Commenting, 
  Paginating, 
  Requesting, 
  Sessioning, 
  Posting, 
  Profiling, 
  Liking,
  db 
} from "@concepts";

const COMMENT_PATH_REGEX = /^\/posts\/([^\/]+)\/comments$/;

/**
 * SYNC 1: AddCommentRequest
 * Authenticates user, verifies post existence, and triggers comment creation.
 */
export const AddCommentRequest: Sync = ({ request, path, accessToken, content, user, postId, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken, content },
    { request },
  ]),
  where: async (frames) => {
    // 1. Extract postId from path
    frames = frames.map(f => {
      const match = (f[path] as string).match(COMMENT_PATH_REGEX);
      return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 3. Verify Post exists
    frames = await frames.query(Posting._getPost, { postId }, { post });
    return frames.filter(f => f[post] !== null);
  },
  then: actions([
    Commenting.postComment,
    { item: postId, author: user, content },
  ]),
});

/**
 * SYNC 2: AddCommentAuthError
 */
export const AddCommentAuthError: Sync = ({ request, path, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter(f => COMMENT_PATH_REGEX.test(f[path] as string));
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
 * SYNC 3: AddCommentPostNotFound
 */
export const AddCommentPostNotFound: Sync = ({ request, path, accessToken, user, postId, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
      const match = (f[path] as string).match(COMMENT_PATH_REGEX);
      return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    frames = await frames.query(Posting._getPost, { postId }, { post });
    return frames.filter(f => f[post] === null);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Post not found" },
  ]),
});

/**
 * SYNC 4: AddCommentSuccessSideEffect
 * Adds the comment to the paginated list for the post.
 */
export const AddCommentSuccessSideEffect: Sync = ({ commentId, comment, postId, createdAt }) => ({
  when: actions([
    Commenting.postComment,
    {},
    { commentId },
  ]),
  where: async (frames) => {
    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    frames = frames.filter(f => f[comment] !== null);
    return frames.map(f => {
      const c = f[comment] as any;
      return {
        ...f,
        [postId]: c.item,
        [createdAt]: c.createdAt
      };
    });
  },
  then: actions(
    [Paginating.upsertEntry, { bound: postId, itemType: "comments", item: commentId, createdAt, mode: "createdAt" }],
    [Paginating.upsertEntry, { bound: postId, itemType: "comments", item: commentId, createdAt, mode: "score" }],
  ),
});

/**
 * SYNC 5: AddCommentResponseSuccess
 * Responds to the client with the hydrated comment object.
 */
export const AddCommentResponseSuccess: Sync = ({ 
  request, commentId, comment, profile, likeCount, isLiked, user, accessToken, path, authorId
}) => ({
  when: actions(
    [Requesting.request, { method: "POST", path, accessToken }, { request }],
    [Commenting.postComment, {}, { commentId }],
    [Paginating.upsertEntry, { item: commentId, mode: "createdAt" }, { ok: true }],
  ),
  where: async (frames) => {
    // 1. Path check
    frames = frames.filter(f => COMMENT_PATH_REGEX.test(f[path] as string));
    if (frames.length === 0) return frames;

    // 2. Get comment details
    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    frames = frames.filter(f => f[comment] !== null);
    
    // 3. Get current user for isLiked check
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 4. Hydrate Author Profile
    frames = frames.map(f => {
      const c = f[comment] as any;
      return { ...f, [authorId]: c.author };
    });
    frames = await frames.query(Profiling._getProfile, { user: authorId }, { profile });
    frames = frames.filter(f => f[profile] !== null);

    // 5. Hydrate Likes
    frames = await frames.query(Liking._countForItem, { item: commentId }, { n: likeCount });
    frames = await frames.query(Liking._isLiked, { item: commentId, user }, { liked: isLiked });

    return frames.map(f => {
      const c = f[comment] as any;
      const p = f[profile] as any;
      const u = f[user] as any;

      const hydratedComment = {
        _id: c._id,
        postId: c.item,
        content: c.content,
        author: {
          _id: p._id,
          userId: p._id,
          username: p.username,
          displayName: p.name
        },
        likeCount: f[likeCount] || 0,
        isLiked: !!f[isLiked],
        isOwner: c.author === u,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      };

      return { ...f, [comment]: hydratedComment };
    });
  },
  then: actions([
    Requesting.respond,
    { request, comment, statusCode: 201 },
  ]),
});

/**
 * SYNC 6: AddCommentResponseError
 */
export const AddCommentResponseError: Sync = ({ request, path, error }) => ({
  when: actions(
    [Requesting.request, { method: "POST", path }, { request }],
    [Commenting.postComment, {}, { error }],
  ),
  where: async (frames) => {
    return frames.filter(f => COMMENT_PATH_REGEX.test(f[path] as string));
  },
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});
