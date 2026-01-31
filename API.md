# ConceptualAI API Documentation

All API endpoints are prefixed with `/api`.
Most endpoints require an `Authorization: Bearer <token>` header unless otherwise specified.

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
    "status": "planning_complete", // or "awaiting_input"
    "plan": { ... }, // if complete
    "questions": [ ... ] // if needs clarification
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
  Same as Create Project response (status + plan or more questions).

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
    "status": "planning_complete",
    "plan": { ... updated plan ... }
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
    "status": "complete",
    "design": {
      "libraryPulls": [...],
      "customConcepts": [...]
    }
  }
  ```

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
    "status": "complete",
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
- **Success Response (200):**
  ```json
  {
    "status": "complete",
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
- **Success Response (200):**
  ```json
  {
    "status": "complete",
    "apiDefinition": { ... },
    "endpointBundles": [ ... ]
  }
  ```

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

## Building (Full Project Generation)

The Build endpoint triggers both backend assembly and frontend generation in parallel, providing a single entry point to generate the complete project.

### Trigger Build
Start both backend assembly and frontend generation for a project.

- **URL:** `/projects/:projectId/build`
- **Method:** `POST`
- **Auth Required:** Yes
- **Prerequisites:** Project must have syncs generated (status: `syncs_generated`)
- **Success Response (200):**
  ```json
  {
    "status": "processing",
    "message": "Build started. Poll /projects/{id}/build/status for completion."
  }
  ```
- **Notes:**
  - Both backend assembly and frontend generation run in parallel
  - Poll the `/build/status` endpoint to check progress and get download URLs
  - Project status changes to `assembled` only when **both** complete

### Get Build Status
Check the status of both backend and frontend generation.

- **URL:** `/projects/:projectId/build/status`
- **Method:** `GET`
- **Auth Required:** Yes
- **Alias:** `/projects/:projectId/assemble/status` (for backwards compatibility)
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
- **Possible Status Values:**
  - `processing`: Generation in progress (at least one not complete)
  - `complete`: Both backend and frontend finished successfully
  - `error`: Frontend generation failed

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
