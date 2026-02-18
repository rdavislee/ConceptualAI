# Frontend Agent Guide: Add Simple Social Mechanics to User Testing

This guide is based on the exported app graph in `simple-social-app-graph.json` for project **Simple Social**.

## Goal

Integrate a "User Testing Thread" into the existing app so testers can:

- Post issues/feedback during tests
- Comment on posts
- Like important posts/comments
- Access login/register when unauthenticated
- Complete profile creation before using the thread

## Source-Of-Truth Flows From App Graph

From `simple-social-app-graph.json`:

- **Auth routes/pages**
  - `/login`
  - `/register`
- **Profile onboarding route/page**
  - `/onboarding` (create profile)
- **Thread routes/pages**
  - `/posts` (global feed)
  - `/posts/{postId}` (post detail + comments)
  - `/posts/new` (create post)
  - `/posts/{postId}/edit` (edit post)
- **Profile routes/pages**
  - `/me`, `/me/edit`, `/profiles/{username}`

Core edge logic to keep:

- Root load:
  - `!isAuthenticated -> /login`
  - `isAuthenticated -> /posts`
- Register success:
  - `POST /auth/register -> /onboarding`
- Feed load:
  - If profile missing (`GET /me/profile` returns `404`) -> `/onboarding`

## Integration Strategy: "User Testing Thread" Page

If you do not want to expose Simple Social as the app's primary root flow, map it behind a new route such as:

- `/testing/thread` -> behaves like graph node `feed`
- `/testing/thread/:postId` -> behaves like `post_detail`
- `/testing/thread/new` -> behaves like `create_post`
- `/testing/thread/:postId/edit` -> behaves like `edit_post`

Keep the interaction mechanics identical to the graph:

- Feed listing, sorting, pagination
- Create post
- Like/unlike post
- Open post detail
- Post detail comment list + add/edit/delete comment
- Like/unlike comment

## Required API Surface

Use these endpoints as the backing API:

- Auth:
  - `POST /auth/login`
  - `POST /auth/register`
  - `POST /auth/refresh`
  - `POST /auth/logout`
- Profile:
  - `GET /me/profile`
  - `POST /me/profile`
  - `PATCH /me/profile`
  - `GET /profiles/{username}`
- Posts:
  - `GET /posts`
  - `POST /posts`
  - `GET /posts/{postId}`
  - `PATCH /posts/{postId}`
  - `DELETE /posts/{postId}`
  - `POST /posts/{postId}/like`
  - `DELETE /posts/{postId}/like`
  - `GET /users/{userId}/posts`
  - `GET /me/posts`
- Comments:
  - `GET /posts/{postId}/comments`
  - `POST /posts/{postId}/comments`
  - `GET /comments/{commentId}`
  - `PATCH /comments/{commentId}`
  - `DELETE /comments/{commentId}`
  - `POST /comments/{commentId}/like`
  - `DELETE /comments/{commentId}/like`

## Auth and Routing Rules (Must Implement)

### 1) Session bootstrap

On app load:

1. Read persisted access token.
2. If no token -> route to `/login`.
3. If token exists, fetch `GET /me/profile`:
   - `200` -> user is onboarded
   - `404` -> route to `/onboarding`
   - `401` -> clear tokens and route to `/login`

### 2) Protected route guard

For any thread/profile protected route:

- If no token, redirect to `/login`.
- If API returns `401`, clear session and redirect to `/login`.

### 3) Registration and onboarding

After successful `POST /auth/register`:

- Save tokens.
- Route user to `/onboarding` (profile creation page).

After successful `POST /me/profile`:

- Route to `/testing/thread` (or `/posts` if using original graph routes).

### 4) Logout

On logout:

- Call `POST /auth/logout`
- Clear session locally regardless of API result
- Redirect to `/login`

## New/Updated Frontend Pages

Implement these pages (or equivalent route components):

1. **Login page** (`/login`)
   - email + password
   - submit -> `POST /auth/login`
   - link to `/register`

2. **Register page** (`/register`)
   - email + password (+ any required user fields used by your app)
   - submit -> `POST /auth/register`
   - on success -> `/onboarding`
   - link to `/login`

3. **Profile creation page** (`/onboarding`)
   - required: `username`, `displayName`
   - optional: `bio`
   - submit -> `POST /me/profile`
   - on success -> thread feed

4. **User Testing Thread feed** (`/testing/thread`)
   - list via `GET /posts`
   - create CTA -> `/testing/thread/new`
   - item click -> `/testing/thread/:postId`
   - post likes in list

5. **Create post page** (`/testing/thread/new`)
   - submit -> `POST /posts`
   - on success -> post detail

6. **Post detail page** (`/testing/thread/:postId`)
   - load post + comments
   - add comment, like/unlike, edit/delete for owner
   - navigate to author profile

7. **Edit post page** (`/testing/thread/:postId/edit`)
   - submit -> `PATCH /posts/{postId}`
   - cancel/back -> post detail

## Data/State Notes

- Preserve server-driven booleans: `isOwner`, `isLiked`.
- Render owner-only controls from `isOwner` (edit/delete actions).
- Do optimistic UI for like/unlike if desired; always reconcile from server result.
- For comment and post list refreshes, refetch target page after mutations.

## Error Handling Contract

- `401`: clear session + redirect `/login`.
- `404` from `GET /me/profile`: redirect `/onboarding`.
- `404` for missing post/comment/profile pages: show not-found state.
- `400` validation errors: inline form errors or toast.
- `403` ownership errors: toast + disable owner actions.

## Suggested Acceptance Criteria

- Unauthenticated user attempting `/testing/thread` is redirected to `/login`.
- New user can register -> create profile -> access thread.
- Existing authenticated user without profile is forced to `/onboarding`.
- Users can create post, comment, like/unlike post and comments.
- Owner-only actions (edit/delete) appear and work correctly.
- Logout clears session and always returns user to `/login`.

## Implementation Handoff Prompt (for frontend agent)

Use this exact instruction set:

1. Build/extend routes for `/login`, `/register`, `/onboarding`, and `/testing/thread` (plus nested detail/new/edit routes).
2. Add route guards so unauthenticated users are redirected to `/login`.
3. Add bootstrap logic to call `GET /me/profile` after login/session restore:
   - `404` -> `/onboarding`
   - `401` -> clear session + `/login`
4. Implement full thread mechanics using the endpoints listed above.
5. Enforce owner controls from `isOwner`, and preserve like states from `isLiked`.
6. Ensure logout calls `POST /auth/logout`, clears tokens, and redirects to `/login`.

