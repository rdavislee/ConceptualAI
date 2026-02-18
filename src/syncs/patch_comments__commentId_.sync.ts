import { actions, Frames, Sync } from "@engine";
import { Requesting, Sessioning, Commenting, Profiling } from "@concepts";

const COMMENT_PATH_REGEX = /^\/comments\/([^\/]+)$/;

/**
 * SYNC 1: EditCommentRequest
 * Purpose: Authenticate, Authorize, and Trigger Edit
 */
export const EditCommentRequest: Sync = ({ request, accessToken, user, commentId, content, path, comment, newContent }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PATCH", accessToken, content },
    { request },
  ]),
  where: async (frames) => {
    // 1. Parse path to get commentId
    frames = frames.map(f => {
        const p = f[path] as string;
        const match = p.match(COMMENT_PATH_REGEX);
        return match ? { ...f, [commentId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Extract nested content string (Fix for OpenAPI mapping)
    frames = frames.map(f => {
        const body = f[content] as any;
        // Expecting { content: "string" }
        return (body && typeof body === 'object' && typeof body.content === 'string') 
            ? { ...f, [newContent]: body.content } 
            : null;
    }).filter(f => f !== null) as any;

    // 3. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 4. Fetch Comment for Authorization
    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    
    // 5. Authorize: Check if comment exists and user is author
    const result = frames.filter(f => {
        const c = f[comment] as any;
        return c && c.author === f[user];
    });
    return new Frames(...result);
  },
  then: actions([
    Commenting.editComment,
    { commentId, author: user, newContent },
  ]),
});

/**
 * SYNC 2: EditCommentResponseSuccess
 * Purpose: Fetch updated comment, hydrate author, and respond
 */
export const EditCommentResponseSuccess: Sync = ({ request, path, commentId, comment, user, profile }) => ({
  when: actions(
    [Requesting.request, { path, method: "PATCH" }, { request }],
    [Commenting.editComment, {}, { ok: true }],
  ),
  where: async (frames) => {
    // 1. Parse path again to get ID for fetching updated data
    frames = frames.map(f => {
        const p = f[path] as string;
        const match = p.match(COMMENT_PATH_REGEX);
        return match ? { ...f, [commentId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Fetch the UPDATED comment
    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    
    // 3. Get User ID from comment to fetch profile
    frames = frames.map(f => {
        const c = f[comment] as any;
        return c ? { ...f, [user]: c.author } : null;
    }).filter(f => f !== null) as any;

    // 4. Hydrate Author Profile
    frames = await frames.query(Profiling._getProfile, { user }, { profile });

    // 5. Construct Response Object matching OpenAPI
    const result = frames.map(f => {
        const c = f[comment] as any;
        const p = f[profile] as any;
        
        if (!c) return null;

        const hydratedComment = {
            _id: c._id,
            postId: c.item, // 'item' in concept is 'postId' in API
            content: c.content,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt,
            isOwner: true, // We know it's the owner because they just edited it
            likeCount: 0, // Default (Liking concept not available)
            isLiked: false, // Default
            author: p ? {
                _id: p._id,
                userId: p.user,
                username: p.username,
                displayName: p.name
            } : {
                _id: c.author,
                username: "Unknown"
            }
        };

        return { ...f, [comment]: hydratedComment };
    }).filter(f => f !== null);
    return new Frames(...result);
  },
  then: actions([
    Requesting.respond,
    { request, comment },
  ]),
});

/**
 * SYNC 3: EditCommentResponseError
 */
export const EditCommentResponseError: Sync = ({ request, error, path }) => ({
  when: actions(
    [Requesting.request, { path, method: "PATCH" }, { request }],
    [Commenting.editComment, {}, { error }],
  ),
  where: async (frames) => {
    return frames.filter(f => COMMENT_PATH_REGEX.test(f[path] as string));
  },
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});

/**
 * SYNC 4: EditCommentAuthError
 */
export const EditCommentAuthError: Sync = ({ request, accessToken, error, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PATCH", accessToken },
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
 * SYNC 5: EditCommentNotFound
 */
export const EditCommentNotFound: Sync = ({ request, accessToken, user, commentId, path, comment }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PATCH", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(COMMENT_PATH_REGEX);
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

/**
 * SYNC 6: EditCommentAccessDenied
 */
export const EditCommentAccessDenied: Sync = ({ request, accessToken, user, commentId, path, comment }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PATCH", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(COMMENT_PATH_REGEX);
        return match ? { ...f, [commentId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    
    return frames.filter(f => {
        const c = f[comment] as any;
        return c && c.author !== f[user];
    });
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 403, error: "Access denied" },
  ]),
});