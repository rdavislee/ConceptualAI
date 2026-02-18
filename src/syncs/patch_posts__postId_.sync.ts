import { actions, Sync, Frames } from "@engine";
import { Requesting, Sessioning, Posting, Profiling, db } from "@concepts";

// Regex to extract postId from /posts/{postId}
const POST_PATH_REGEX = /^\/posts\/([^\/]+)$/;

/**
 * SYNC 1: EditPostRequest
 * Purpose: Authenticate, authorize, and trigger edit action.
 */
export const EditPostRequest: Sync = ({ 
  request, accessToken, user, postId, content, path, post 
}) => ({
  when: actions([
    Requesting.request,
    // content is required in body
    { path, method: "PATCH", accessToken, content },
    { request },
  ]),
  where: async (frames) => {
    // 1. Parse path parameter
    frames = frames.map(f => {
        const p = f[path] as string;
        const match = p.match(POST_PATH_REGEX);
        return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 3. Authorize (Check ownership)
    frames = await frames.query(Posting._getPost, { postId }, { post });
    return frames.filter(f => {
        const p = f[post] as any;
        return p && p.author === f[user];
    });
  },
  then: actions([
    Posting.editPost,
    { postId, author: user, content },
  ]),
});

/**
 * SYNC 2: EditPostResponseSuccess
 * Purpose: Fetch updated post, hydrate author, and respond.
 */
export const EditPostResponseSuccess: Sync = ({ 
  request, postId, path, post, user, profile 
}) => ({
  when: actions(
    [Requesting.request, { path, method: "PATCH" }, { request }],
    [Posting.editPost, {}, {}], // Success implies no error
  ),
  where: async (frames) => {
    // Filter by path to ensure we are handling the right request type
    frames = frames.filter(f => POST_PATH_REGEX.test(f[path] as string));
    
    // Extract postId again for the fetch
    frames = frames.map(f => {
        const p = f[path] as string;
        const match = p.match(POST_PATH_REGEX);
        return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // Fetch the updated post
    frames = await frames.query(Posting._getPost, { postId }, { post });
    
    // Hydrate Author: We need the author's profile to match OpenAPI 'Post' schema
    // The post object has 'author' (ID). We need to fetch the profile for that ID.
    // Since we don't have the author ID bound in this sync's 'when', we extract it from the post.
    
    // We can't easily map one-to-one with a query if the input depends on the previous query result 
    // in a way that isn't a direct variable binding.
    // However, we know the author is the user who made the request (from the Request logic),
    // but strictly speaking we should use the post's author.
    
    // Let's iterate and fetch profiles manually to ensure robust hydration
    const profilesCol = db.collection("Profiling.profiles");
    const newFrames = await Promise.all(frames.map(async f => {
        const p = f[post] as any;
        if (!p) return null;
        
        const authorId = p.author;
        const authorProfile = await profilesCol.findOne({ _id: authorId });
        
                // Construct the author object expected by OpenAPI
        const authorObj = authorProfile ? {
            _id: authorProfile._id,
            userId: authorProfile.userId || authorProfile._id, // Fallback
            username: authorProfile.username,
            displayName: authorProfile.name // Mapping 'name' to 'displayName' based on schema
        } : { 
            _id: authorId, 
            userId: authorId, 
            username: "Unknown", 
            displayName: "Unknown" 
        };

                return {
            ...f,
            [post]: {
                ...p,
                _id: p._id.toString(),
                author: authorObj,
                // Ensure other required fields exist
                likeCount: p.likeCount || 0,
                isLiked: false, // Default for edit response
                isOwner: true   // Since they just edited it
            }
        };
    }));

    return new Frames(...newFrames.filter(f => f !== null));
  },
  then: actions([
    Requesting.respond,
    { request, post },
  ]),
});

/**
 * SYNC 3: EditPostResponseError
 */
export const EditPostResponseError: Sync = ({ request, error, path }) => ({
  when: actions(
    [Requesting.request, { path, method: "PATCH" }, { request }],
    [Posting.editPost, {}, { error }],
  ),
  where: async (frames) => {
    return frames.filter(f => POST_PATH_REGEX.test(f[path] as string));
  },
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});

/**
 * SYNC 4: EditPostAuthError
 */
export const EditPostAuthError: Sync = ({ request, accessToken, error, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PATCH", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter(f => POST_PATH_REGEX.test(f[path] as string));
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
 * SYNC 5: EditPostNotFound
 */
export const EditPostNotFound: Sync = ({ request, accessToken, user, postId, path, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PATCH", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(POST_PATH_REGEX);
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
 * SYNC 6: EditPostAccessDenied
 */
export const EditPostAccessDenied: Sync = ({ request, accessToken, user, postId, path, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PATCH", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(POST_PATH_REGEX);
        return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    frames = await frames.query(Posting._getPost, { postId }, { post });
    return frames.filter(f => {
        const p = f[post] as any;
        return p && p.author !== f[user];
    });
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 403, error: "Access denied" },
  ]),
});