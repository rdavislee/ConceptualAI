import { actions, Sync, Frames } from "@engine";
import { Requesting, Sessioning, Commenting, Profiling, Liking } from "@concepts";

// =============================================================================
// GET /comments/{commentId}
// =============================================================================

const COMMENT_PATH_REGEX = /^\/comments\/([^\/]+)$/;

/**
 * SYNC 1: GetComment (Success)
 * 
 * Pattern: Self-Contained Read with Hydration
 * 1. Match request and extract commentId from path
 * 2. Authenticate user (needed for isLiked/isOwner)
 * 3. Fetch Comment
 * 4. Fetch Author Profile
 * 5. Fetch Like Count
 * 6. Fetch IsLiked status
 * 7. Assemble response
 */
export const GetComment: Sync = ({ 
  request, accessToken, path, 
  userId, commentId, comment, 
  authorProfile, likeCount, isLiked, hydratedComment
}) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Parse path to get commentId
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(COMMENT_PATH_REGEX);
      return match ? { ...f, [commentId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    // 3. Fetch Comment
    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    // Filter out if comment not found (handled by 404 sync)
    frames = frames.filter(f => f[comment] !== null && f[comment] !== undefined);

        // 4. Fetch Author Profile
    // We need to extract the author ID from the comment object first
    frames = await frames.queryAsync(async (inputs) => {
      const c = inputs["comment"] as any;
      const authorId = c.author;
            // Use the Profiling concept to get the author's profile
      const result = await Profiling._getProfile({ user: authorId });
      return result.map(r => ({ authorProfile: r.profile }));
    }, { comment }, { authorProfile });

    // 5. Fetch Like Count
    frames = await frames.query(Liking._countForItem, { item: commentId }, { n: likeCount });

    // 6. Fetch IsLiked status
    frames = await frames.query(Liking._isLiked, { item: commentId, user: userId }, { liked: isLiked });

    // 7. Assemble the final response object
    const mappedFrames = frames.map(f => {
      const c = f[comment] as any;
      const p = f[authorProfile] as any;
      const count = f[likeCount] as number;
      const liked = f[isLiked] as boolean;
      const uid = f[userId] as string;

      if (!c) return null;

            // Construct the response according to spec
      const response = {
        _id: c._id,
        postId: c.item,
        content: c.content,
        author: {
          _id: c.author,
          userId: c.author, // Map _id to userId as per common pattern in this app
          username: p ? p.username : "Unknown",
          displayName: p ? p.name : "Unknown",
        },
        likeCount: count,
        isLiked: liked,
        isOwner: c.author === uid,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      };

      return { ...f, [hydratedComment]: response };
    }).filter(f => f !== null);

    // Explicitly return a Frames object
    // @ts-ignore: Frames constructor accepts array
    return new Frames(...mappedFrames);
  },
  then: actions([
    Requesting.respond,
    { request, comment: hydratedComment } // Map the assembled object to the response
  ]),
});

/**
 * SYNC 2: GetCommentNotFound
 */
export const GetCommentNotFound: Sync = ({ request, accessToken, path, commentId, comment, userId }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Parse path
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(COMMENT_PATH_REGEX);
      return match ? { ...f, [commentId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // Authenticate (still need to be auth'd to get 404 vs 401)
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    // Fetch Comment
    frames = await frames.query(Commenting._getComment, { commentId }, { comment });
    
    // Filter for NOT found
    return frames.filter(f => !f[comment]);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Comment not found" }
  ]),
});

/**
 * SYNC 3: GetCommentAuthError
 */
export const GetCommentAuthError: Sync = ({ request, accessToken, path, error }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Only match relevant paths
    frames = frames.filter(f => COMMENT_PATH_REGEX.test(f[path] as string));
    if (frames.length === 0) return frames;

    // Check auth
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" }
  ]),
});