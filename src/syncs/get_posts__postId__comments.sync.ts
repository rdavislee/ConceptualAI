import { actions, Sync, Frames } from "@engine";
import { Requesting, Sessioning, Commenting, Paginating, Profiling, Liking, Posting } from "@concepts";
import { ID } from "@utils/types.ts";

// =============================================================================
// GET /posts/{postId}/comments
// =============================================================================

const COMMENTS_PATH_REGEX = /^\/posts\/([^\/]+)\/comments$/;

export const GetPostComments: Sync = ({ 
  request, path, accessToken, userId, postId, 
  page, sort, pageSize,
  pageResult, comments, profiles, likeCounts, userLikedItems, post, responseBody, requestInput 
}) => ({
  when: actions([
    Requesting.request,
    // RULE 1: Optional fields (page, sort, pageSize) removed from when
    { method: "GET", path }, 
    { request },
  ]),
  where: async (frames) => {
    // 1. Filter by Path Regex and Extract postId
    const mappedFrames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(COMMENTS_PATH_REGEX);
      if (!match) return null;
      return { ...f, [postId]: match[1] };
    }).filter(f => f !== null);
    
    if (mappedFrames.length === 0) return new Frames();
    frames = new Frames(...mappedFrames);

    // 2. Check if Post Exists (Prerequisite)
    frames = await frames.query(Posting._getPost, { postId }, { post });
    // Filter out frames where post is null (Not Found case handled by separate sync)
    frames = frames.filter(f => f[post] !== null);

    // 3. Fetch Optional Params (page, sort, pageSize) and optional auth token
    // from the original request input (non-redacted while in-flight).
    frames = await frames.query(Requesting._getInput, { request }, { input: requestInput });
    const framesWithParams = await Promise.all(frames.map(async f => {
        const input = (f[requestInput] as Record<string, unknown>) || {};
        
        // Default values
        const parsedPage = Number(input.page);
        const parsedPageSize = Number(input.pageSize);
        const p = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
        const ps = Number.isFinite(parsedPageSize) && parsedPageSize > 0 ? parsedPageSize : 10;
        const s = input.sort === "score" ? "score" : "createdAt";

        // Authenticate if token present
        let userVal = undefined;
        const token = typeof input.accessToken === "string"
          ? input.accessToken
          : undefined;
        if (token) {
            const result = await Sessioning._getUser({ session: token });
            if (result[0] && !('error' in result[0])) {
                userVal = result[0].user;
            }
        }

        return { 
            ...f, 
            [page]: p, 
            [pageSize]: ps, 
            [sort]: s,
            [userId]: userVal,
            [accessToken]: token // Keep token for reference if needed
        };
    }));
    frames = new Frames(...framesWithParams);

    // 4. Pagination
    const framesWithPage = await Promise.all(frames.map(async f => {
        const p = f[page] as number;
        const ps = f[pageSize] as number;
        const pid = f[postId] as string;
        
        // Cast string ID to Bound type (ID | "common")
        const bound = pid as ID;

        const result = await Paginating._getPage({ 
            bound, 
            itemType: "comments", 
            page: p, 
            pageSize: ps,
            mode: f[sort] as "createdAt" | "score",
        });
        
        if (result[0] && !('error' in result[0])) {
            return { ...f, [pageResult]: result[0] };
        }
        return f;
    }));
    frames = new Frames(...framesWithPage);

    // 5. Fetch Comments
    const framesWithComments = await Promise.all(frames.map(async f => {
        const pr = f[pageResult] as any;
        if (!pr || !pr.items || pr.items.length === 0) {
            return { ...f, [comments]: [] };
        }
        const ids = pr.items;
        const commentResult = await Commenting._getCommentsByIds({ commentIds: ids });
        return { ...f, [comments]: commentResult[0].comments };
    }));
    frames = new Frames(...framesWithComments);

    // 6. Hydrate Authors (Profiling)
    const framesWithProfiles = await Promise.all(frames.map(async f => {
        const commentList = f[comments] as any[];
        if (!commentList || commentList.length === 0) {
            return { ...f, [profiles]: [] };
        }
        const authorIds = [...new Set(commentList.map(c => c.author))];
        const profileResult = await Profiling._getProfilesByIds({ users: authorIds });
        return { ...f, [profiles]: profileResult[0].profiles };
    }));
    frames = new Frames(...framesWithProfiles);

    // 7. Hydrate Likes (Liking)
    const framesWithLikes = await Promise.all(frames.map(async f => {
        const commentList = f[comments] as any[];
        if (!commentList || commentList.length === 0) {
            return { ...f, [likeCounts]: [] };
        }
        const ids = commentList.map(c => c._id);
        const countResult = await Liking._countForItems({ items: ids });
        return { ...f, [likeCounts]: countResult[0].counts };
    }));
    frames = new Frames(...framesWithLikes);

    // 8. Hydrate User Like Status (isLiked)
    const framesWithUserLikes = await Promise.all(frames.map(async f => {
        const uid = f[userId] as string | undefined;
        if (!uid) {
            return { ...f, [userLikedItems]: [] };
        }
        // Cast string to ID
        const userID = uid as ID;
        const likedResult = await Liking._likedItems({ user: userID });
        return { ...f, [userLikedItems]: likedResult[0].items };
    }));
    frames = new Frames(...framesWithUserLikes);

    // 9. Assemble Response
    const finalFrames = frames.map(f => {
        const commentList = (f[comments] as any[]) || [];
        const profileList = (f[profiles] as any[]) || [];
        const countList = (f[likeCounts] as any[]) || [];
        const likedList = (f[userLikedItems] as any[]) || [];
        const pr = f[pageResult] as any;
        const uid = f[userId] as string | undefined;

        const profileMap = new Map(profileList.map(p => [String(p._id), p]));
        const countMap = new Map(countList.map(c => [String(c.item), c.n]));
        const likedSet = new Set(likedList.map(id => String(id)));

        const hydratedComments = commentList.map(c => {
            const authorIdStr = String(c.author);
            const authorProfile = profileMap.get(authorIdStr);
            const commentIdStr = String(c._id);
            
            return {
                _id: commentIdStr,
                content: c.content,
                author: authorProfile ? {
                    _id: String(authorProfile._id),
                    userId: String(authorProfile._id),
                    username: authorProfile.username,
                    displayName: authorProfile.name
                } : { _id: authorIdStr, userId: authorIdStr, username: "Unknown", displayName: "Unknown" },
                likeCount: countMap.get(commentIdStr) || 0,
                isLiked: likedSet.has(commentIdStr),
                isOwner: uid ? authorIdStr === uid : false,
                createdAt: c.createdAt
            };
        });

        const pagination = {
            page: pr?.page || 1,
            totalPages: pr?.totalPages || 0,
            totalItems: pr?.totalItems || 0,
            pageSize: pr?.pageSize || 10
        };

        return {
            ...f,
            [responseBody]: {
                comments: hydratedComments,
                pagination
            }
        };
    });
    
    return new Frames(...finalFrames);
  },
  then: actions([
    Requesting.respond,
    { request, responseBody } 
  ])
});

// 404 Sync
export const GetPostCommentsNotFound: Sync = ({ request, path, postId, post }) => ({
  when: actions([
    Requesting.request,
    { method: "GET", path },
    { request },
  ]),
  where: async (frames) => {
    const mappedFrames = frames.map(f => {
      const p = f[path] as string;
      const match = p.match(COMMENTS_PATH_REGEX);
      return match ? { ...f, [postId]: match[1] } : null;
    }).filter(f => f !== null);

    if (mappedFrames.length === 0) return new Frames();
    frames = new Frames(...mappedFrames);

    frames = await frames.query(Posting._getPost, { postId }, { post });
    return frames.filter(f => !f[post]);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Post not found" }
  ])
});
