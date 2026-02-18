import { actions, Frames, Sync } from "@engine";
import { Requesting, Sessioning, Posting, Profiling, Liking, Paginating, db } from "@concepts";

const USER_POSTS_PATH = /^\/users\/([^\/]+)\/posts$/;

/**
 * GET /users/{userId}/posts (Authenticated)
 * List all posts by a specific user with pagination and hydration for a logged-in viewer.
 */
export const ListUserPostsAuth: Sync = ({
  request, path, userId, page, accessToken,
  items, totalPages, totalItems, pageSize,
  posts, profile, counts,
  viewer, likedItems, responsePosts, pagination
}) => ({
  when: actions([
    Requesting.request,
    { method: "GET", accessToken },
    { request }
  ]),
  where: async (frames) => {
    // 1. Parse Path and Query
    const requests = db.collection<any>("Requesting.requests");
    const parsed = await Promise.all(frames.map(async f => {
      const req = await requests.findOne({ _id: f[request] });
      if (!req) return null;
      const match = req.input.path.match(USER_POSTS_PATH);
      if (!match) return null;
      return {
        ...f,
        [userId]: match[1],
        [page]: Number(req.input.page || 1)
      };
    }));
    let current = new Frames(...parsed.filter(f => f !== null));
    if (current.length === 0) return current;

    // 2. Verify User & Get Profile
    current = await current.query(Profiling._getProfile, { user: userId }, { profile });
    current = current.filter(f => f[profile] !== null);

    // 3. Get Viewer Identity (Using the unredacted accessToken from 'when')
    current = await current.query(Sessioning._getUser, { session: accessToken }, { user: viewer });
    current = current.filter(f => f[viewer] !== undefined);

    // 4. Get Paginated Item IDs
    current = await current.query(
      Paginating._getPage, 
      { bound: userId, itemType: "userPosts", page, pageSize: 10 }, 
      { items, totalPages, totalItems, pageSize }
    );

    // 5. Hydrate Data
    current = await current.query(Posting._getPostsByIds, { postIds: items }, { posts });
    current = await current.query(Liking._countForItems, { items }, { counts });
    current = await current.query(Liking._likedItems, { user: viewer }, { items: likedItems });

    // 6. Format Response
    return current.map(f => {
      const pList = f[posts] as any[] || [];
      const cList = f[counts] as any[] || [];
      const lSet = new Set(f[likedItems] as string[] || []);
      const prof = f[profile] as any;
      const vId = f[viewer] as string;

      const hydrated = pList.map(p => {
        const pId = String(p._id);
        const countObj = cList.find(c => c.item === pId);
        return {
          _id: pId,
          content: p.content,
          author: {
            _id: prof._id,
            userId: prof._id,
            username: prof.username,
            displayName: prof.name
          },
          likeCount: countObj ? countObj.n : 0,
          isLiked: lSet.has(pId),
          isOwner: vId === p.author,
          createdAt: p.createdAt
        };
      });

      return {
        ...f,
        [responsePosts]: hydrated,
        [pagination]: {
          page: f[page],
          totalPages: f[totalPages],
          totalItems: f[totalItems],
          pageSize: f[pageSize]
        }
      };
    });
  },
  then: actions([
    Requesting.respond,
    { request, posts: responsePosts, pagination }
  ]),
});

/**
 * GET /users/{userId}/posts (Unauthenticated)
 * List all posts by a specific user for anonymous viewers.
 */
export const ListUserPostsUnauth: Sync = ({
  request, path, userId, page,
  items, totalPages, totalItems, pageSize,
  posts, profile, counts,
  responsePosts, pagination
}) => ({
  when: actions([
    Requesting.request,
    { method: "GET" },
    { request }
  ]),
  where: async (frames) => {
    // 1. Parse Path and filter out requests that HAVE an accessToken in the DB
    const requests = db.collection<any>("Requesting.requests");
    const parsed = await Promise.all(frames.map(async f => {
      const req = await requests.findOne({ _id: f[request] });
      // Mutual Exclusivity: Skip if accessToken is present (it will be handled by Auth sync)
      if (!req || req.input.accessToken) return null;
      
      const match = req.input.path.match(USER_POSTS_PATH);
      if (!match) return null;

      return {
        ...f,
        [userId]: match[1],
        [page]: Number(req.input.page || 1)
      };
    }));
    let current = new Frames(...parsed.filter(f => f !== null));
    if (current.length === 0) return current;

    // 2. Verify User & Get Profile
    current = await current.query(Profiling._getProfile, { user: userId }, { profile });
    current = current.filter(f => f[profile] !== null);

    // 3. Get Paginated Item IDs
    current = await current.query(
      Paginating._getPage, 
      { bound: userId, itemType: "userPosts", page, pageSize: 10 }, 
      { items, totalPages, totalItems, pageSize }
    );

    // 4. Hydrate Data
    current = await current.query(Posting._getPostsByIds, { postIds: items }, { posts });
    current = await current.query(Liking._countForItems, { items }, { counts });

    // 5. Format Response
    return current.map(f => {
      const pList = f[posts] as any[] || [];
      const cList = f[counts] as any[] || [];
      const prof = f[profile] as any;

      const hydrated = pList.map(p => {
        const pId = String(p._id);
        const countObj = cList.find(c => c.item === pId);
        return {
          _id: pId,
          content: p.content,
          author: {
            _id: prof._id,
            userId: prof._id,
            username: prof.username,
            displayName: prof.name
          },
          likeCount: countObj ? countObj.n : 0,
          isLiked: false,
          isOwner: false,
          createdAt: p.createdAt
        };
      });

      return {
        ...f,
        [responsePosts]: hydrated,
        [pagination]: {
          page: f[page],
          totalPages: f[totalPages],
          totalItems: f[totalItems],
          pageSize: f[pageSize]
        }
      };
    });
  },
  then: actions([
    Requesting.respond,
    { request, posts: responsePosts, pagination }
  ]),
});

/**
 * GET /users/{userId}/posts (Not Found)
 * Handle 404 when the target user profile does not exist.
 */
export const ListUserPostsNotFound: Sync = ({ request, path, userId, profile }) => ({
  when: actions([
    Requesting.request,
    { method: "GET" },
    { request }
  ]),
  where: async (frames) => {
    const requests = db.collection<any>("Requesting.requests");
    const parsed = await Promise.all(frames.map(async f => {
      const req = await requests.findOne({ _id: f[request] });
      if (!req) return null;
      const match = req.input.path.match(USER_POSTS_PATH);
      return match ? { ...f, [userId]: match[1] } : null;
    }));
    
    let current = new Frames(...parsed.filter(f => f !== null));
    if (current.length === 0) return current;

    // Filter for frames where the profile does not exist
    current = await current.query(Profiling._getProfile, { user: userId }, { profile });
    return current.filter(f => f[profile] === null);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "User not found" }
  ]),
});
