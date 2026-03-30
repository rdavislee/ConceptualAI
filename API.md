# ConceptualAI API Documentation

All API endpoints are prefixed with `/api`.
Most endpoints require an `Authorization: Bearer <token>` header unless otherwise specified.

## Polling Pattern for Long-Running Operations

All pipeline trigger endpoints (`POST /projects`, `POST /clarify`, `PUT /plan`, `POST /design`, `PUT /design`, `POST /implement`, `POST /syncs`, `POST /assemble`, `POST /build`) return **immediately** with a processing status (e.g. `{ "status": "planning" }`). They do **not** block until the sandbox completes.

The frontend should poll the corresponding `GET` endpoint every ~30 seconds to check progress:

| Trigger | Poll Endpoint | In-Progress Response |
|---------|---------------|---------------------|
| `POST /projects`, `POST /clarify`, `PUT /plan` | `GET /projects/:id/plan` | `{ "plan": { "status": "planning" } }` or `{ "plan": { "status": "awaiting_clarification", "questions": [...] } }` |
| `POST /design`, `PUT /design` | `GET /projects/:id/design` | `{ "design": { "status": "designing" } }` |
| `POST /implement` | `GET /projects/:id/implementations` | `{ "implementations": { "status": "implementing" } }` |
| `POST /syncs` | `GET /projects/:id/syncs` | `{ "syncs": { "status": "sync_generating" } }` |
| `POST /assemble`, `POST /build` | `GET /projects/:id/build/status` | `{ "status": "processing", ... }` |
| `POST /preview` | `GET /projects/:id/preview/status` | `{ "status": "processing" }` |

When the operation completes, the `GET` endpoint returns the actual data (without the `status` wrapper).

## Pipeline Autocomplete

All pipeline trigger endpoints accept an optional `enableAutocomplete` boolean in the JSON body.

- When `enableAutocomplete` is `true`, the backend stores `project.autocomplete = true` and automatically advances later stages inside the same sandbox instead of exiting after the requested stage.
- The chained order is `planning -> designing -> implementing -> sync generation -> build`.
- Each automatic handoff refreshes the sandbox timeout window.
- `autocomplete` resets to `false` if a stage fails, if planning needs more clarification, or when the pipeline reaches its terminal assembly/build phase.
- `GET /projects` and `GET /projects/:projectId` include the persisted `autocomplete` flag so clients can reflect the current pipeline mode.

## Gemini Credential Flow

Gemini-backed pipeline routes now use a stored credential flow instead of sending the raw Gemini API key on every trigger request.

### Credential lifecycle endpoints

- `GET /me/gemini-credential`
  - Returns `{ "hasGeminiCredential": false }` when no wrapped Gemini credential exists.
  - Returns `{ "hasGeminiCredential": true, "kdfSalt": "...", "kdfParams": { ... }, "encryptionVersion": "v1", "geminiTier": "2" }` when a wrapped Gemini credential exists.
- `PUT /me/gemini-credential`
  - Requires authentication.
  - Requires the account password again via `accountPassword` so the server can re-verify the session owner before replacing the stored Gemini credential.
  - Requires the raw Gemini key once via `X-Gemini-Api-Key` and `X-Gemini-Tier`.
  - Requires the wrapped credential payload via `ciphertext`, `iv`, `kdfSalt`, `kdfParams`, and `encryptionVersion`.
  - Validates the raw Gemini key before storing the wrapped credential.
  - Returns the same status payload as `GET /me/gemini-credential` so the client can immediately derive and cache the unwrap key after save.
- `DELETE /me/gemini-credential`
  - Deletes the stored wrapped Gemini credential for the authenticated user.

### Frontend flow

1. User logs in normally and the frontend keeps the account password only long enough to derive the Gemini unwrap key.
2. Frontend calls `GET /me/gemini-credential`.
3. If `hasGeminiCredential` is `true`, frontend derives the unwrap key client-side from the returned `kdfSalt` and `kdfParams`, then discards the password.
4. When first saving or rotating a Gemini credential, frontend sends:
   - `accountPassword`
   - `X-Gemini-Api-Key`
   - `X-Gemini-Tier`
   - `ciphertext`
   - `iv`
   - `kdfSalt`
   - `kdfParams`
   - `encryptionVersion`
5. For steady-state Gemini-backed pipeline requests, frontend sends `X-Gemini-Unwrap-Key` and does not resend the raw Gemini API key.

### Required header for Gemini-backed pipeline routes

The following routes require `X-Gemini-Unwrap-Key`:

- `POST /projects`
- `POST /projects/:projectId/clarify`
- `PUT /projects/:projectId/plan`
- `POST /projects/:projectId/design`
- `PUT /projects/:projectId/design`
- `POST /projects/:projectId/implement`
- `POST /projects/:projectId/syncs`
- `POST /projects/:projectId/assemble`
- `POST /projects/:projectId/build`
- `GET /projects/:projectId/build/status`
- `GET /projects/:projectId/assemble/status`

Behavior:

- `400` when `X-Gemini-Unwrap-Key` is missing
- `401` when the unwrap key cannot decrypt the stored Gemini credential
- `404` when no stored Gemini credential exists for the authenticated user
- `400` when the decrypted Gemini key resolves to unsupported tier `0`
- `400` when the decrypted Gemini key fails provider capability checks
- `503` when provider/network verification is temporarily unavailable

The raw `X-Gemini-Api-Key` / `X-Gemini-Tier` pair is only for `PUT /me/gemini-credential`, not for normal pipeline triggers.

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
- **Gemini Note:**
  - After login succeeds, the frontend should call `GET /me/gemini-credential`.
  - If the response includes KDF metadata, derive the Gemini unwrap key immediately while the password is still available in memory, then discard the password.

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

## Gemini Credential Management

### Get Gemini Credential Status
Check whether the authenticated user has a stored wrapped Gemini credential and, if present, fetch the KDF metadata needed to derive the unwrap key client-side.

- **URL:** `/me/gemini-credential`
- **Method:** `GET`
- **Auth Required:** Yes
- **Success Response (200) - No Stored Credential:**
  ```json
  {
    "hasGeminiCredential": false
  }
  ```
- **Success Response (200) - Stored Credential Exists:**
  ```json
  {
    "hasGeminiCredential": true,
    "kdfSalt": "base64-salt",
    "kdfParams": {
      "algorithm": "PBKDF2",
      "iterations": 600000
    },
    "encryptionVersion": "v1",
    "geminiTier": "2"
  }
  ```

### Save Or Replace Gemini Credential
Store a wrapped Gemini credential for the authenticated user. This route re-verifies the account password before replacing the existing wrapped credential.

- **URL:** `/me/gemini-credential`
- **Method:** `PUT`
- **Auth Required:** Yes
- **Headers:**
  - `X-Gemini-Api-Key: <raw_user_key>`
  - `X-Gemini-Tier: <tier>`
- **Body:**
  ```json
  {
    "accountPassword": "current-account-password",
    "ciphertext": "base64-ciphertext",
    "iv": "base64-iv",
    "kdfSalt": "base64-salt",
    "kdfParams": {
      "algorithm": "PBKDF2",
      "iterations": 600000
    },
    "encryptionVersion": "v1"
  }
  ```
- **Success Response (200):**
  ```json
  {
    "hasGeminiCredential": true,
    "kdfSalt": "base64-salt",
    "kdfParams": {
      "algorithm": "PBKDF2",
      "iterations": 600000
    },
    "encryptionVersion": "v1",
    "geminiTier": "2"
  }
  ```
- **Error Responses:**
  - `400`: Missing required credential fields
  - `400`: Invalid Gemini tier or unsupported provider capability
  - `401`: Invalid account password
  - `503`: Provider verification temporarily unavailable

### Delete Gemini Credential
Delete the authenticated user's stored wrapped Gemini credential.

- **URL:** `/me/gemini-credential`
- **Method:** `DELETE`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "ok": true
  }
  ```

### Create Project
Initialize a new project and start the planning process. Returns immediately while the sandbox runs in the background. Poll `GET /projects/:projectId/plan` for results.

- **URL:** `/projects`
- **Method:** `POST`
- **Auth Required:** Yes
- **Headers:**
  - `X-Gemini-Unwrap-Key: <client_derived_unwrap_key>`
- **Body:**
  ```json
  {
    "name": "My New App",
    "description": "A description of the app idea...",
    "enableAutocomplete": true
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "planning"
  }
  ```
- **Polling:** Use `GET /projects/:projectId/plan` every ~30 seconds until status is `planning_complete` or `awaiting_clarification`.

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
        "autocomplete": false,
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
      "autocomplete": false,
      ...
    }
  }
  ```

### Delete Project
Delete a project and all its associated data (plans, designs).

- **URL:** `/projects/:projectId`
- **Method:** `DELETE`
- **Auth Required:** Yes
- **Notes:**
  - Any hosted preview for the project is torn down and deleted as part of project deletion.
- **Success Response (200):**
  ```json
  {
    "status": "deleted"
  }
  ```

### Revert Project To Previous Stage
Revert a project back one lifecycle stage and clear artifacts for the current stage.

- **URL:** `/projects/:projectId/revert`
- **Method:** `POST`
- **Auth Required:** Yes
- **Behavior:**
  - If project is in `designing` or `design_complete`:
    - Deletes design artifacts
    - Sets status to `planning_complete`
  - If project is in `implementing` or `implemented`:
    - Deletes implementation artifacts
    - Sets status to `design_complete`
  - If project is in `sync_generating` or `syncs_generated`:
    - Deletes sync-generation artifacts
    - Sets status to `implemented`
  - If project is in `assembling`, `building`, `assembled`, or `complete`:
    - Deletes assembled backend artifact and generated frontend artifact
    - Sets status to `syncs_generated`
  - For working stages, any active sandbox for the project is torn down first (if present).
  - Any hosted preview for the project is also torn down/deleted during revert so preview state cannot outlive reverted build artifacts.
  - If project is in `planning`/`planned` (or equivalent first-stage statuses), revert is blocked.
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "design_complete",
    "revertedFrom": {
      "_id": "project_id",
      "status": "implemented",
      "...": "..."
    }
  }
  ```
- **Error Responses:**
  - `401`: Unauthorized
  - `403`: Access denied
  - `404`: Project not found
  - `409`: Cannot revert from planning/planned stages
  - `400`: Project status cannot be reverted

## Planning

### Clarify Plan
Provide answers to clarifying questions to resume planning. Returns immediately while the sandbox runs in the background.

- **URL:** `/projects/:projectId/clarify`
- **Method:** `POST`
- **Auth Required:** Yes
- **Headers:**
  - `X-Gemini-Unwrap-Key: <client_derived_unwrap_key>`
- **Body:**
  ```json
  {
    "answers": {
      "Question 1?": "Answer 1",
      "Question 2?": "Answer 2"
    },
    "enableAutocomplete": true
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "planning"
  }
  ```
- **Polling:** Use `GET /projects/:projectId/plan` every ~30 seconds until status is `planning_complete` or `awaiting_clarification`.

### Modify Plan
Request changes to a generated plan. Returns immediately while the sandbox runs in the background.

- **URL:** `/projects/:projectId/plan`
- **Method:** `PUT`
- **Auth Required:** Yes
- **Headers:**
  - `X-Gemini-Unwrap-Key: <client_derived_unwrap_key>`
- **Body:**
  ```json
  {
    "feedback": "Please add a dark mode feature.",
    "enableAutocomplete": true
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "planning"
  }
  ```
- **Polling:** Use `GET /projects/:projectId/plan` every ~30 seconds until status is `planning_complete` or `awaiting_clarification`.

### Get Plan
Retrieve the current plan for a project. Returns immediately with the current state.

- **URL:** `/projects/:projectId/plan`
- **Method:** `GET`
- **Auth Required:** Yes
- **Response when planning is in progress (200):**
  ```json
  {
    "plan": { "status": "planning" }
  }
  ```
- **Response when awaiting clarification (200):**
  ```json
  {
    "plan": { "status": "awaiting_clarification", "questions": ["Question 1?", "Question 2?"] }
  }
  ```
- **Response when plan is ready (200):**
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
Start the concept design phase using the approved plan. Returns immediately while the sandbox runs in the background. Poll `GET /projects/:projectId/design` for results.

- **URL:** `/projects/:projectId/design`
- **Method:** `POST`
- **Auth Required:** Yes
- **Headers:**
  - `X-Gemini-Unwrap-Key: <client_derived_unwrap_key>`
- **Body (optional):**
  ```json
  {
    "enableAutocomplete": true
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "designing"
  }
  ```
- **Polling:** Use `GET /projects/:projectId/design` every ~30 seconds until `design.status` is absent (design data returned directly).

### Modify Design
Request changes to a generated design. Returns immediately while the sandbox runs in the background.

- **URL:** `/projects/:projectId/design`
- **Method:** `PUT`
- **Auth Required:** Yes
- **Headers:**
  - `X-Gemini-Unwrap-Key: <client_derived_unwrap_key>`
- **Body:**
  ```json
  {
    "feedback": "Please add a tagging system to the notes.",
    "enableAutocomplete": true
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "designing"
  }
  ```
- **Polling:** Use `GET /projects/:projectId/design` every ~30 seconds.

### Get Design
Retrieve the generated design. Returns immediately with the current state.

- **URL:** `/projects/:projectId/design`
- **Method:** `GET`
- **Auth Required:** Yes
- **Response when designing is in progress (200):**
  ```json
  {
    "design": { "status": "designing" }
  }
  ```
- **Response when design is ready (200):**
  ```json
  {
    "design": {
      "libraryPulls": [...],
      "customConcepts": [...]
    }
  }
  ```

## Implementing

### Trigger Implementation
Start the implementation phase using the approved design. Returns immediately while the sandbox runs in the background. Poll `GET /projects/:projectId/implementations` for results.

- **URL:** `/projects/:projectId/implement`
- **Method:** `POST`
- **Auth Required:** Yes
- **Headers:**
  - `X-Gemini-Unwrap-Key: <client_derived_unwrap_key>`
- **Prerequisites:**
  - Project status is `design_complete`
  - A design exists for the project
- **Body (optional):**
  ```json
  {
    "enableAutocomplete": true
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "implementing"
  }
  ```
- **Polling:** Use `GET /projects/:projectId/implementations` every ~30 seconds until `implementations.status` is absent (data returned directly).

### Get Implementations
Retrieve the generated implementations for a project. Returns immediately with the current state.

- **URL:** `/projects/:projectId/implementations`
- **Method:** `GET`
- **Auth Required:** Yes
- **Response when implementing is in progress (200):**
  ```json
  {
    "implementations": { "status": "implementing" }
  }
  ```
- **Response when implementations are ready (200):**
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
Start the sync generation phase using the approved implementations. Returns immediately while the sandbox runs in the background. Poll `GET /projects/:projectId/syncs` for results.

- **URL:** `/projects/:projectId/syncs`
- **Method:** `POST`
- **Auth Required:** Yes
- **Headers:**
  - `X-Gemini-Unwrap-Key: <client_derived_unwrap_key>`
- **Prerequisites:** Project status must be one of:
  - `implemented`
  - `syncs_generated`
- **Body (optional):**
  ```json
  {
    "enableAutocomplete": true
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "sync_generating"
  }
  ```
- **Polling:** Use `GET /projects/:projectId/syncs` every ~30 seconds until `syncs.status` is absent (data returned directly).

### Get Syncs
Retrieve the generated sync artifacts for a project. Returns immediately with the current state.

- **URL:** `/projects/:projectId/syncs`
- **Method:** `GET`
- **Auth Required:** Yes
- **Response when sync generation is in progress (200):**
  ```json
  {
    "syncs": { "status": "sync_generating" }
  }
  ```
- **Response when syncs are ready (200):**
  ```json
  {
    "syncs": [ ... ],
    "apiDefinition": { ... },
    "endpointBundles": [ ... ]
  }
  ```

## Assembling (Backend-Only, Sandboxed)

### Trigger Assembly
Run backend assembly only (no frontend generation) using the sandboxed assembly path. Returns immediately while the sandbox runs in the background. Poll `GET /projects/:projectId/build/status` for results.

- **URL:** `/projects/:projectId/assemble`
- **Method:** `POST`
- **Auth Required:** Yes
- **Headers:**
  - `X-Gemini-Unwrap-Key: <client_derived_unwrap_key>`
- **Prerequisites:** Project status must be one of:
  - `syncs_generated`
  - `assembled`
  - `complete`
- **Body (optional):**
  ```json
  {
    "enableAutocomplete": true
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "assembling"
  }
  ```
- **Polling:** Use `GET /projects/:projectId/build/status` (or `/assemble/status`) every ~30 seconds.
- **Notes:**
  - This path provisions a sandbox internally (`Sandboxing.provision`) and runs backend assembly there.
  - This endpoint is intended for backend-only assembly.
  - If `enableAutocomplete` is `true`, the same sandbox continues into the existing build flow after backend assembly completes.
  - Any active hosted preview for the project is torn down before assembly starts so previews do not point at stale artifacts.

## Building (Backend + Frontend, Sandboxed)

The Build endpoint provisions one sandbox and runs both backend assembly and frontend generation inside that same sandbox session.

### Trigger Build
Start both backend assembly and frontend generation for a project. Returns immediately while the sandbox runs in the background. Poll `GET /projects/:projectId/build/status` for results and download URLs.

- **URL:** `/projects/:projectId/build`
- **Method:** `POST`
- **Auth Required:** Yes
- **Headers:**
  - `X-Gemini-Unwrap-Key: <client_derived_unwrap_key>`
- **Prerequisites:** Project status must be one of:
  - `syncs_generated`
  - `building`
  - `assembled`
  - `complete`
- **Body (optional):**
  ```json
  {
    "enableAutocomplete": true
  }
  ```
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "building"
  }
  ```
- **Polling:** Use `GET /projects/:projectId/build/status` every ~30 seconds until `status` is `complete`.
- **Notes:**
  - Both backend assembly and frontend generation run in the same sandbox lifecycle.
  - Autocomplete can enter this stage automatically from earlier pipeline triggers without provisioning a new sandbox.
  - The sandbox timeout window is refreshed at each automatic handoff and still cleans up automatically when it stops heartbeating.
  - Project status changes to `assembled` only when **both** complete.
  - Any active hosted preview for the project is torn down before build starts so previews always correspond to the latest built artifacts.

### Get Build Status
Check the status of both backend and frontend generation. Always returns immediately with the current state.

- **URL:** `/projects/:projectId/build/status`
- **Method:** `GET`
- **Auth Required:** Yes
- **Alias:** `/projects/:projectId/assemble/status` (backwards compatibility path)
- **Headers:**
  - `X-Gemini-Unwrap-Key: <client_derived_unwrap_key>`
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
  - This endpoint reports **combined** backend + frontend status and always returns immediately.
  - `X-Gemini-Unwrap-Key` is required here. The backend uses it to resolve the stored Gemini credential and to auto-retry stuck frontend builds when retry conditions are met.
  - If you only trigger `/assemble` (backend-only) and never run `/build`, frontend may remain `processing`, so overall status may not become `complete` here.
  - Use a valid (non-expired) access token when polling; if your token expires, refresh it first.
  - This is the primary polling endpoint for build progress. Poll every ~30 seconds after triggering a build.

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

## Previewing (Hosted, Manual Trigger)

Manual preview launch from existing build artifacts (backend + frontend zip), without rerunning generation.

### Trigger Preview Launch
Start hosted preview deployment for the latest built artifacts. Returns immediately while preview deployment runs in the background.

- **URL:** `/projects/:projectId/preview`
- **Method:** `POST`
- **Auth Required:** Yes
- **Prerequisites:**
  - Project status must be one of:
    - `assembled`
    - `complete`
  - Backend + frontend build artifacts must exist
  - Feature flag `PREVIEWS_ENABLED=true`
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "previewing"
  }
  ```
- **Conflict Response (409):**
  ```json
  {
    "error": "Frontend artifact is not available yet. Run build to completion before previewing."
  }
  ```
- **Other Error Responses:**
  - `409`: Preview limit reached for the authenticated owner
  - `503`: Previews are disabled by feature flag
- **Notes:**
  - This endpoint does **not** require Gemini headers.
  - Existing preview for the same project is torn down before a fresh launch.
  - Preview launch uses managed preview env vars and a fresh preview database.
  - The per-owner active preview cap is controlled by `PREVIEW_MAX_ACTIVE_PER_USER`.

### Get Preview Status
Check current hosted preview status.

- **URL:** `/projects/:projectId/preview/status`
- **Method:** `GET`
- **Auth Required:** Yes
- **Success Responses (200):**
  ```json
  { "status": "none" }
  ```
  ```json
  { "status": "processing" }
  ```
  ```json
  {
    "status": "ready",
    "frontendUrl": "https://...",
    "backendUrl": "https://...",
    "expiresAt": "2026-03-06T12:34:56.000Z"
  }
  ```
  ```json
  { "status": "error", "error": "..." }
  ```
  ```json
  { "status": "expired" }
  ```
- **Error Responses:**
  - `401`: Unauthorized
  - `403`: Access denied
  - `404`: Project not found
  - `503`: Previews are disabled by feature flag

### Teardown Preview
Stop hosted preview deployment for a project.

- **URL:** `/projects/:projectId/preview/teardown`
- **Method:** `POST`
- **Auth Required:** Yes
- **Success Response (200):**
  ```json
  {
    "project": "project_id",
    "status": "preview_stopped"
  }
  ```
- **Error Responses:**
  - `500`: Preview teardown failed remotely
  - `503`: Previews are disabled by feature flag
- **Notes:**
  - This endpoint does **not** require Gemini headers.
  - Build, reassemble, revert, and delete operations also auto-teardown previews for consistency and cost control.

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
