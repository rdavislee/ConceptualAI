import { actions, Sync, Frames } from "@engine";
import { Requesting, Paginating, Posting, Profiling, Liking, Sessioning } from "@concepts";

// =============================================================================
// GET /posts - GLOBAL FEED
// =============================================================================

export const ListGlobalPosts: Sync = ({
  request, accessToken, page, pageSize, sort,
  user, items, totalItems, totalPages, mode,
  posts, profiles, likeCounts, myLikedItems,
  pagination, requestInput // New symbols for request payload/pagination object
}) => ({
  when: actions([
    Requesting.request,
    { path: "/posts", method: "GET" },
    { request },
  ]),
  where: async (frames) => {
    // 1. Extract Query Params and token from the original request input.
    // Use Requesting._getInput to avoid reading sanitized DB values.
    frames = await frames.query(Requesting._getInput, { request }, { input: requestInput });
    const framesWithParams = frames.map((f) => {
      const reqInput = (f[requestInput] as Record<string, unknown>) || {};

      const pageRaw = reqInput.page;
      const pageSizeRaw = reqInput.pageSize;
      const sortRaw = reqInput.sort;
      const tokenRaw = reqInput.accessToken;

      const parsedPage = Number(pageRaw);
      const parsedPageSize = Number(pageSizeRaw);

      return {
        ...f,
        [page]: Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1,
        [pageSize]: Number.isFinite(parsedPageSize) && parsedPageSize > 0 ? parsedPageSize : 10,
        [sort]: sortRaw === "score" ? "score" : "createdAt",
        [accessToken]: typeof tokenRaw === "string" ? tokenRaw : undefined,
      };
    });
    frames = new Frames(...framesWithParams);

    // 2. Optional Authentication
    // We manually resolve the user to handle optional auth without crashing on missing token.
    const framesWithUser = await Promise.all(frames.map(async f => {
        const token = f[accessToken];
        if (!token) return f;
        
        // Manual query to avoid filtering
        const result = await Sessioning._getUser({ session: token as string });
        if (result[0] && 'user' in result[0]) {
            return { ...f, [user]: result[0].user };
        }
        return f;
    }));
    frames = new Frames(...framesWithUser);

    // 3. Pagination: Get list of Post IDs
    // bound="common" for global feed, itemType="posts"
    frames = await frames.query(
      Paginating._getPage,
      { bound: "common", itemType: "posts", page, pageSize, mode: sort },
      { items, totalItems, totalPages, mode }
    );

    // 4. Hydration: Fetch Posts, Profiles, Likes
    // We do this manually via map/Promise.all to handle the aggregation
    const hydratedFrames = await Promise.all(frames.map(async f => {
        const postIds = f[items] as string[] || [];
        const currentUser = f[user] as string | undefined;

        if (postIds.length === 0) {
            return { ...f, [posts]: [], [pagination]: {
                page: f[page],
                pageSize: f[pageSize],
                totalPages: f[totalPages],
                totalItems: f[totalItems]
            }};
        }

        // A. Fetch Posts
        const postsResult = await Posting._getPostsByIds({ postIds });
        const postObjects = postsResult[0]?.posts || [];

        // B. Fetch Authors
        const authorIds = [...new Set(postObjects.map(p => p.author))];
        const profilesResult = await Profiling._getProfilesByIds({ users: authorIds });
        const profileObjects = profilesResult[0]?.profiles || [];
        const profileMap = new Map(profileObjects.map(p => [p._id, p]));

        // C. Fetch Like Counts
        const countsResult = await Liking._countForItems({ items: postIds as any });
        const counts = countsResult[0]?.counts || [];
        const countMap = new Map(counts.map(c => [c.item, c.n]));

        // D. Fetch User's Liked Items (if logged in)
        let userLikesSet = new Set<string>();
        if (currentUser) {
            const likesResult = await Liking._likedItems({ user: currentUser as any });
            const likedItems = likesResult[0]?.items || [];
            userLikesSet = new Set(likedItems as string[]);
        }

        // E. Assemble Final Post Objects
        const finalPosts = postObjects.map(p => {
            const authorProfile = profileMap.get(p.author);
            const likeCount = countMap.get(String(p._id) as any) || 0;
            const isLiked = userLikesSet.has(String(p._id));
            const isOwner = currentUser === p.author;

            return {
                _id: String(p._id),
                content: p.content,
                author: {
                    _id: p.author,
                    userId: p.author, // Map for API spec
                    username: authorProfile?.username || "Unknown",
                    displayName: authorProfile?.name || "Unknown"
                },
                likeCount,
                isLiked,
                isOwner,
                createdAt: p.createdAt,
                updatedAt: p.updatedAt
            };
        });

        // F. Construct Pagination Object
        // We must construct this in the where clause to resolve symbols to values
        const paginationObj = {
            page: f[page],
            pageSize: f[pageSize],
            totalPages: f[totalPages],
            totalItems: f[totalItems]
        };

        return { ...f, [posts]: finalPosts, [pagination]: paginationObj };
    }));

    return new Frames(...hydratedFrames);
  },
  then: actions([
    Requesting.respond,
    { 
      request, 
      posts, 
      pagination
    }
  ]),
});