import { actions, Frames, Sync } from "@engine";
import { Requesting, Sessioning, Paginating, Posting, Profiling, Liking, db } from "@concepts";

/**
 * GET /me/posts
 * Purpose: Fetch the authenticated user's own posts for their profile view.
 * Pattern: SELF-CONTAINED READ (Rule 4)
 */
export const GetMePosts: Sync = ({
  request,
  accessToken,
  user,
  pageData,
  postDocs,
  profileDocs,
  likeCounts,
  userLikes,
  posts,
  pagination,
}) => {
  const postIdsVar = Symbol("postIds");
  const authorIdsVar = Symbol("authorIds");

  return {
    when: actions([
      Requesting.request,
      { path: "/me/posts", method: "GET", accessToken },
      { request },
    ]),
    where: async (frames) => {
      // 1. Authenticate user
      frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
      frames = frames.filter((f) => f[user] !== undefined);

      // 2. Extract pagination parameters and fetch page data
      const requests = db.collection<any>("Requesting.requests");
      const newFrames = await Promise.all(frames.map(async (f) => {
        const reqDoc = await requests.findOne({ _id: f[request] as any });
        if (!reqDoc) return null;
        
        const page = Number(reqDoc.input.page) || 1;
        // pageSize is undocumented for this endpoint, use default
        const pageSize = 10;
        
        const [res] = await Paginating._getPage({ 
          bound: f[user] as any, 
          itemType: "posts", 
          page, 
          pageSize 
        });
        
        if (!res || "error" in res) return null;
        
        return { 
          ...f, 
          [pageData]: res,
          [postIdsVar]: res.items,
          [authorIdsVar]: [f[user] as any]
        };
      }));
      frames = new Frames(...newFrames.filter((f): f is any => f !== null));

      // 3. Fetch post content
      frames = await frames.query(
        Posting._getPostsByIds,
        { postIds: postIdsVar },
        { posts: postDocs },
      );

      // 4. Fetch user profile for author hydration
      frames = await frames.query(
        Profiling._getProfilesByIds,
        { users: authorIdsVar },
        { profiles: profileDocs },
      );

      // 5. Fetch like counts for the posts
      frames = await frames.query(
        Liking._countForItems,
        { items: postIdsVar },
        { counts: likeCounts },
      );

      // 6. Fetch user's liked items for isLiked flag
      frames = await frames.query(
        Liking._likedItems,
        { user },
        { items: userLikes },
      );

      // 7. Format the final response
      return frames.map((f) => {
        const pData = f[pageData] as any;
        const postList = f[postDocs] as any[] || [];
        const profileList = f[profileDocs] as any[] || [];
        const countList = f[likeCounts] as any[] || [];
        const likedIds = f[userLikes] as string[] || [];
        
        const profile = profileList[0] || {};
        const author = {
          _id: profile._id || (f[user] as string),
          userId: profile._id || (f[user] as string),
          username: profile.username || "unknown",
          displayName: profile.name || "Unknown User",
        };

        const formattedPosts = postList.map((post) => {
          const id = post._id.toHexString();
          const likeCountObj = countList.find((c) => c.item === id);
          return {
            _id: id,
            content: post.content,
            author,
            likeCount: likeCountObj ? likeCountObj.n : 0,
            isLiked: likedIds.includes(id),
            isOwner: true,
            createdAt: post.createdAt.toISOString(),
            updatedAt: post.updatedAt.toISOString(),
          };
        });

        return {
          ...f,
          [posts]: formattedPosts,
          [pagination]: {
            page: pData.page,
            totalPages: pData.totalPages,
            totalItems: pData.totalItems,
            pageSize: pData.pageSize,
          },
        };
      });
    },
    then: actions([
      Requesting.respond,
      { request, posts, pagination },
    ]),
  };
};

/**
 * GET /me/posts - Auth Error
 */
export const GetMePostsAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/me/posts", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter((f) => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});
