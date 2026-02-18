import { actions, Sync, Frames } from "@engine";
import { Requesting, Sessioning, Posting, Profiling, Liking, db } from "@concepts";

// Regex to match /posts/{postId}
const POST_PATH_REGEX = /^\/posts\/([^\/]+)$/;

/**
 * SYNC 1: GetPostAuthenticated
 * Purpose: Retrieve a single post for an authenticated user.
 */
export const GetPostAuthenticated: Sync = ({ request, path, post, user, profile, likeCount, isLiked, responsePost, accessToken }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Parse Path for postId
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(POST_PATH_REGEX);
      return match ? { ...f, postId: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. Resolve User
    const framesWithUser = await Promise.all(frames.map(async (f: any) => {
        const token = f[accessToken] as string | undefined;
        if (!token) return f;
        const userResult = await Sessioning._getUser({ session: token });
        const result = userResult[0];
        if (result && "user" in result) {
            return { ...f, [user]: result.user };
        }
        return f;
    }));
    frames = new Frames(...framesWithUser);

    // 3. Fetch Post
    const framesWithPost = await Promise.all(frames.map(async (f: any) => {
        const postResult = await Posting._getPost({ postId: f.postId });
        const p = postResult[0]?.post;
        return p ? { ...f, [post]: p } : null;
    }));
    frames = new Frames(...framesWithPost.filter((f: any) => f !== null));

    if (frames.length === 0) return frames;

    // 4. Hydrate Author Profile
    const framesWithProfile = await Promise.all(frames.map(async (f: any) => {
        const p = f[post];
        const authorId = p.author;
        const profileResult = await Profiling._getProfile({ user: authorId });
        const authorProfile = profileResult[0]?.profile;
        return { ...f, [profile]: authorProfile };
    }));
    frames = new Frames(...framesWithProfile);

    // 5. Fetch Like Count
    const framesWithCount = await Promise.all(frames.map(async (f: any) => {
        const countResult = await Liking._countForItem({ item: f.postId });
        return { ...f, [likeCount]: countResult[0]?.n ?? 0 };
    }));
    frames = new Frames(...framesWithCount);

    // 6. Fetch isLiked
    const framesWithIsLiked = await Promise.all(frames.map(async (f: any) => {
        let liked = false;
        if (f[user]) {
            const likedResult = await Liking._isLiked({ item: f.postId, user: f[user] });
            liked = likedResult[0]?.liked ?? false;
        }
        return { ...f, [isLiked]: liked };
    }));
    frames = new Frames(...framesWithIsLiked);

    // 7. Construct Response
    return frames.map(f => {
        const p = f[post] as any;
        const prof = f[profile] as any;
        const u = f[user] as string | undefined;

        const apiPost = {
            _id: p._id.toString(),
            content: p.content,
            author: prof ? {
                _id: prof._id.toString(),
                userId: prof._id.toString(),
                username: prof.username,
                displayName: prof.name
            } : {
                _id: p.author.toString(),
                userId: p.author.toString(),
                username: "Unknown",
                displayName: "Unknown"
            },
            likeCount: f[likeCount],
            isLiked: f[isLiked],
            isOwner: u === p.author.toString(),
            createdAt: p.createdAt,
            updatedAt: p.updatedAt
        };

        return { ...f, [responsePost]: apiPost };
    });
  },
  then: actions([
    Requesting.respond,
    { request, post: responsePost }
  ]),
});

/**
 * SYNC 2: GetPostPublic
 * Purpose: Retrieve a single post for a public/anonymous user.
 */
export const GetPostPublic: Sync = ({ request, path, post, user, profile, likeCount, isLiked, responsePost }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET" },
    { request },
  ]),
  where: async (frames) => {
    // 1. Parse Path
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(POST_PATH_REGEX);
      return match ? { ...f, postId: match[1] } : null;
    }).filter(f => f !== null) as any;

    // 2. EXCLUDE Authenticated Requests
    const requests = db.collection<any>("Requesting.requests");
    const framesPublic = await Promise.all(frames.map(async (f: any) => {
      const reqDoc = await requests.findOne({ _id: f[request] });
      if (reqDoc?.input?.accessToken) return null;
      return f;
    }));
    frames = new Frames(...framesPublic.filter(f => f !== null));

    // 3. Fetch Post
    const framesWithPost = await Promise.all(frames.map(async (f: any) => {
        const postResult = await Posting._getPost({ postId: f.postId });
        const p = postResult[0]?.post;
        return p ? { ...f, [post]: p } : null;
    }));
    frames = new Frames(...framesWithPost.filter((f: any) => f !== null));

    if (frames.length === 0) return frames;

    // 4. Hydrate Author Profile
    const framesWithProfile = await Promise.all(frames.map(async (f: any) => {
        const p = f[post];
        const authorId = p.author;
        const profileResult = await Profiling._getProfile({ user: authorId });
        const authorProfile = profileResult[0]?.profile;
        return { ...f, [profile]: authorProfile };
    }));
    frames = new Frames(...framesWithProfile);

    // 5. Fetch Like Count
    const framesWithCount = await Promise.all(frames.map(async (f: any) => {
        const countResult = await Liking._countForItem({ item: f.postId });
        return { ...f, [likeCount]: countResult[0]?.n ?? 0 };
    }));
    frames = new Frames(...framesWithCount);

    // 6. Fetch isLiked (Always false for public)
    const framesWithIsLiked = frames.map(f => ({ ...f, [isLiked]: false }));
    frames = new Frames(...framesWithIsLiked);

    // 7. Construct Response
    return frames.map(f => {
        const p = f[post] as any;
        const prof = f[profile] as any;
        
        const apiPost = {
            _id: p._id.toString(),
            content: p.content,
            author: prof ? {
                _id: prof._id.toString(),
                userId: prof._id.toString(),
                username: prof.username,
                displayName: prof.name
            } : {
                _id: p.author.toString(),
                userId: p.author.toString(),
                username: "Unknown",
                displayName: "Unknown"
            },
            likeCount: f[likeCount],
            isLiked: f[isLiked],
            isOwner: false, // Always false for public
            createdAt: p.createdAt,
            updatedAt: p.updatedAt
        };

        return { ...f, [responsePost]: apiPost };
    });
  },
  then: actions([
    Requesting.respond,
    { request, post: responsePost }
  ]),
});

/**
 * SYNC 3: GetPostNotFound
 * Purpose: Return 404 if post doesn't exist.
 */
export const GetPostNotFound: Sync = ({ request, path, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET" },
    { request },
  ]),
  where: async (frames) => {
    // Parse Path
    frames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(POST_PATH_REGEX);
      return match ? { ...f, postId: match[1] } : null;
    }).filter(f => f !== null) as any;

    // Check existence
    const framesWithPost = await Promise.all(frames.map(async (f: any) => {
        const postResult = await Posting._getPost({ postId: f.postId });
        return { ...f, [post]: postResult[0]?.post };
    }));
    
    // Filter for NOT found
    return new Frames(...framesWithPost.filter((f: any) => !f[post]));
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Post not found" }
  ]),
});