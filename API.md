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
