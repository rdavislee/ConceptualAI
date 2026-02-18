import { actions, Sync } from "@engine";
import { Requesting, Sessioning, Posting, Paginating, Profiling } from "@concepts";

// =============================================================================
// POST /posts
// =============================================================================

import { Frames } from "@engine";

/**
 * SYNC 1: CreatePostRequest
 * Authenticates the user and triggers the creation of the post in the Posting concept.
 */
export const CreatePostRequest: Sync = ({ request, accessToken, user, content }) => ({
  when: actions([
    Requesting.request,
    { path: "/posts", method: "POST", accessToken, content },
    { request },
  ]),
  where: async (frames) => {
    // Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    // Explicitly wrap in Frames to satisfy return type
    return new Frames(...frames.filter(f => f[user] !== undefined));
  },
  then: actions([
    Posting.createPost,
    { author: user, content },
  ]),
});

/**
 * SYNC 2: CreatePostFeedUpdate
 * When a post is created, add it to the global "common" feed and the user's personal feed.
 */
export const CreatePostFeedUpdate: Sync = ({ user, postId, post, createdAt }) => ({
  when: actions([
    Posting.createPost,
    { author: user },
    { postId },
  ]),
  where: async (frames) => {
    // Fetch the post to get the exact createdAt timestamp
    frames = await frames.query(Posting._getPost, { postId }, { post });
    const mapped = frames.map(f => {
      const p = f[post] as any;
      if (!p) return null;
      return { ...f, [createdAt]: p.createdAt };
    }).filter(f => f !== null);
    return new Frames(...mapped);
  },
  then: actions(
    // Add to Global Feed
    [Paginating.upsertEntry, { bound: "common", itemType: "posts", item: postId, createdAt }],
    // Add to User's Feed
    [Paginating.upsertEntry, { bound: user, itemType: "posts", item: postId, createdAt }]
  ),
});

/**
 * SYNC 3: CreatePostResponse
 * Formats and sends the response back to the client, including author hydration.
 */
export const CreatePostResponse: Sync = ({ request, postId, post, user, profile, responsePost }) => ({
  when: actions(
    [Requesting.request, { path: "/posts", method: "POST" }, { request }],
    [Posting.createPost, {}, { postId }],
  ),
  where: async (frames) => {
    // 1. Get the post details
    frames = await frames.query(Posting._getPost, { postId }, { post });
    
    // 2. Get the author's profile for hydration
    const mappedAuthors = frames.map(f => {
        const p = f[post] as any;
        return p ? { ...f, [user]: p.author } : null;
    }).filter(f => f !== null);
    frames = new Frames(...mappedAuthors);

    frames = await frames.query(Profiling._getProfile, { user }, { profile });

    // 3. Construct the response object matching OpenAPI schema
    const mappedResponse = frames.map(f => {
        const p = f[post] as any;
        const prof = f[profile] as any;
        
        if (!p || !prof) return null;

        const hydratedPost = {
            _id: String(p._id),
            content: p.content,
            author: {
                _id: String(prof.user || prof._id), // Map profile user ID to _id for test compatibility
                userId: String(prof.user || prof._id),
                username: prof.username,
                displayName: prof.name
            },
            likeCount: 0, // New post
            isLiked: false, // User hasn't liked their own post yet upon creation
            isOwner: true, // User is the creator
            createdAt: p.createdAt,
            updatedAt: p.updatedAt
        };

        return { ...f, [responsePost]: hydratedPost };
    }).filter(f => f !== null);
    
    return new Frames(...mappedResponse);
  },
  then: actions([
    Requesting.respond,
    { request, post: responsePost, statusCode: 201 },
  ]),
});

/**
 * SYNC 4: CreatePostError
 * Handles validation or processing errors during post creation.
 */
export const CreatePostError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/posts", method: "POST" }, { request }],
    [Posting.createPost, {}, { error }],
  ),
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});

/**
 * SYNC 5: CreatePostAuthError
 * Handles authentication failures.
 */
export const CreatePostAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/posts", method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});