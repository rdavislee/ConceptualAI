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
