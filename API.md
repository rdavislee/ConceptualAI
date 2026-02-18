# ConceptualAI API Documentation

All API endpoints are prefixed with `/api`.
Most endpoints require an `Authorization: Bearer <token>` header unless otherwise specified.

## Gemini Credential Headers (Required for Pipeline Triggers)

The following endpoints require Gemini BYOK headers:

- `POST /projects`
- `POST /projects/:projectId/clarify`
- `PUT /projects/:projectId/plan`
- `POST /projects/:projectId/design`
- `PUT /projects/:projectId/design`
- `POST /projects/:projectId/implement`
- `POST /projects/:projectId/syncs`
- `POST /projects/:projectId/assemble`
- `POST /projects/:projectId/build`

Required headers:

- `X-Gemini-Api-Key: <user_key>`
- `X-Gemini-Tier: <tier>`

Tier policy:

- Allowed: `1`, `2`, `3`
- Rejected: `0` (free tier unsupported), missing tier, or any other value

Validation behavior:

- `400` when key/tier is missing or invalid
- `400` when key is valid but does not satisfy non-free tier capability checks
- `503` when provider/network verification is temporarily unavailable

## Server Capacity Limits

The server enforces a maximum number of concurrent sandbox containers via the `MAX_CONCURRENT_SANDBOXES` environment variable (default: `20`).

When the limit is reached, any pipeline-triggering endpoint that provisions a sandbox will return a `200` response with an error payload:

```json
{
  "error": "Server is at capacity (20 concurrent sandboxes). Please try again in a few minutes."
}
```

Affected endpoints (all pipeline triggers that provision a sandbox):

- `POST /projects`
- `POST /projects/:projectId/clarify`
- `PUT /projects/:projectId/plan`
- `POST /projects/:projectId/design`
- `PUT /projects/:projectId/design`
- `POST /projects/:projectId/implement`
- `POST /projects/:projectId/syncs`
- `POST /projects/:projectId/assemble`
- `POST /projects/:projectId/build`

Non-sandbox endpoints (auth, project listing, downloads, social) are **not** affected by this limit.

Clients should handle this by displaying a "server busy" message and allowing the user to retry after a short wait.

## Stage-Aware Getter Behavior

During active pipeline stages, stage getters are long-poll style: they wait until the stage is finished before returning the resource.

Behavior by stage:

- `planning` -> `GET /projects/:projectId/plan`
- `designing` -> `GET /projects/:projectId/design`
- `implementing` -> `GET /projects/:projectId/implementations`
- `sync_generating` -> `GET /projects/:projectId/syncs`
- `building` -> `GET /projects/:projectId/build/status` (and `/projects/:projectId/assemble/status`)

Rules:

- If project is in the matching `-ing` stage **and** an active sandbox exists, the request waits and responds when the stage exits.
- If project is in the matching `-ing` stage but **no active sandbox** exists, the API returns `409` to avoid indefinite waiting.

Example `409` response:

```json
{
  "error": "Project is marked as planning but no active sandbox exists. Please retry planning."
}
```

Equivalent messages are returned for `designing`, `implementing`, `sync_generating`, and `building`.

## Authentication

### Register
Create a new user account and receive session tokens.

- **URL:** `/auth/register`
- **Method:** `POST`
- **Auth Required:** No
- **Body:**
  ```json
  {
    "email": "user@example.com",
    "password": "securePassword123",
    "name": "John Doe",
    "username": "jdoe"
  }
  ```
- **Success Response (200):**
  ```json
  {
    "user": "user_id_string",
    "accessToken": "jwt_access_token",
    "refreshToken": "jwt_refresh_token"
  }
  ```

### Login
Authenticate an existing user.

- **URL:** `/auth/login`
- **Method:** `POST`
- **Auth Required:** No
- **Body:**
  ```json
  {
    "email": "user@example.com",
    "password": "securePassword123"
  }
  ```
- **Success Response (200):**
  ```json
  {
    "user": "user_id_string",
    "accessToken": "jwt_access_token",
    "refreshToken": "jwt_refresh_token"
  }
  ```

### Refresh Token
Get a new access token using a refresh token.

- **URL:** `/auth/refresh`
- **Method:** `POST`
- **Auth Required:** No (uses token in body)
- **Body:**
  ```json
  {
    "refreshToken": "jwt_refresh_token"
  }
  ```
- **Success Response (200):**
  ```json
  {
    "accessToken": "new_jwt_access_token",
    "refreshToken": "new_jwt_refresh_token"
  }
  ```

### Logout
Invalidate the current session.

- **URL:** `/auth/logout`
- **Method:** `POST`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "status": "logged_out"
  }
  ```

### Get Current User
Validate the session and get current user ID.

- **URL:** `/auth/_getUser`
- **Method:** `POST`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "user": "user_id_string"
  }
  ```

## Projects

### Create Project
Initialize a new project and start the planning process.

- **URL:** `/projects`
- **Method:** `POST`
- **Auth Required:** Yes
- **Body:**
  ```json
  {
    "name": "My New App",
    "description": "A description of the app idea..."
  }
  ```
- **Success Response (200):**
  Returns the project status, and potentially the plan or clarification questions.
  ```json
  {
    "project": "project_id",
    "status": "planning_complete", // or "awaiting_input"
    "plan": { ... }, // if status is planning_complete
    "questions": [ ... ] // if status is awaiting_input
  }
  ```

### List Projects
Get all projects owned by the authenticated user.

- **URL:** `/projects`
- **Method:** `GET`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "projects": [
      {
        "_id": "project_id",
        "name": "My New App",
        "status": "planning_complete",
        ...
      }
    ]
  }
  ```

### Get Project
Get details of a specific project.

- **URL:** `/projects/:projectId`
- **Method:** `GET`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "project": {
      "_id": "project_id",
      ...
    }
  }
  ```

### Delete Project
Delete a project and all its associated data (plans, designs).

- **URL:** `/projects/:projectId`
- **Method:** `DELETE`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "status": "deleted"
  }
  ```

## Planning

### Clarify Plan
Provide answers to clarifying questions to resume planning.

- **URL:** `/projects/:projectId/clarify`
- **Method:** `POST`
- **Auth Required:** Yes
- **Body:**
  ```json
  {
    "answers": {
      "Question 1?": "Answer 1",
      "Question 2?": "Answer 2"
    }
  }
  ```
- **Success Response (200):**
  Same as Create Project response (`project` + status + plan or questions).

### Modify Plan
Request changes to a generated plan.

- **URL:** `/projects/:projectId/plan`
- **Method:** `PUT`
- **Auth Required:** Yes
- **Body:**
  ```json
  {
    "feedback": "Please add a dark mode feature."
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "planning_complete", // or "awaiting_input"
    "plan": { ... updated plan ... }, // when planning is complete
    "questions": [ ... ] // when more clarification is needed
  }
  ```

### Get Plan
Retrieve the current plan for a project.

- **URL:** `/projects/:projectId/plan`
- **Method:** `GET`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "plan": {
      "summary": "...",
      "entities": [...],
      ...
    }
  }
  ```

## Designing

### Trigger Design
Start the concept design phase using the approved plan.

- **URL:** `/projects/:projectId/design`
- **Method:** `POST`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "design_complete",
    "design": {
      "libraryPulls": [...],
      "customConcepts": [...]
    }
  }
  ```
- **Notes:**
  - This endpoint provisions a sandbox and runs the design phase there.

### Modify Design
Request changes to a generated design. This triggers a flow where the plan is first updated (if necessary) based on feedback, and then the design is revised.

- **URL:** `/projects/:projectId/design`
- **Method:** `PUT`
- **Auth Required:** Yes
- **Body:**
  ```json
  {
    "feedback": "Please add a tagging system to the notes."
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "design_complete",
    "design": {
      "libraryPulls": [...],
      "customConcepts": [...]
    }
  }
  ```

### Get Design
Retrieve the generated design.

- **URL:** `/projects/:projectId/design`
- **Method:** `GET`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "design": { ... }
  }
  ```

## Implementing

### Trigger Implementation
Start the implementation phase using the approved design. This will generate code for custom concepts and pull library concepts.

- **URL:** `/projects/:projectId/implement`
- **Method:** `POST`
- **Auth Required:** Yes
- **Prerequisites:**
  - Project status is `design_complete`
  - A design exists for the project
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "implemented",
    "implementations": {
      "ConceptName": {
        "code": "...",
        "tests": "...",
        "spec": "...",
        "status": "complete",
        "iterations": 1
      },
      ...
    }
  }
  ```
- **Notes:**
  - This endpoint provisions a sandbox and runs implementation there.

### Get Implementations
Retrieve the generated implementations for a project.

- **URL:** `/projects/:projectId/implementations`
- **Method:** `GET`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "implementations": {
      "ConceptName": {
        "code": "...",
        "tests": "...",
        "spec": "...",
        "status": "complete",
        "iterations": 1
      },
      ...
    }
  }
  ```

## Sync Generating

### Trigger Sync Generation
Start the sync generation phase using the approved implementations. This will generate the API surface, sync definitions, and tests.

- **URL:** `/projects/:projectId/syncs`
- **Method:** `POST`
- **Auth Required:** Yes
- **Prerequisites:** Project status must be one of:
  - `implemented`
  - `syncs_generated`
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "syncs_generated",
    "syncs": [ ... ],
    "apiDefinition": { ... },
    "endpointBundles": [ ... ]
  }
  ```
- **Notes:**
  - This endpoint provisions a sandbox and runs sync generation there.

### Get Syncs
Retrieve the generated sync artifacts for a project.

- **URL:** `/projects/:projectId/syncs`
- **Method:** `GET`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "syncs": [ ... ],
    "apiDefinition": { ... },
    "endpointBundles": [ ... ]
  }
  ```

## Assembling (Backend-Only, Sandboxed)

### Trigger Assembly
Run backend assembly only (no frontend generation) using the sandboxed assembly path.

- **URL:** `/projects/:projectId/assemble`
- **Method:** `POST`
- **Auth Required:** Yes
- **Prerequisites:** Project status must be one of:
  - `syncs_generated`
  - `assembled`
  - `complete`
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "complete",
    "downloadUrl": "/api/downloads/:projectId_backend.zip"
  }
  ```
- **Error Response (500):**
  ```json
  {
    "project": "project_id",
    "statusCode": 500,
    "error": "Assembly failed ..."
  }
  ```
- **Notes:**
  - This path provisions a sandbox internally (`Sandboxing.provision`) and runs backend assembly there.
  - This endpoint is intended for backend-only assembly.

## Building (Backend + Frontend, Sandboxed)

The Build endpoint provisions one sandbox and runs both backend assembly and frontend generation inside that same sandbox session.

### Trigger Build
Start both backend assembly and frontend generation for a project.

- **URL:** `/projects/:projectId/build`
- **Method:** `POST`
- **Auth Required:** Yes
- **Prerequisites:** Project status must be one of:
  - `syncs_generated`
  - `building`
  - `assembled`
  - `complete`
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "complete",
    "backend": {
      "status": "complete",
      "downloadUrl": "/api/downloads/:projectId_backend.zip"
    },
    "frontend": {
      "status": "complete",
      "downloadUrl": "/api/downloads/:projectId_frontend.zip"
    }
  }
  ```
- **Important:**
  - `backend.downloadUrl` and `frontend.downloadUrl` are returned as concrete URL strings in the `POST /build` response.
  - Clients can use these URLs immediately (no frontend reload required).
- **Notes:**
  - Both backend assembly and frontend generation run in the same sandbox lifecycle.
  - The sandbox has a 2-hour hard timeout and automatic cleanup.
  - Project status changes to `assembled` only when **both** complete.
  - This endpoint is the primary source of final download links for a build request.

### Get Build Status
Check the status of both backend and frontend generation.

- **URL:** `/projects/:projectId/build/status`
- **Method:** `GET`
- **Auth Required:** Yes
- **Alias:** `/projects/:projectId/assemble/status` (backwards compatibility path)
- **Success Response (200) - In Progress:**
  ```json
  {
    "status": "processing",
    "backend": {
      "status": "complete",
      "downloadUrl": "/api/downloads/:projectId_backend.zip"
    },
    "frontend": {
      "status": "processing",
      "downloadUrl": null
    }
  }
  ```
- **Success Response (200) - Complete:**
  ```json
  {
    "status": "complete",
    "backend": {
      "status": "complete",
      "downloadUrl": "/api/downloads/:projectId_backend.zip"
    },
    "frontend": {
      "status": "complete",
      "downloadUrl": "/api/downloads/:projectId_frontend.zip"
    }
  }
  ```
- **Error Response (401):**
  ```json
  {
    "statusCode": 401,
    "error": "Unauthorized"
  }
  ```
- **Possible Status Values:**
  - `processing`: Generation in progress (at least one not complete)
  - `complete`: Both backend and frontend finished successfully
  - `error`: Frontend generation failed
- **Important Notes:**
  - This endpoint reports **combined** backend + frontend status.
  - `X-Gemini-Api-Key` + `X-Gemini-Tier` are optional here. If supplied and valid, the backend may auto-retry stuck frontend builds. Without them, this endpoint is read-only status polling.
  - If you only trigger `/assemble` (backend-only) and never run `/build`, frontend may remain `processing`, so overall status may not become `complete` here.
  - Use a valid (non-expired) access token when polling; if your token expires, refresh it first.
  - This endpoint is intended for polling/recovery. If `POST /build` already returned `complete` with URLs, clients can use those links directly.

### Download Backend
Download the assembled backend project (concepts, syncs, API server).

- **URL:** `/downloads/:projectId_backend.zip`
- **Method:** `GET`
- **Auth Required:** Yes (Access Token in Header)
- **Response Headers:**
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment; filename="backend.zip"`
- **Success Response (200):**
  Binary zip file content.

### Download Frontend
Download the generated frontend project (React application).

- **URL:** `/downloads/:projectId_frontend.zip`
- **Method:** `GET`
- **Auth Required:** Yes (Access Token in Header)
- **Response Headers:**
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment; filename="frontend.zip"`
- **Success Response (200):**
  Binary zip file content.

### Download Project (Legacy/Backwards Compatibility)
Download the backend project using the legacy URL format.

- **URL:** `/downloads/:projectId.zip`
- **Method:** `GET`
- **Auth Required:** Yes (Access Token in Header)
- **Response Headers:**
  - `Content-Type: application/zip`
  - `Content-Disposition: attachment; filename="project.zip"`
- **Success Response (200):**
  Binary zip file content (backend only).

## Social Thread API (Bug Reporting)

These endpoints power a shared issue-reporting thread where users can post bug reports,
comment on issues, and like important items.

### Delete My Account
Delete the authenticated user's account and associated social data.

- **URL:** `/me`
- **Method:** `DELETE`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {}
  ```

### Get My Profile
Get the authenticated user's profile.

- **URL:** `/me/profile`
- **Method:** `GET`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "profile": {
      "_id": "user_id",
      "userId": "user_id",
      "username": "jdoe",
      "displayName": "John Doe",
      "bio": "I report product bugs.",
      "createdAt": "2026-02-17T00:00:00.000Z",
      "updatedAt": "2026-02-17T00:00:00.000Z"
    }
  }
  ```
- **Error Responses:**
  - `401`: Unauthorized
  - `404`: Profile not yet created

### Create My Profile
Create the authenticated user's profile (onboarding).

- **URL:** `/me/profile`
- **Method:** `POST`
- **Auth Required:** Yes
- **Body:**
  ```json
  {
    "username": "jdoe",
    "displayName": "John Doe",
    "bio": "I report product bugs."
  }
  ```
- **Success Response (201):**
  ```json
  {
    "profile": {
      "_id": "user_id",
      "userId": "user_id",
      "username": "jdoe",
      "displayName": "John Doe",
      "bio": "I report product bugs.",
      "createdAt": "2026-02-17T00:00:00.000Z",
      "updatedAt": "2026-02-17T00:00:00.000Z"
    }
  }
  ```
- **Error Responses:**
  - `400`: Invalid input (for example missing required fields or username taken)
  - `401`: Unauthorized
  - `403`: Profile already exists

### Update My Profile
Update one or more profile fields for the authenticated user.

- **URL:** `/me/profile`
- **Method:** `PATCH`
- **Auth Required:** Yes
- **Body (all fields optional, at least one required):**
  ```json
  {
    "displayName": "John D.",
    "bio": "Now focusing on bug triage.",
    "username": "john-dev"
  }
  ```
- **Success Response (200):**
  ```json
  {
    "profile": {
      "_id": "user_id",
      "userId": "user_id",
      "username": "john-dev",
      "displayName": "John D.",
      "bio": "Now focusing on bug triage.",
      "createdAt": "2026-02-17T00:00:00.000Z",
      "updatedAt": "2026-02-17T00:05:00.000Z"
    }
  }
  ```
- **Error Responses:**
  - `400`: No fields provided or invalid update
  - `401`: Unauthorized

### Get Public Profile
Get a public profile by username.

- **URL:** `/profiles/:username`
- **Method:** `GET`
- **Auth Required:** No
- **Success Response (200):**
  ```json
  {
    "profile": {
      "_id": "user_id",
      "userId": "user_id",
      "username": "jdoe",
      "displayName": "John Doe",
      "bio": "I report product bugs.",
      "createdAt": "2026-02-17T00:00:00.000Z",
      "updatedAt": "2026-02-17T00:00:00.000Z"
    }
  }
  ```
- **Error Response (404):**
  ```json
  {
    "error": "Profile not found"
  }
  ```

### List Global Posts
List posts from the global bug-report feed.

- **URL:** `/posts`
- **Method:** `GET`
- **Auth Required:** Optional
- **Query Params:**
  - `page` (number, default `1`)
  - `pageSize` (number, default `10`, supported values include `10`, `20`, `30`)
  - `sort` (`createdAt` or `score`, default `createdAt`)
- **Success Response (200):**
  ```json
  {
    "posts": [
      {
        "_id": "post_id",
        "content": { "text": "Search crashes on large files." },
        "author": {
          "_id": "user_id",
          "userId": "user_id",
          "username": "jdoe",
          "displayName": "John Doe"
        },
        "likeCount": 3,
        "isLiked": true,
        "isOwner": false,
        "createdAt": "2026-02-17T00:00:00.000Z",
        "updatedAt": "2026-02-17T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "totalPages": 2,
      "totalItems": 12,
      "pageSize": 10
    }
  }
  ```

### Create Post
Create a new bug-report post.

- **URL:** `/posts`
- **Method:** `POST`
- **Auth Required:** Yes
- **Body:**
  ```json
  {
    "content": {
      "text": "Unable to submit feedback from settings screen."
    }
  }
  ```
- **Success Response (201):**
  ```json
  {
    "post": {
      "_id": "post_id",
      "content": { "text": "Unable to submit feedback from settings screen." },
      "author": {
        "_id": "user_id",
        "userId": "user_id",
        "username": "jdoe",
        "displayName": "John Doe"
      },
      "likeCount": 0,
      "isLiked": false,
      "isOwner": true,
      "createdAt": "2026-02-17T00:00:00.000Z",
      "updatedAt": "2026-02-17T00:00:00.000Z"
    }
  }
  ```
- **Error Responses:**
  - `400`: Invalid post content
  - `401`: Unauthorized

### Get Post
Get a single post by ID.

- **URL:** `/posts/:postId`
- **Method:** `GET`
- **Auth Required:** Optional
- **Success Response (200):**
  ```json
  {
    "post": {
      "_id": "post_id",
      "content": { "text": "Search crashes on large files." },
      "author": {
        "_id": "user_id",
        "userId": "user_id",
        "username": "jdoe",
        "displayName": "John Doe"
      },
      "likeCount": 3,
      "isLiked": false,
      "isOwner": false,
      "createdAt": "2026-02-17T00:00:00.000Z",
      "updatedAt": "2026-02-17T00:00:00.000Z"
    }
  }
  ```
- **Error Response (404):**
  ```json
  {
    "error": "Post not found"
  }
  ```

### Edit Post
Edit an existing post (owner only).

- **URL:** `/posts/:postId`
- **Method:** `PATCH`
- **Auth Required:** Yes
- **Body:**
  ```json
  {
    "content": {
      "text": "Updated: crash occurs when searching nested folders."
    }
  }
  ```
- **Success Response (200):**
  ```json
  {
    "post": {
      "_id": "post_id",
      "content": { "text": "Updated: crash occurs when searching nested folders." }
    }
  }
  ```
- **Error Responses:**
  - `401`: Unauthorized
  - `403`: Access denied
  - `404`: Post not found

### Delete Post
Delete an existing post (owner only).

- **URL:** `/posts/:postId`
- **Method:** `DELETE`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {}
  ```
- **Error Responses:**
  - `401`: Unauthorized
  - `403`: Not authorized

### Like Post
Like a post.

- **URL:** `/posts/:postId/like`
- **Method:** `POST`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "likeCount": 4,
    "isLiked": true
  }
  ```
- **Error Responses:**
  - `400`: Already liked or other like error
  - `401`: Unauthorized
  - `404`: Post not found

### Unlike Post
Remove a like from a post.

- **URL:** `/posts/:postId/like`
- **Method:** `DELETE`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "likeCount": 3,
    "isLiked": false
  }
  ```
- **Error Responses:**
  - `400`: Unlike failed (for example, post not previously liked)
  - `401`: Unauthorized

### List Comments for Post
List comments for a given post.

- **URL:** `/posts/:postId/comments`
- **Method:** `GET`
- **Auth Required:** Optional
- **Query Params:**
  - `page` (number, default `1`)
  - `sort` (`createdAt` or `score`, default `createdAt`)
  - `pageSize` (number, default `10`)
- **Success Response (200):**
  ```json
  {
    "comments": [
      {
        "_id": "comment_id",
        "postId": "post_id",
        "content": "I can reproduce this on Windows.",
        "author": {
          "_id": "user_id",
          "userId": "user_id",
          "username": "jdoe",
          "displayName": "John Doe"
        },
        "likeCount": 2,
        "isLiked": false,
        "isOwner": false,
        "createdAt": "2026-02-17T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "totalPages": 1,
      "totalItems": 1,
      "pageSize": 10
    }
  }
  ```
- **Error Response (404):**
  ```json
  {
    "error": "Post not found"
  }
  ```

### Add Comment to Post
Create a comment on a post.

- **URL:** `/posts/:postId/comments`
- **Method:** `POST`
- **Auth Required:** Yes
- **Body:**
  ```json
  {
    "content": "This issue also appears in dark mode."
  }
  ```
- **Success Response (201):**
  ```json
  {
    "comment": {
      "_id": "comment_id",
      "postId": "post_id",
      "content": "This issue also appears in dark mode."
    }
  }
  ```
- **Error Responses:**
  - `400`: Invalid comment payload
  - `401`: Unauthorized
  - `404`: Post not found

### Get Comment
Get a single comment by ID.

- **URL:** `/comments/:commentId`
- **Method:** `GET`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "comment": {
      "_id": "comment_id",
      "postId": "post_id",
      "content": "I can reproduce this on Windows.",
      "author": {
        "_id": "user_id",
        "userId": "user_id",
        "username": "jdoe",
        "displayName": "John Doe"
      },
      "likeCount": 2,
      "isLiked": true,
      "isOwner": false,
      "createdAt": "2026-02-17T00:00:00.000Z",
      "updatedAt": "2026-02-17T00:00:00.000Z"
    }
  }
  ```
- **Error Responses:**
  - `401`: Unauthorized
  - `404`: Comment not found

### Edit Comment
Edit an existing comment (owner only).

- **URL:** `/comments/:commentId`
- **Method:** `PATCH`
- **Auth Required:** Yes
- **Body:**
  ```json
  {
    "content": "Updated: still reproducible in latest release."
  }
  ```
- **Success Response (200):**
  ```json
  {
    "comment": {
      "_id": "comment_id",
      "postId": "post_id",
      "content": "Updated: still reproducible in latest release."
    }
  }
  ```
- **Error Responses:**
  - `401`: Unauthorized
  - `403`: Access denied
  - `404`: Comment not found

### Delete Comment
Delete an existing comment (owner only).

- **URL:** `/comments/:commentId`
- **Method:** `DELETE`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {}
  ```
- **Error Responses:**
  - `401`: Unauthorized
  - `403`: Not authorized or deletion error

### Like Comment
Like a comment.

- **URL:** `/comments/:commentId/like`
- **Method:** `POST`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "likeCount": 3,
    "isLiked": true
  }
  ```
- **Error Responses:**
  - `400`: Already liked or other like error
  - `401`: Unauthorized
  - `404`: Comment not found

### Unlike Comment
Remove a like from a comment.

- **URL:** `/comments/:commentId/like`
- **Method:** `DELETE`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "likeCount": 2,
    "isLiked": false
  }
  ```
- **Error Responses:**
  - `400`: Unlike failed (for example, comment not previously liked)
  - `401`: Unauthorized
  - `404`: Comment not found

### List User Posts
List posts for a specific user profile.

- **URL:** `/users/:userId/posts`
- **Method:** `GET`
- **Auth Required:** Optional
- **Query Params:**
  - `page` (number, default `1`)
- **Success Response (200):**
  ```json
  {
    "posts": [
      {
        "_id": "post_id",
        "content": { "text": "Search crashes on large files." },
        "author": {
          "_id": "user_id",
          "userId": "user_id",
          "username": "jdoe",
          "displayName": "John Doe"
        },
        "likeCount": 3,
        "isLiked": false,
        "isOwner": false,
        "createdAt": "2026-02-17T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "totalPages": 1,
      "totalItems": 1,
      "pageSize": 10
    }
  }
  ```
- **Error Response (404):**
  ```json
  {
    "error": "User not found"
  }
  ```

### List My Posts
List posts created by the authenticated user.

- **URL:** `/me/posts`
- **Method:** `GET`
- **Auth Required:** Yes
- **Query Params:**
  - `page` (number, default `1`)
- **Success Response (200):**
  ```json
  {
    "posts": [
      {
        "_id": "post_id",
        "content": { "text": "Search crashes on large files." },
        "author": {
          "_id": "user_id",
          "userId": "user_id",
          "username": "jdoe",
          "displayName": "John Doe"
        },
        "likeCount": 3,
        "isLiked": true,
        "isOwner": true,
        "createdAt": "2026-02-17T00:00:00.000Z",
        "updatedAt": "2026-02-17T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "totalPages": 1,
      "totalItems": 1,
      "pageSize": 10
    }
  }
  ```
- **Error Response (401):**
  ```json
  {
    "error": "Unauthorized"
  }
  ```
