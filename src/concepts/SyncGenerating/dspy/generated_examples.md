# Generated Syncs and Tests - Reference Examples

Generated on: 2026-01-31

This document contains reference examples of properly structured syncs and tests.
**AI Agents: Study these patterns carefully before generating new syncs.**

---

## SYNC GENERATION PRINCIPLES

### RULE 0: ALWAYS Include `method` in Request Patterns
Every `Requesting.request` pattern MUST include the HTTP method.
- **BAD**: `{ path: "/auth/logout", accessToken }` - missing method
- **GOOD**: `{ path: "/auth/logout", method: "POST", accessToken }`

### RULE 1: Pattern Matching is STRICT on Undefined Fields
If a field is in the `when` pattern but undefined/missing in the request, the pattern will NOT match.
- **BAD**: `{ path: "/profiles", method: "POST", accessToken, username, bio }` - if `bio` is optional and not sent, sync won't fire
- **GOOD**: Only include GUARANTEED fields in `when`, handle optional fields in `where` with `frames.map`

### RULE 2: Only Use QUERIES in `where` Clauses  
Never call actions (side-effect methods) in `where`. Only use query methods (prefixed with `_`).
- **GOOD**: `frames.query(Sessioning._getUser, {...})`
- **BAD**: `frames.query(Profiling.createProfile, {...})`

### RULE 3: Use MULTI-SYNC Pattern for Mutations (POST/PUT/DELETE)
For create/update/delete operations, use SEPARATE syncs:
1. **Request Sync**: Match request → trigger action in `then`
2. **Success Sync**: Match request + action success → respond
3. **Error Sync**: Match request + action error → respond with error
4. **Auth Error Sync**: Match request + auth failure → respond 401

### RULE 4: Use SELF-CONTAINED Pattern for Reads (GET)
For read operations, handle everything in ONE sync:
- `when`: match the request
- `where`: authenticate + query data (using `_` prefixed query methods ONLY)
- `then`: respond directly

### RULE 5: Tests MUST Cover Edge Cases
Always test:
- Success case
- **Optional Fields**: Explicitly check that optional fields (like `bio`, `avatarUrl`) are saved when provided.
- Invalid/missing auth token
- Missing optional fields (should still succeed)
- Not found (for single-resource endpoints)
- Access denied (for owner-restricted resources)

### RULE 6: Tests MUST Validate Response Schema against OpenAPI
Tests should not just check for success/failure but verify the **exact structure** of the JSON response matches the OpenAPI spec.
- **Reference the OpenAPI Spec**: Explicitly check that fields defined in the YAML are present in the response.
- **Validate Required Fields**: If OpenAPI says `user` is required, `assertExists(res.user)` matches.
- **Validate Types**: If OpenAPI says `isLiked: boolean`, `assertEquals(typeof res.isLiked, "boolean")` matches.
- **Validate Wrappers**: If OpenAPI says response is `{ data: [...] }`, do not accept `[...]`.
- **CRITICAL - ID Mapping**: If OpenAPI expects `id` or `user` but MongoDB has `_id`, the test MUST assert the existence of `id`/`user`. This forces the sync to perform the mapping.

### RULE 7: NEVER Reference Methods That Don't Exist on a Concept
Syncs can ONLY use actions and queries that are **actually implemented** on the concept class provided in `relevant_implementations`. If the concept doesn't have the method you need, you MUST work with what exists.

**NEVER use `declare module` to augment a concept's type.** This is a TypeScript-only trick that passes `deno check` but **crashes at runtime** because the sync engine resolves actions by looking up real methods on the concept instance. A `declare module` block adds zero runtime behavior — the method will be `undefined` and the engine will throw.

- **BAD** — invents a method and "declares" it to fix the type error:
  ```typescript
  // This compiles but CRASHES at runtime!
  declare module "@concepts" {
    interface DirectMessagingConcept {
      leaveConversation(args: { conversation: string; user: string }): Promise<{ ok: boolean }>;
    }
  }
  // Sync references DirectMessaging.leaveConversation — undefined at runtime
  ```
- **GOOD** — only reference methods that exist in the concept implementation:
  ```typescript
  // If leaveConversation doesn't exist, use what DOES exist:
  // e.g. DirectMessaging.removeParticipant, or restructure the sync logic
  ```

If no existing method can fulfill the endpoint's needs, flag it in the sync comments and implement the best approximation using methods that DO exist. Do NOT invent phantom methods.

### RULE 8: Binary/Media Serving Endpoints
For `GET /media/{id}` style endpoints that serve binary files, the sync must respond with a stream object so the Requesting handler can send raw bytes instead of JSON:
```typescript
// In the sync's then/where clause, after getting the binary data:
const result = await MediaHosting._getMediaData({ mediaId });
const media = result[0].media;
if (!media) {
  Requesting.respond({ request, statusCode: 404, error: "Not found" });
} else {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(media.data);
      controller.close();
    }
  });
  Requesting.respond({ request, stream, headers: { "Content-Type": media.mimeType } });
}
```
The Requesting handler detects the `stream` property and returns a raw `Response` instead of JSON.

---

## POST /auth/login
**Summary:** Login

**Description:** Authenticates a user and returns a session with access and refresh tokens.

**OpenAPI Spec:**
```yaml
post:
  summary: Login
  description: Authenticates a user and returns a session with access and refresh tokens.
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required:
            - email
            - password
          properties:
            email:
              type: string
              format: email
            password:
              type: string
              format: password
  responses:
    '200':
      description: Successful login
      content:
        application/json:
          schema:
            type: object
            required:
              - user
              - accessToken
              - refreshToken
            properties:
              user:
                type: string
                description: The User ID
              accessToken:
                type: string
              refreshToken:
                type: string
    '401':
      description: Unauthorized
```

### Syncs
```typescript
import { actions, Sync } from "@engine";
import { Authenticating, Requesting, Sessioning } from "@concepts";

// =============================================================================
// POST /auth/login - MULTI-SYNC PATTERN FOR MUTATIONS
// =============================================================================
// This demonstrates the correct pattern for mutation endpoints:
// 1. Request Sync: Receives request, triggers the action
// 2. Success Chain: On success, triggers follow-up actions (create session)
// 3. Success Response: When all actions complete, responds to client
// 4. Error Response: On action error, responds with error
// =============================================================================

/**
 * SYNC 1: LoginRequest
 * Purpose: Receive the login request and trigger authentication
 * 
 * Pattern: Request Sync (first sync in mutation chain)
 * - when: Match the request with GUARANTEED fields only (path, email, password)
 * - then: Trigger the action (Authenticating.login)
 * 
 * IMPORTANT: We don't respond here - we wait for action result in separate syncs
 */
export const LoginRequest: Sync = ({ request, email, password }) => ({
  when: actions([
    Requesting.request,
    // RULE 1: Only include fields GUARANTEED to be in every request
    // email and password are required for login, so they're safe here
    // ALWAYS include method to ensure correct HTTP verb matching
    { path: "/auth/login", method: "POST", email, password },
    { request },
  ]),
  // No `where` clause needed - no auth check for login endpoint
  then: actions([Authenticating.login, { email, password }]),
});

/**
 * SYNC 2: LoginSuccessCreatesSession
 * Purpose: When login succeeds, create a session for the user
 * 
 * Pattern: Action Chain (intermediate sync)
 * - when: Match the successful login action output
 * - then: Trigger the next action (Sessioning.create)
 */
export const LoginSuccessCreatesSession: Sync = ({ user }) => ({
  when: actions([Authenticating.login, {}, { user }]),
  // user output means success (no error)
  then: actions([Sessioning.create, { user }]),
});

/**
 * SYNC 3: LoginResponseSuccess
 * Purpose: When login AND session creation succeed, respond to client
 * 
 * Pattern: Success Response (final sync in successful chain)
 * - when: Match ALL actions in the chain completing successfully
 * - then: Respond with success data
 */
export const LoginResponseSuccess: Sync = ({
  request,
  user,
  accessToken,
  refreshToken,
}) => ({
  when: actions(
    // Match the original request - ALWAYS include method
    [Requesting.request, { path: "/auth/login", method: "POST" }, { request }],
    // Match successful login (has user output)
    [Authenticating.login, {}, { user }],
    // Match successful session creation (has tokens)
    [Sessioning.create, {}, { accessToken, refreshToken }],
  ),
  then: actions([
    Requesting.respond,
    { request, accessToken, refreshToken, user },
  ]),
});

/**
 * SYNC 4: LoginResponseError
 * Purpose: When login fails, respond with error
 * 
 * Pattern: Error Response
 * - when: Match the action producing an error output
 * - then: Respond with error and appropriate status code
 */
export const LoginResponseError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/login", method: "POST" }, { request }],
    // Match failed login (has error output instead of user)
    [Authenticating.login, {}, { error }],
  ),
  then: actions([Requesting.respond, { request, error, statusCode: 401 }]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: POST /auth/login",
  // RULE: Always disable sanitizers for MongoDB tests
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Requesting = concepts.Requesting as any;

    // Monkey-patch collections to use test database
    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();

    try {
        Engine.logging = Logging.OFF;
        Engine.register(syncs);

        const email = "login_test@example.com";
        const password = "password123";

        // Setup: Create a user directly to test login against
        const regResult = await Authenticating.register({ email, password });
        if ('error' in regResult) throw new Error(regResult.error);
        const userId = regResult.user;

        // =================================================================
        // TEST 1: Successful Login
        // =================================================================
        console.log("TEST 1: Successful Login");
        const loginInputs = {
            path: "/auth/login",
            method: "POST",
            email,
            password
        };
        const { request: loginReq } = await Requesting.request(loginInputs);
        const [loginRes] = await Requesting._awaitResponse({ request: loginReq });
        const loginData = loginRes.response as any;
        
        assertExists(loginData.accessToken, "Should return access token");
        assertExists(loginData.refreshToken, "Should return refresh token");
        assertEquals(loginData.user, userId, "Should return correct user ID");

        // RULE 6: Validate Response Schema (Match OpenAPI definition for LoginResponse)
        // OpenAPI: { accessToken: string, refreshToken: string, user: string }
        assertEquals(typeof loginData.accessToken, "string", "AccessToken must match OpenAPI type");
        assertEquals(typeof loginData.refreshToken, "string", "RefreshToken must match OpenAPI type");
        assertEquals(typeof loginData.user, "string", "User ID must match OpenAPI type");

        // =================================================================
        // TEST 2: Invalid Password (Error Case)
        // =================================================================
        console.log("TEST 2: Invalid Password");
        const invalidInputs = {
            path: "/auth/login",
            method: "POST",
            email,
            password: "wrongpassword"
        };
        const { request: invalidReq } = await Requesting.request(invalidInputs);
        const [invalidRes] = await Requesting._awaitResponse({ request: invalidReq });
        const invalidData = invalidRes.response as any;
        
        assertEquals(invalidData.statusCode, 401, "Should return 401 for invalid password");
        assertExists(invalidData.error, "Should return error message");

        // =================================================================
        // TEST 3: Non-existent User (Error Case)
        // =================================================================
        console.log("TEST 3: Non-existent User");
        const noUserInputs = {
            path: "/auth/login",
            method: "POST",
            email: "doesnotexist@example.com",
            password: "anypassword"
        };
        const { request: noUserReq } = await Requesting.request(noUserInputs);
        const [noUserRes] = await Requesting._awaitResponse({ request: noUserReq });
        const noUserData = noUserRes.response as any;
        
        assertEquals(noUserData.statusCode, 401, "Should return 401 for non-existent user");

    } finally {
        // RULE: Always close client in finally block
        await client.close();
    }
  }
});
```

---

## POST /auth/logout
**Summary:** Logout

**Description:** Revokes the current session.

**OpenAPI Spec:**
```yaml
post:
  summary: Logout
  description: Revokes the current session.
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required:
            - accessToken
          properties:
            accessToken:
              type: string
  responses:
    '200':
      description: Successful logout
      content:
        application/json:
          schema:
            type: object
            properties:
              status:
                type: string
                example: logged_out
    '401':
      description: Unauthorized
```

### Syncs
```typescript
import { actions, Sync } from "@engine";
import { Requesting, Sessioning } from "@concepts";

// =============================================================================
// POST /auth/logout - MULTI-SYNC PATTERN FOR MUTATIONS
// =============================================================================
// Logout requires authentication first, then revokes the session.
// We use `where` for auth check (query), then `then` for the action.
// =============================================================================

/**
 * SYNC 1: LogoutRequest
 * Purpose: Authenticate and trigger session deletion
 * 
 * Pattern: Request Sync with Auth Check
 * - when: Match the request (accessToken is required)
 * - where: Verify the token is valid (using QUERY method _getUser)
 * - then: Trigger the action (Sessioning.delete)
 * 
 * IMPORTANT: _getUser is a QUERY (starts with _), safe for where clause
 */
export const LogoutRequest: Sync = ({ request, accessToken, user }) => ({
  when: actions([
    Requesting.request,
    // accessToken is REQUIRED for logout, safe to include in when
    // ALWAYS include method to match correct HTTP verb
    { path: "/auth/logout", method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // RULE 2: Only use QUERIES (_prefixed methods) in where clause
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    // Filter to only frames where auth succeeded
    return frames.filter(f => f[user] !== undefined);
  },
  then: actions([Sessioning.delete, { session: accessToken }]),
});

/**
 * SYNC 2: LogoutResponseSuccess
 * Purpose: When logout succeeds, respond to client
 */
export const LogoutResponseSuccess: Sync = ({ request, accessToken }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/logout", method: "POST" }, { request }],
    // Match successful session deletion (no error output)
    [Sessioning.delete, { session: accessToken }, {}],
  ),
  then: actions([
    Requesting.respond,
    { request, status: "logged_out" },
  ]),
});

/**
 * SYNC 3: LogoutAuthError
 * Purpose: When token is invalid, respond with 401
 * 
 * Pattern: Auth Error Response
 * - where: Check for auth failure (error output from _getUser)
 */
export const LogoutAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/auth/logout", method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Check if auth failed
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: POST /auth/logout",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Sessioning = concepts.Sessioning as any;
    const Requesting = concepts.Requesting as any;

    Sessioning.sessions = db.collection("Sessioning.sessions");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      // Setup: Create a session
      const userId = freshID();
      const { accessToken } = await Sessioning.create({ user: userId });
      assertExists(accessToken, "Setup: Failed to create session");

      // =================================================================
      // TEST 1: Successful Logout
      // =================================================================
      console.log("TEST 1: Successful Logout");
      const logoutInputs = {
        path: "/auth/logout",
        method: "POST",
        accessToken,
      };
      const { request: logoutReq } = await Requesting.request(logoutInputs);
      const [logoutRes] = await Requesting._awaitResponse({ request: logoutReq });
      const logoutData = logoutRes.response as any;

      assertEquals(logoutData.status, "logged_out", "Should return logged_out status");

      // =================================================================
      // TEST 2: Logout with Revoked Token (Already Logged Out)
      // =================================================================
      console.log("TEST 2: Logout with Revoked Token");
      const { request: logoutReq2 } = await Requesting.request(logoutInputs);
      const [logoutRes2] = await Requesting._awaitResponse({ request: logoutReq2 });
      const logoutData2 = logoutRes2.response as any;

      assertEquals(logoutData2.statusCode, 401, "Should return 401 for revoked token");
      assertEquals(logoutData2.error, "Unauthorized");

      // =================================================================
      // TEST 3: Logout with Invalid Token
      // =================================================================
      console.log("TEST 3: Logout with Invalid Token");
      const invalidInputs = {
        path: "/auth/logout",
        method: "POST",
        accessToken: "completely_invalid_token",
      };
      const { request: invalidReq } = await Requesting.request(invalidInputs);
      const [invalidRes] = await Requesting._awaitResponse({ request: invalidReq });
      const invalidData = invalidRes.response as any;

      assertEquals(invalidData.statusCode, 401, "Should return 401 for invalid token");

    } finally {
      await client.close();
    }
  },
});
```

---

## POST /auth/refresh
**Summary:** Refresh Token

**Description:** Exchanges a valid refresh token for a new pair of access and refresh tokens.

**OpenAPI Spec:**
```yaml
post:
  summary: Refresh Token
  description: Exchanges a valid refresh token for a new pair of access and refresh tokens.
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required:
            - refreshToken
          properties:
            refreshToken:
              type: string
  responses:
    '200':
      description: Tokens refreshed
      content:
        application/json:
          schema:
            type: object
            required:
              - accessToken
              - refreshToken
            properties:
              accessToken:
                type: string
              refreshToken:
                type: string
    '401':
      description: Unauthorized (Invalid refresh token)
```

### Syncs
```typescript
import { actions, Sync } from "@engine";
import { Requesting, Sessioning } from "@concepts";

// =============================================================================
// POST /auth/refresh - MULTI-SYNC PATTERN FOR MUTATIONS
// =============================================================================
// Token refresh doesn't need auth check - the refreshToken itself is the auth.
// =============================================================================

/**
 * SYNC 1: RefreshRequest
 * Purpose: Receive refresh request and trigger token refresh
 * 
 * Note: refreshToken is REQUIRED, safe to include in when pattern
 */
export const RefreshRequest: Sync = ({ request, refreshToken }) => ({
  when: actions([
    Requesting.request,
    // ALWAYS include method
    { path: "/auth/refresh", method: "POST", refreshToken },
    { request }
  ]),
  then: actions([
    Sessioning.refresh,
    { refreshToken }
  ]),
});

/**
 * SYNC 2: RefreshResponseSuccess
 * Purpose: Return new tokens on successful refresh
 */
export const RefreshResponseSuccess: Sync = ({
  request,
  accessToken,
  refreshToken,
}) => ({
  when: actions(
    [Requesting.request, { path: "/auth/refresh", method: "POST" }, { request }],
    // Match successful refresh (has new tokens)
    [Sessioning.refresh, {}, { accessToken, refreshToken }],
  ),
  then: actions([
    Requesting.respond,
    { request, accessToken, refreshToken },
  ]),
});

/**
 * SYNC 3: RefreshResponseError
 * Purpose: Return error on invalid/expired refresh token
 */
export const RefreshResponseError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/refresh", method: "POST" }, { request }],
    // Match failed refresh (has error)
    [Sessioning.refresh, {}, { error }],
  ),
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 401 }
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: POST /auth/refresh",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Sessioning = concepts.Sessioning as any;
    const Requesting = concepts.Requesting as any;

    Sessioning.sessions = db.collection("Sessioning.sessions");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();

    try {
        Engine.logging = Logging.OFF;
        Engine.register(syncs);

        const userId = freshID();

        // Setup: Create initial session
        const initialSession = await Sessioning.create({ user: userId });
        const initialRefreshToken = initialSession.refreshToken;
        const initialAccessToken = initialSession.accessToken;
        assertExists(initialRefreshToken, "Setup: No refresh token");

        // =================================================================
        // TEST 1: Successful Refresh
        // =================================================================
        console.log("TEST 1: Successful Refresh");
        const refreshInputs = {
            path: "/auth/refresh",
            method: "POST",
            refreshToken: initialRefreshToken
        };

        const { request: refreshReq } = await Requesting.request(refreshInputs);
        const [refreshRes] = await Requesting._awaitResponse({ request: refreshReq });
        const refreshData = refreshRes.response as any;

        assertExists(refreshData.accessToken, "Should return new access token");
        assertExists(refreshData.refreshToken, "Should return new refresh token");
        assertNotEquals(refreshData.accessToken, initialAccessToken, "New access token should differ");
        assertNotEquals(refreshData.refreshToken, initialRefreshToken, "New refresh token should differ");

        // =================================================================
        // TEST 2: Refresh with Old Token (Already Used)
        // =================================================================
        console.log("TEST 2: Refresh with Old Token");
        const retryInputs = {
            path: "/auth/refresh",
            method: "POST",
            refreshToken: initialRefreshToken  // Old token, should be revoked
        };
        const { request: retryReq } = await Requesting.request(retryInputs);
        const [retryRes] = await Requesting._awaitResponse({ request: retryReq });
        const retryData = retryRes.response as any;
        
        assertEquals(retryData.statusCode, 401, "Old refresh token should be revoked");

        // =================================================================
        // TEST 3: Invalid Refresh Token
        // =================================================================
        console.log("TEST 3: Invalid Refresh Token");
        const invalidInputs = {
            path: "/auth/refresh",
            method: "POST",
            refreshToken: "invalid_token_string"
        };

        const { request: invalidReq } = await Requesting.request(invalidInputs);
        const [invalidRes] = await Requesting._awaitResponse({ request: invalidReq });
        const invalidData = invalidRes.response as any;

        assertEquals(invalidData.statusCode, 401, "Should return 401 for invalid token");
        assertExists(invalidData.error);

    } finally {
        await client.close();
    }
  }
});
```

---

## POST /auth/register
**Summary:** Register a new user

**Description:** Creates a new user account with email and password.

**OpenAPI Spec:**
```yaml
post:
  summary: Register a new user
  description: Creates a new user account with email and password.
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required:
            - email
            - password
          properties:
            email:
              type: string
              format: email
            password:
              type: string
              format: password
  responses:
    '200':
      description: User registered successfully
      content:
        application/json:
          schema:
            type: object
            required:
              - user
              - accessToken
              - refreshToken
            properties:
              user:
                type: string
                description: The created User ID
              accessToken:
                type: string
              refreshToken:
                type: string
    '409':
      description: Conflict (Email already exists)
```

### Syncs
```typescript
import { actions, Sync } from "@engine";
import { Authenticating, Sessioning, Requesting } from "@concepts";

// =============================================================================
// POST /auth/register - MULTI-SYNC PATTERN FOR MUTATIONS
// =============================================================================
// Registration creates user, then automatically creates session.
// This demonstrates the action chain pattern.
// =============================================================================

/**
 * SYNC 1: RegisterRequest
 * Purpose: Receive registration request and trigger user creation
 */
export const RegisterRequest: Sync = ({ request, email, password }) => ({
  when: actions([
    Requesting.request,
    // email and password are REQUIRED, safe in when
    // ALWAYS include method
    { path: "/auth/register", method: "POST", email, password },
    { request },
  ]),
  then: actions([
    Authenticating.register,
    { email, password },
  ]),
});

/**
 * SYNC 2: RegisterSuccessCreatesSession
 * Purpose: On successful registration, auto-create a session
 * 
 * Pattern: Action Chain - one action triggers another
 */
export const RegisterSuccessCreatesSession: Sync = ({ user }) => ({
  when: actions([
    Authenticating.register,
    {},
    { user },  // Success output
  ]),
  then: actions([
    Sessioning.create,
    { user },
  ]),
});

/**
 * SYNC 3: RegisterResponseSuccess
 * Purpose: Respond with user and tokens on full success
 */
export const RegisterResponseSuccess: Sync = ({ request, user, accessToken, refreshToken }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/register", method: "POST" }, { request }],
    [Authenticating.register, {}, { user }],
    [Sessioning.create, {}, { accessToken, refreshToken }],
  ),
  then: actions([
    Requesting.respond,
    { request, user, accessToken, refreshToken },
  ]),
});

/**
 * SYNC 4: RegisterResponseError
 * Purpose: Respond with error if registration fails (e.g., duplicate email)
 */
export const RegisterResponseError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/register", method: "POST" }, { request }],
    [Authenticating.register, {}, { error }],
  ),
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 409 },  // 409 Conflict for duplicate
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: POST /auth/register",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Requesting = concepts.Requesting as any;

    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      const email = "test@example.com";
      const password = "password123";

      // =================================================================
      // TEST 1: Successful Registration
      // =================================================================
      console.log("TEST 1: Successful Registration");
      const input = {
        path: "/auth/register",
        method: "POST",
        email,
        password
      };

      const { request } = await Requesting.request(input);
      const [responseFrame] = await Requesting._awaitResponse({ request });
      const response = responseFrame.response as any;

      assertExists(response.user, "Should return user ID");
      assertExists(response.accessToken, "Should return access token");
      assertExists(response.refreshToken, "Should return refresh token");

      // RULE 6: Validate Response Schema (Match OpenAPI definition for RegisterResponse)
      // OpenAPI: { user: string, accessToken: string, refreshToken: string }
      assertEquals(typeof response.user, "string", "User ID must match OpenAPI definition");
      assertEquals(typeof response.accessToken, "string", "AccessToken must match OpenAPI definition");
      assertEquals(typeof response.refreshToken, "string", "RefreshToken must match OpenAPI definition");

      // Verify DB state
      const userDoc = await Authenticating.users.findOne({ email });
      assertExists(userDoc, "User should exist in DB");
      assertEquals(userDoc._id, response.user);

      const sessionDoc = await Sessioning.sessions.findOne({ user: response.user });
      assertExists(sessionDoc, "Session should exist in DB");

      // =================================================================
      // TEST 2: Duplicate Registration
      // =================================================================
      console.log("TEST 2: Duplicate Registration");
      const { request: req2 } = await Requesting.request(input);
      const [resFrame2] = await Requesting._awaitResponse({ request: req2 });
      const res2 = resFrame2.response as any;

      assertEquals(res2.statusCode, 409, "Should return 409 for duplicate");
      assertExists(res2.error, "Should return error message");

    } finally {
      await client.close();
    }
  }
});
```

---

## GET /notes
**Summary:** List all notes

**Description:** Retrieves all notes created by the authenticated user.

**OpenAPI Spec:**
```yaml
get:
  summary: List all notes
  description: Retrieves all notes created by the authenticated user.
  parameters:
    - in: query
      name: accessToken
      schema:
        type: string
      required: true
  responses:
    '200':
      description: List of notes
      content:
        application/json:
          schema:
            type: object
            properties:
              notes:
                type: array
                items:
                  type: object
                  required:
                    - _id
                    - author
                    - content
                  properties:
                    _id:
                      type: string
                    author:
                      type: object
                      required:
                        - _id
                        - username
                      properties:
                        _id:
                          type: string
                        username:
                          type: string
                    content:
                      type: object
                      properties:
                        text:
                          type: string
    '401':
      description: Unauthorized
```

### Syncs
```typescript
import { actions, Sync } from "@engine";
import { Requesting, Sessioning, Posting } from "@concepts";

// =============================================================================
// GET /notes - SELF-CONTAINED PATTERN FOR READS
// =============================================================================
// GET endpoints use a single sync that:
// 1. Matches the request in `when`
// 2. Authenticates AND queries data in `where` (QUERIES ONLY!)
// 3. Hydrates data (joins) if needed (Rule 6 + Hydration)
// 4. Responds in `then`
// =============================================================================

/**
 * SYNC: ListNotes (Success Case)
 * 
 * Pattern: Self-Contained Read with Hydration
 * - when: Match GET request with accessToken
 * - where: Auth check + data query + hydration
 * - then: Respond with data
 */
export const ListNotes: Sync = ({ request, accessToken, user, notes, profiles }) => ({
  when: actions([
    Requesting.request,
    // accessToken is REQUIRED for authenticated endpoints
    { path: "/notes", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // RULE 2: Only QUERIES in where clause
    
    // Step 1: Authenticate using QUERY method
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    // Filter to only authenticated frames
    frames = frames.filter(f => f[user] !== undefined);

    // Step 2: Fetch data using QUERY method
    frames = await frames.query(Posting._getPostsByAuthor, { author: user }, { posts: notes });
    
    // Step 3: HYDRATION - Fetch author profiles for display
    // Collect all author IDs from the notes
    // (In this case it's just the current user, but for a feed it would be many)
    const allAuthors = new Set<string>();
    frames = frames.map(f => {
        const noteList = f[notes] as any[] || [];
        noteList.forEach(n => {
            if (n.author) allAuthors.add(n.author);
        });
        return f;
    });

    // We can use Profiling._getProfile for each unique author
    // OR if Profiling concept has a batch get, use that.
    // Here we'll simulate fetching the profile for the known user.
    frames = await frames.query(Profiling._getProfile, { user }, { profile: profiles }); // Re-using 'profiles' symbol temporarily

    // Map profiles back onto notes
    return frames.map(f => {
        const noteList = f[notes] as any[] || [];
        const userProfile = f[profiles] as any; // The profile we just fetched
        
        if (!userProfile) return f;

        const hydratedNotes = noteList.map(n => ({
            ...n,
            author: {
                _id: n.author, // Preserve ID
                username: userProfile.username, // Add display name
                name: userProfile.name
            }
        }));
        
        return { ...f, [notes]: hydratedNotes };
    });
  },
  then: actions([
    Requesting.respond,
    { request, notes },
  ]),
});

/**
 * SYNC: ListNotesAuthError
 * 
 * Pattern: Auth Error for Read
 * For GETs, we can have separate error syncs or combine into one
 */
export const ListNotesAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/notes", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Check for auth failure
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: GET /notes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Requesting = concepts.Requesting as any;
    const Posting = concepts.Posting as any;

    // Monkey-patch collections
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Profiling.profiles = db.collection("Profiling.profiles");
    Authenticating.users = db.collection("Authenticating.users");
    Posting.posts = db.collection("Posting.posts");

    try {
        Engine.logging = Logging.OFF;
        Engine.register(syncs);

        // Setup: Create User and Session
        const email = "user@example.com";
        const password = "password123";
        
        const regResult = await Authenticating.register({ email, password });
        const userId = regResult.user;
        
        const sessionResult = await Sessioning.create({ user: userId });
        const accessToken = sessionResult.accessToken;

        // Setup: Create Profile for User (Required for hydration)
        await concepts.Profiling.createProfile({
            user: userId,
            username: "testuser",
            name: "Test User",
            bio: "Bio"
        });

        // Setup: Create notes for this user
        await Posting.createPost({ author: userId, content: { text: "Note 1" } });
        await Posting.createPost({ author: userId, content: { text: "Note 2" } });

        // Setup: Create note for another user (should NOT be returned)
        const otherUser = freshID();
        await Posting.createPost({ author: otherUser, content: { text: "Other user note" } });

        // =================================================================
        // TEST 1: Success - List own notes
        // =================================================================
        console.log("TEST 1: List own notes");
        const reqInputs = {
            path: "/notes",
            method: "GET",
            accessToken
        };
        const { request: reqId } = await Requesting.request(reqInputs);
        const [res] = await Requesting._awaitResponse({ request: reqId });
        const data = res.response as any;

        assertExists(data.notes, "Should return notes array");
        assertEquals(data.notes.length, 2, "Should return only user's notes");

        // RULE 6: Validate Response Schema (Match OpenAPI definition for Note Object)
        // OpenAPI: Note { _id: string, author: { _id, username }, content: object }
        const firstNote = data.notes[0];
        assertExists(firstNote._id, "Note must have _id (from OpenAPI)");
        assertEquals(typeof firstNote._id, "string", "_id must be a string");
        
        // Validate Hydrated Author
        assertExists(firstNote.author, "Note must have author object (from OpenAPI)");
        assertEquals(typeof firstNote.author, "object", "Author must be an object (Hydrated)");
        assertEquals(firstNote.author._id, userId, "Author ID must match");
        assertEquals(firstNote.author.username, "testuser", "Author username must be present");
        
        assertExists(firstNote.content, "Note must have content (from OpenAPI)");
        assertEquals(typeof firstNote.content.text, "string", "Content text must be string");

        // =================================================================
        // TEST 2: Unauthorized - Invalid token
        // =================================================================
        console.log("TEST 2: Invalid token");
        const badReqInputs = {
            path: "/notes",
            method: "GET",
            accessToken: "invalid_token"
        };
        const { request: badReqId } = await Requesting.request(badReqInputs);
        const [badRes] = await Requesting._awaitResponse({ request: badReqId });
        const badData = badRes.response as any;

        assertEquals(badData.statusCode, 401);
        assertEquals(badData.error, "Unauthorized");

        // =================================================================
        // TEST 3: Empty result - User with no notes
        // =================================================================
        console.log("TEST 3: User with no notes");
        const newUser = freshID();
        const { accessToken: newToken } = await Sessioning.create({ user: newUser });
        
        const emptyInputs = {
            path: "/notes",
            method: "GET",
            accessToken: newToken
        };
        const { request: emptyReq } = await Requesting.request(emptyInputs);
        const [emptyRes] = await Requesting._awaitResponse({ request: emptyReq });
        const emptyData = emptyRes.response as any;

        assertExists(emptyData.notes);
        assertEquals(emptyData.notes.length, 0, "Should return empty array");

    } finally {
        await client.close();
    }
  }
});
```

---

## POST /notes
**Summary:** Create a note

**Description:** Creates a new note for the authenticated user.

**OpenAPI Spec:**
```yaml
post:
  summary: Create a note
  description: Creates a new note for the authenticated user.
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required:
            - accessToken
            - content
          properties:
            accessToken:
              type: string
            content:
              type: object
              required:
                - text
              properties:
                text:
                  type: string
            metadata:
              type: object
              description: Optional metadata
              properties:
                color:
                  type: string
                tags:
                  type: array
                  items:
                    type: string
  responses:
    '200':
      description: Note created
      content:
        application/json:
          schema:
            type: object
            properties:
              noteId:
                type: string
              status:
                type: string
                example: created
    '400':
      description: Bad Request (Missing content)
    '401':
      description: Unauthorized
```

### Syncs
```typescript
import { actions, Sync } from "@engine";
import { Requesting, Sessioning, Posting } from "@concepts";

// =============================================================================
// POST /notes - MULTI-SYNC PATTERN FOR MUTATIONS
// =============================================================================
// Create note requires:
// 1. Auth check in where (QUERY only)
// 2. Action triggered in then
// 3. Separate syncs for success/error responses
// =============================================================================

/**
 * SYNC 1: CreateNoteRequest
 * Purpose: Authenticate and trigger note creation
 * 
 * IMPORTANT: `content` is REQUIRED for note creation, safe in `when`
 */
export const CreateNoteRequest: Sync = ({ request, accessToken, user, content }) => ({
  when: actions([
    Requesting.request,
    // content is REQUIRED, safe to include
    { path: "/notes", method: "POST", accessToken, content },
    { request },
  ]),
  where: async (frames) => {
    // Auth check using QUERY method
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    return frames.filter(f => f[user] !== undefined);
  },
  then: actions([
    // Action in then (not where!)
    Posting.createPost,
    { author: user, content },
  ]),
});

/**
 * SYNC 2: CreateNoteResponseSuccess
 */
export const CreateNoteResponseSuccess: Sync = ({ request, postId }) => ({
  when: actions(
    // ALWAYS include method in request pattern
    [Requesting.request, { path: "/notes", method: "POST" }, { request }],
    [Posting.createPost, {}, { postId }],
  ),
  then: actions([
    Requesting.respond,
    { request, noteId: postId, status: "created" },
  ]),
});

/**
 * SYNC 3: CreateNoteResponseError
 */
export const CreateNoteResponseError: Sync = ({ request, error }) => ({
  when: actions(
    // ALWAYS include method in request pattern
    [Requesting.request, { path: "/notes", method: "POST" }, { request }],
    [Posting.createPost, {}, { error }],
  ),
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});

/**
 * SYNC 4: CreateNoteAuthError
 */
export const CreateNoteAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/notes", method: "POST", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: POST /notes",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Sessioning = concepts.Sessioning as any;
    const Requesting = concepts.Requesting as any;
    const Posting = concepts.Posting as any;

    Sessioning.sessions = db.collection("Sessioning.sessions");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Posting.posts = db.collection("Posting.posts");

    try {
        Engine.logging = Logging.OFF;
        Engine.register(syncs);

        // Setup: Create user session
        const userId = freshID();
        const sessionData = await Sessioning.create({ user: userId });
        const accessToken = sessionData.accessToken;

        // =================================================================
        // TEST 1: Success - Create note with valid content
        // =================================================================
        console.log("TEST 1: Create note with valid content");
        const noteContent = { text: "Test note" };
        // RULE 5: Optional Fields Verification (metadata is defined as optional in Posting spec)
        const noteMetadata = { color: "blue", tags: ["test"] };
        
        const createInputs = {
            path: "/notes",
            method: "POST",
            accessToken,
            content: noteContent,
            metadata: noteMetadata
        };

        const { request: createReq } = await Requesting.request(createInputs);
        const [createRes] = await Requesting._awaitResponse({ request: createReq });
        const createData = createRes.response as any;

        assertExists(createData.noteId, "Should return note ID");
        assertEquals(createData.status, "created");

        // Verify DB state
        const [savedPost] = await Posting._getPost({ postId: createData.noteId });
        assertExists(savedPost.post);
        assertEquals(savedPost.post.author, userId);
        
        // RULE 5: Optional Fields Verification
        // Verify that optional fields (metadata) were correctly saved
        assertExists(savedPost.post.metadata, "Optional metadata should be saved");
        assertEquals(savedPost.post.metadata.color, "blue", "Metadata color should be correct");

        // =================================================================
        // TEST 1B: Success - Missing Optional Fields
        // =================================================================
        console.log("TEST 1B: Create note without optional fields");
        const minimalContent = { text: "Minimal Note" }; 
        const minimalInputs = {
            path: "/notes",
            method: "POST",
            accessToken,
            content: minimalContent
            // metadata omitted
        };
        const { request: minReq } = await Requesting.request(minimalInputs);
        const [minRes] = await Requesting._awaitResponse({ request: minReq });
        
        assertEquals(minRes.response.status, "created", "Should succeed without optional fields");
        
        // Verify DB
        const [minSaved] = await Posting._getPost({ postId: minRes.response.noteId });
        assertEquals(minSaved.post.content.text, "Minimal Note");
        assertEquals(minSaved.post.metadata, undefined, "Optional metadata should be undefined");

        // =================================================================
        // TEST 2: Auth Error - Invalid token
        // =================================================================
        console.log("TEST 2: Invalid token");
        const invalidInputs = {
            path: "/notes",
            method: "POST",
            accessToken: "invalid_token",
            content: noteContent
        };

        const { request: invalidReq } = await Requesting.request(invalidInputs);
        const [invalidRes] = await Requesting._awaitResponse({ request: invalidReq });
        const invalidData = invalidRes.response as any;

        assertEquals(invalidData.statusCode, 401);

        // =================================================================
        // TEST 3: Validation Error - Empty content
        // =================================================================
        console.log("TEST 3: Empty content");
        const emptyInputs = {
            path: "/notes",
            method: "POST",
            accessToken,
            content: {}  // Empty content should fail validation
        };

        const { request: emptyReq } = await Requesting.request(emptyInputs);
        const [emptyRes] = await Requesting._awaitResponse({ request: emptyReq });
        const emptyData = emptyRes.response as any;

        assertEquals(emptyData.statusCode, 400, "Should reject empty content");

    } finally {
        await client.close();
    }
  }
});
```

---

## GET /notes/{noteId}
**Summary:** Get a note

**Description:** Retrieves a specific note by ID.

**OpenAPI Spec:**
```yaml
get:
  summary: Get a note
  description: Retrieves a specific note by ID.
  parameters:
    - in: path
      name: noteId
      required: true
      schema:
        type: string
    - in: query
      name: accessToken
      required: true
      schema:
        type: string
  responses:
    '200':
      description: Note details
      content:
        application/json:
          schema:
            type: object
            required:
              - post
            properties:
              post:
                type: object
                required:
                  - _id
                  - author
                  - content
                properties:
                  _id:
                    type: string
                  author:
                    type: string
                  content:
                    type: object
                    properties:
                      title:
                        type: string
                      body:
                        type: string
    '401':
      description: Unauthorized
    '403':
      description: Access Denied (Not owner)
    '404':
      description: Note not found
```

### Syncs
```typescript
import { actions, Sync } from "@engine";
import { Requesting, Sessioning, Posting } from "@concepts";

// =============================================================================
// GET /notes/{noteId} - SELF-CONTAINED PATTERN FOR READS
// =============================================================================
// For parameterized GET endpoints:
// 1. Parse path parameters in `where` using frames.map
// 2. Auth + data fetch all in `where` (QUERIES ONLY)
// 3. Multiple syncs for different outcomes (success, not found, access denied)
// =============================================================================

const NOTE_PATH_REGEX = /^\/notes\/([^\/]+)$/;

/**
 * SYNC 1: GetNote (Success)
 * 
 * Demonstrates path parameter extraction and owner authorization
 */
export const GetNote: Sync = ({ request, accessToken, userId, noteId, post, path }) => ({
  when: actions([
    Requesting.request,
    // RULE 1: Use generic `path` variable, not literal with parameter
    // This allows matching any /notes/{id} path
    { path, method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Step 1: Parse path parameter using frames.map
    frames = frames.map(f => {
        const p = f[path] as string;
        const match = p.match(NOTE_PATH_REGEX);
        // Return null for non-matching paths (filtered out below)
        return match ? { ...f, [noteId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // Step 2: Authenticate (QUERY method)
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    // Step 3: Fetch the note (QUERY method)
    frames = await frames.query(Posting._getPost, { postId: noteId }, { post });
    
    // Step 4: Authorize - only owner can view
    return frames.filter(f => {
        const p = f[post] as any;
        return p && p.author === f[userId];
    });
  },
  then: actions([
    Requesting.respond, { request, post }
  ]),
});

/**
 * SYNC 2: GetNoteAuthError
 */
export const GetNoteAuthError: Sync = ({ request, accessToken, error, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Only process /notes/{id} paths
    frames = frames.filter(f => NOTE_PATH_REGEX.test(f[path] as string));
    if (frames.length === 0) return frames;
    
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond, { request, statusCode: 401, error: "Unauthorized" }
  ]),
});

/**
 * SYNC 3: GetNoteNotFound
 */
export const GetNoteNotFound: Sync = ({ request, accessToken, userId, noteId, post, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(NOTE_PATH_REGEX);
        return match ? { ...f, [noteId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    frames = await frames.query(Posting._getPost, { postId: noteId }, { post });
    
    // Not found: post is null/undefined
    return frames.filter(f => !f[post]);
  },
  then: actions([
    Requesting.respond, { request, statusCode: 404, error: "Note not found" }
  ]),
});

/**
 * SYNC 4: GetNoteAccessDenied
 */
export const GetNoteAccessDenied: Sync = ({ request, accessToken, userId, noteId, post, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(NOTE_PATH_REGEX);
        return match ? { ...f, [noteId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user: userId });
    frames = frames.filter(f => f[userId] !== undefined);

    frames = await frames.query(Posting._getPost, { postId: noteId }, { post });
    
    // Access denied: post exists but user is not owner
    return frames.filter(f => {
        const p = f[post] as any;
        return p && p.author !== f[userId];
    });
  },
  then: actions([
    Requesting.respond, { request, statusCode: 403, error: "Access denied" }
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: GET /notes/{noteId}",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Sessioning = concepts.Sessioning as any;
    const Posting = concepts.Posting as any;
    const Requesting = concepts.Requesting as any;

    Sessioning.sessions = db.collection("Sessioning.sessions");
    Posting.posts = db.collection("Posting.posts");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();

    try {
        Engine.logging = Logging.OFF;
        Engine.register(syncs);

        // Setup: User A
        const userA = freshID();
        const { accessToken: tokenA } = await Sessioning.create({ user: userA });

        // Setup: User B
        const userB = freshID();
        const { accessToken: tokenB } = await Sessioning.create({ user: userB });

        // Setup: User A creates a note
        const { postId: noteId } = await Posting.createPost({ 
            author: userA, 
            content: { title: "My Note", body: "Content" } 
        });

        // =================================================================
        // TEST 1: Success - Owner gets their note
        // =================================================================
        console.log("TEST 1: Owner gets their note");
        const req1 = await Requesting.request({
            path: `/notes/${noteId}`,
            method: "GET",
            accessToken: tokenA
        });
        const [res1] = await Requesting._awaitResponse({ request: req1.request });
        const data1 = res1.response as any;
        
        assertExists(data1.post);
        assertEquals(data1.post.author, userA);

        // RULE 6: Validate Response Schema (Match OpenAPI definition for Post Response)
        // OpenAPI: { post: { _id, author, content... } }
        assertExists(data1.post._id, "Post must have _id (match OpenAPI)");
        assertEquals(typeof data1.post._id, "string", "_id must be a string");
        assertExists(data1.post.author, "Post must have author (match OpenAPI)");
        assertEquals(typeof data1.post.author, "string", "Author ID must be a string");
        assertExists(data1.post.content, "Post must have content (match OpenAPI)");
        assertEquals(data1.post.content.title, "My Note", "Content title must match");
        assertEquals(data1.post.content.body, "Content", "Content body must match");

        // =================================================================
        // TEST 2: Auth Error - Invalid token
        // =================================================================
        console.log("TEST 2: Invalid token");
        const req2 = await Requesting.request({
            path: `/notes/${noteId}`,
            method: "GET",
            accessToken: "invalid_token"
        });
        const [res2] = await Requesting._awaitResponse({ request: req2.request });
        const data2 = res2.response as any;
        
        assertEquals(data2.statusCode, 401);
        assertEquals(data2.error, "Unauthorized");

        // =================================================================
        // TEST 3: Access Denied - Non-owner tries to access
        // =================================================================
        console.log("TEST 3: Non-owner access denied");
        const req3 = await Requesting.request({
            path: `/notes/${noteId}`,
            method: "GET",
            accessToken: tokenB  // User B's token
        });
        const [res3] = await Requesting._awaitResponse({ request: req3.request });
        const data3 = res3.response as any;
        
        assertEquals(data3.statusCode, 403);
        assertEquals(data3.error, "Access denied");

        // =================================================================
        // TEST 4: Not Found - Non-existent note
        // =================================================================
        console.log("TEST 4: Note not found");
        const fakeId = "000000000000000000000000";
        const req4 = await Requesting.request({
            path: `/notes/${fakeId}`,
            method: "GET",
            accessToken: tokenA
        });
        const [res4] = await Requesting._awaitResponse({ request: req4.request });
        const data4 = res4.response as any;
        
        assertEquals(data4.statusCode, 404);
        assertEquals(data4.error, "Note not found");

    } finally {
        await client.close();
    }
  }
});
```

---

## PUT /notes/{noteId}
**Summary:** Update a note

**Description:** Updates the content of an existing note.

**OpenAPI Spec:**
```yaml
put:
  summary: Update a note
  description: Updates the content of an existing note.
  parameters:
    - in: path
      name: noteId
      required: true
      schema:
        type: string
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required:
            - accessToken
            - content
          properties:
            accessToken:
              type: string
            content:
              type: object
              properties:
                text:
                  type: string
            metadata:
              type: object
              description: Optional metadata to update
              properties:
                tags:
                  type: array
                  items:
                    type: string
  responses:
    '200':
      description: Note updated
      content:
        application/json:
          schema:
            type: object
            properties:
              status:
                type: string
                example: success
    '401':
      description: Unauthorized
    '403':
      description: Access Denied
    '404':
      description: Note not found
```

### Syncs
```typescript
import { actions, Sync } from "@engine";
import { Requesting, Sessioning, Posting } from "@concepts";

// =============================================================================
// PUT /notes/{noteId} - MULTI-SYNC PATTERN FOR MUTATIONS
// =============================================================================
// CRITICAL: For mutations, use SEPARATE syncs for request and response!
// Do NOT combine action and respond in the same sync's `then` clause.
// =============================================================================

const NOTE_PATH_REGEX = /^\/notes\/([^\/]+)$/;

/**
 * SYNC 1: UpdateNoteRequest
 * Purpose: Auth check, authorization, then trigger update action
 * 
 * NOTE: `content` is REQUIRED for update, safe in `when`
 */
export const UpdateNoteRequest: Sync = ({ request, accessToken, user, noteId, content, path, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PUT", accessToken, content },
    { request },
  ]),
  where: async (frames) => {
    // Parse path
    frames = frames.map(f => {
        const p = f[path] as string;
        const match = p.match(NOTE_PATH_REGEX);
        return match ? { ...f, [noteId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // Auth (QUERY)
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // Authorization: Check owner (QUERY)
    frames = await frames.query(Posting._getPost, { postId: noteId }, { post });
    return frames.filter(f => {
        const p = f[post] as any;
        return p && p.author === f[user];
    });
  },
  // ONLY the action here - response is in separate sync
  then: actions([
    Posting.editPost,
    { postId: noteId, author: user, content },
  ]),
});

/**
 * SYNC 2: UpdateNoteResponseSuccess
 */
export const UpdateNoteResponseSuccess: Sync = ({ request, noteId, path }) => ({
  when: actions(
    [Requesting.request, { path, method: "PUT" }, { request }],
    [Posting.editPost, {}, {}],  // Success = no error output
  ),
  where: async (frames) => {
    // Only match /notes/{id} paths
    return frames.filter(f => NOTE_PATH_REGEX.test(f[path] as string));
  },
  then: actions([
    Requesting.respond,
    { request, status: "success" },
  ]),
});

/**
 * SYNC 3: UpdateNoteResponseError (Action failed)
 */
export const UpdateNoteResponseError: Sync = ({ request, error, path }) => ({
  when: actions(
    [Requesting.request, { path, method: "PUT" }, { request }],
    [Posting.editPost, {}, { error }],
  ),
  where: async (frames) => {
    return frames.filter(f => NOTE_PATH_REGEX.test(f[path] as string));
  },
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});

/**
 * SYNC 4: UpdateNoteAuthError
 */
export const UpdateNoteAuthError: Sync = ({ request, accessToken, error, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PUT", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter(f => NOTE_PATH_REGEX.test(f[path] as string));
    if (frames.length === 0) return frames;
    
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});

/**
 * SYNC 5: UpdateNoteNotFound
 */
export const UpdateNoteNotFound: Sync = ({ request, accessToken, user, noteId, path, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PUT", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(NOTE_PATH_REGEX);
        return match ? { ...f, [noteId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    frames = await frames.query(Posting._getPost, { postId: noteId }, { post });
    return frames.filter(f => f[post] === null);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Note not found" },
  ]),
});

/**
 * SYNC 6: UpdateNoteAccessDenied
 */
export const UpdateNoteAccessDenied: Sync = ({ request, accessToken, user, noteId, path, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "PUT", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(NOTE_PATH_REGEX);
        return match ? { ...f, [noteId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    frames = await frames.query(Posting._getPost, { postId: noteId }, { post });
    return frames.filter(f => {
        const p = f[post] as any;
        return p && p.author !== f[user];
    });
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 403, error: "Access denied" },
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: PUT /notes/{noteId}",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Requesting = concepts.Requesting as any;
    const Sessioning = concepts.Sessioning as any;
    const Posting = concepts.Posting as any;

    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Posting.posts = db.collection("Posting.posts");

    try {
        Engine.logging = Logging.OFF;
        Engine.register(syncs);

        // Setup: User A
        const userA = freshID();
        const { accessToken: tokenA } = await Sessioning.create({ user: userA });

        // Setup: User B
        const userB = freshID();
        const { accessToken: tokenB } = await Sessioning.create({ user: userB });

        // Setup: User A's note
        const { postId } = await Posting.createPost({ 
            author: userA, 
            content: { text: "Original Content" } 
        });

        // =================================================================
        // TEST 1: Success - Owner updates their note
        // =================================================================
        console.log("TEST 1: Owner updates note");
        // RULE 5: Optional Fields in Update
        // Include new optional field (metadata) to verify it persists
        const newContent = { text: "Updated Content" };
        const newMetadata = { tags: ["updated"] };
        
        const updateInputs = {
            path: `/notes/${postId}`,
            method: "PUT",
            accessToken: tokenA,
            content: newContent,
            metadata: newMetadata
        };
        const { request: req1 } = await Requesting.request(updateInputs);
        const [res1] = await Requesting._awaitResponse({ request: req1 });
        
        assertEquals(res1.response.status, "success");

        // Verify DB
        const [postRes] = await Posting._getPost({ postId });
        assertEquals(postRes.post.content.text, "Updated Content", "Text should be updated");
        assertEquals(postRes.post.metadata.tags[0], "updated", "Optional metadata should be saved");

        // =================================================================
        // TEST 1B: Update with Missing Optional Fields
        // =================================================================
        console.log("TEST 1B: Update removing optional fields");
        // Update again without metadata - should clear it or leave it depending on logic
        // For this example, we assume we omit it to clear it/ignore it
        const plainContent = { text: "Plain Content" };
        const req1b = await Requesting.request({
            path: `/notes/${postId}`,
            method: "PUT",
            accessToken: tokenA,
            content: plainContent
            // metadata omitted
        });
        const [res1b] = await Requesting._awaitResponse({ request: req1b.request });
        assertEquals(res1b.response.status, "success");
        
        const [postRes2] = await Posting._getPost({ postId });
        assertEquals(postRes2.post.content.text, "Plain Content");
        // Note: Actual behavior depends on whether sync passes 'undefined' or merges.
        // Good practice is to check it's handled gracefully.
        // If the sync passes 'undefined' to updateProfile, it might not unset it. 
        // But for this example, we verify it doesn't crash and main content updates.

        // =================================================================
        // TEST 2: Auth Error - Invalid token
        // =================================================================
        console.log("TEST 2: Invalid token");
        const invalidInputs = {
            path: `/notes/${postId}`,
            method: "PUT",
            accessToken: "invalid_token",
            content: newContent
        };
        const { request: req2 } = await Requesting.request(invalidInputs);
        const [res2] = await Requesting._awaitResponse({ request: req2 });
        
        assertEquals(res2.response.statusCode, 401);

        // =================================================================
        // TEST 3: Not Found
        // =================================================================
        console.log("TEST 3: Note not found");
        const notFoundInputs = {
            path: `/notes/000000000000000000000000`,
            method: "PUT",
            accessToken: tokenA,
            content: newContent
        };
        const { request: req3 } = await Requesting.request(notFoundInputs);
        const [res3] = await Requesting._awaitResponse({ request: req3 });
        
        assertEquals(res3.response.statusCode, 404);

        // =================================================================
        // TEST 4: Access Denied - Non-owner tries to update
        // =================================================================
        console.log("TEST 4: Access denied");
        const deniedInputs = {
            path: `/notes/${postId}`,
            method: "PUT",
            accessToken: tokenB,  // User B's token
            content: newContent
        };
        const { request: req4 } = await Requesting.request(deniedInputs);
        const [res4] = await Requesting._awaitResponse({ request: req4 });
        
        assertEquals(res4.response.statusCode, 403);

    } finally {
        await client.close();
    }
  }
});
```

---

## DELETE /notes/{noteId}
**Summary:** Delete a note

**Description:** Deletes a specific note.

**OpenAPI Spec:**
```yaml
delete:
  summary: Delete a note
  description: Deletes a specific note.
  parameters:
    - in: path
      name: noteId
      required: true
      schema:
        type: string
    - in: query
      name: accessToken
      required: true
      schema:
        type: string
  responses:
    '200':
      description: Note deleted
      content:
        application/json:
          schema:
            type: object
            properties:
              status:
                type: string
                example: deleted
    '401':
      description: Unauthorized
    '403':
      description: Access Denied
    '404':
      description: Note not found
```

### Syncs
```typescript
import { actions, Sync } from "@engine";
import { Requesting, Sessioning, Posting } from "@concepts";

// =============================================================================
// DELETE /notes/{noteId} - MULTI-SYNC PATTERN FOR MUTATIONS
// =============================================================================

const NOTE_PATH_REGEX = /^\/notes\/([^\/]+)$/;

/**
 * SYNC 1: DeleteNoteRequest
 */
export const DeleteNoteRequest: Sync = ({ request, accessToken, user, noteId, path, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Parse path
    frames = frames.map(f => {
        const p = f[path] as string;
        const match = p.match(NOTE_PATH_REGEX);
        return match ? { ...f, [noteId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    // Auth
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // Authorization
    frames = await frames.query(Posting._getPost, { postId: noteId }, { post });
    return frames.filter(f => {
        const p = f[post] as any;
        return p && p.author === f[user];
    });
  },
  then: actions([
    Posting.deletePost,
    { postId: noteId, author: user },
  ]),
});

/**
 * SYNC 2: DeleteNoteResponseSuccess
 */
export const DeleteNoteResponseSuccess: Sync = ({ request, path }) => ({
  when: actions(
    [Requesting.request, { path, method: "DELETE" }, { request }],
    [Posting.deletePost, {}, {}],
  ),
  where: async (frames) => {
    return frames.filter(f => NOTE_PATH_REGEX.test(f[path] as string));
  },
  then: actions([
    Requesting.respond,
    { request, status: "deleted" },
  ]),
});

/**
 * SYNC 3: DeleteNoteAuthError
 */
export const DeleteNoteAuthError: Sync = ({ request, accessToken, error, path }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.filter(f => NOTE_PATH_REGEX.test(f[path] as string));
    if (frames.length === 0) return frames;
    
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});

/**
 * SYNC 4: DeleteNoteNotFound
 */
export const DeleteNoteNotFound: Sync = ({ request, accessToken, user, noteId, path, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(NOTE_PATH_REGEX);
        return match ? { ...f, [noteId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    frames = await frames.query(Posting._getPost, { postId: noteId }, { post });
    return frames.filter(f => f[post] === null);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Note not found" },
  ]),
});

/**
 * SYNC 5: DeleteNoteAccessDenied
 */
export const DeleteNoteAccessDenied: Sync = ({ request, accessToken, user, noteId, path, post }) => ({
  when: actions([
    Requesting.request,
    { path, method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = frames.map(f => {
        const match = (f[path] as string).match(NOTE_PATH_REGEX);
        return match ? { ...f, [noteId]: match[1] } : null;
    }).filter(f => f !== null) as any;

    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    frames = await frames.query(Posting._getPost, { postId: noteId }, { post });
    return frames.filter(f => {
        const p = f[post] as any;
        return p && p.author !== f[user];
    });
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 403, error: "Access denied" },
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: DELETE /notes/{noteId}",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Requesting = concepts.Requesting as any;
    const Sessioning = concepts.Sessioning as any;
    const Posting = concepts.Posting as any;

    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Posting.posts = db.collection("Posting.posts");

    try {
        Engine.logging = Logging.OFF;
        Engine.register(syncs);

        // Setup: Users
        const userA = freshID();
        const { accessToken: tokenA } = await Sessioning.create({ user: userA });
        
        const userB = freshID();
        const { accessToken: tokenB } = await Sessioning.create({ user: userB });

        // Setup: Notes
        const { postId: note1 } = await Posting.createPost({ 
            author: userA, 
            content: { text: "Note 1" } 
        });
        const { postId: note2 } = await Posting.createPost({ 
            author: userA, 
            content: { text: "Note 2" } 
        });

        // =================================================================
        // TEST 1: Success - Owner deletes their note
        // =================================================================
        console.log("TEST 1: Owner deletes note");
        const deleteInputs = {
            path: `/notes/${note1}`,
            method: "DELETE",
            accessToken: tokenA
        };
        const { request: req1 } = await Requesting.request(deleteInputs);
        const [res1] = await Requesting._awaitResponse({ request: req1 });
        
        assertEquals(res1.response.status, "deleted");
        
        // Verify deletion
        const [check1] = await Posting._getPost({ postId: note1 });
        assertEquals(check1.post, null, "Note should be deleted");

        // =================================================================
        // TEST 2: Not Found - Already deleted
        // =================================================================
        console.log("TEST 2: Delete already deleted note");
        const { request: req2 } = await Requesting.request(deleteInputs);
        const [res2] = await Requesting._awaitResponse({ request: req2 });
        
        assertEquals(res2.response.statusCode, 404);

        // =================================================================
        // TEST 3: Access Denied - Non-owner tries to delete
        // =================================================================
        console.log("TEST 3: Non-owner access denied");
        const deniedInputs = {
            path: `/notes/${note2}`,
            method: "DELETE",
            accessToken: tokenB
        };
        const { request: req3 } = await Requesting.request(deniedInputs);
        const [res3] = await Requesting._awaitResponse({ request: req3 });
        
        assertEquals(res3.response.statusCode, 403);
        
        // Verify note still exists
        const [check3] = await Posting._getPost({ postId: note2 });
        assertExists(check3.post, "Note should still exist");

        // =================================================================
        // TEST 4: Auth Error - Invalid token
        // =================================================================
        console.log("TEST 4: Invalid token");
        const authInputs = {
            path: `/notes/${note2}`,
            method: "DELETE",
            accessToken: "invalid_token"
        };
        const { request: req4 } = await Requesting.request(authInputs);
        const [res4] = await Requesting._awaitResponse({ request: req4 });
        
        assertEquals(res4.response.statusCode, 401);

    } finally {
        await client.close();
    }
  }
});
```

---

## GET /profiles
**Summary:** Get current user profile

**Description:** Retrieves the profile of the authenticated user. Demonstrates ID mapping (_id -> user).

**OpenAPI Spec:**
```yaml
get:
  summary: Get current user profile
  description: Retrieves the profile of the authenticated user.
  parameters:
    - in: query
      name: accessToken
      required: true
      schema:
        type: string
  responses:
    '200':
      description: User profile
      content:
        application/json:
          schema:
            type: object
            required:
              - profile
            properties:
              profile:
                type: object
                required:
                  - user
                  - username
                  - name
                properties:
                  user:
                    type: string
                    description: The User ID (Must be mapped from _id)
                  username:
                    type: string
                  name:
                    type: string
                  bio:
                    type: string
                  bioImageUrl:
                    type: string
    '401':
      description: Unauthorized
    '404':
      description: Profile not found
```

### Syncs
```typescript
import { actions, Sync } from "@engine";
import { Requesting, Sessioning, Profiling } from "@concepts";

// =============================================================================
// GET /profiles - READ PATTERN WITH ID MAPPING
// =============================================================================
// 1. Authenticate
// 2. Fetch Profile
// 3. MAP _id TO user (Crucial step!)
// =============================================================================

export const GetMyProfile: Sync = ({ request, accessToken, user, profile }) => ({
  when: actions([
    Requesting.request,
    { path: "/profiles", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 2. Fetch profile
    frames = await frames.query(Profiling._getProfile, { user }, { profile });
    
    // 3. Ensure profile exists and perform MAPPING
    const mappedFrames = frames.map(f => {
        const p = f[profile];
        if (!p) return null;
        
        // CRITICAL: Map _id to user if API requires 'user' field
        // The Profiling concept uses the user ID as the _id of the profile document
        return {
            ...f,
            [profile]: {
                ...p,
                user: p._id // Ensure 'user' field exists for API compliance
            }
        };
    }).filter(f => f !== null);

    return new Frames(...mappedFrames);
  },
  then: actions([
    Requesting.respond,
    { request, profile },
  ]),
});

export const GetMyProfileNotFound: Sync = ({ request, accessToken, user, profile }) => ({
  when: actions([
    Requesting.request,
    { path: "/profiles", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);
    frames = await frames.query(Profiling._getProfile, { user }, { profile });
    return frames.filter(f => !f[profile]);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 404, error: "Profile not found" },
  ]),
});

export const GetMyProfileAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/profiles", method: "GET", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" },
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: GET /profiles",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Authenticating = concepts.Authenticating as any;
    const Sessioning = concepts.Sessioning as any;
    const Profiling = concepts.Profiling as any;
    const Requesting = concepts.Requesting as any;

    Authenticating.users = db.collection("Authenticating.users");
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Profiling.profiles = db.collection("Profiling.profiles");
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();

    try {
      Engine.logging = Logging.OFF;
      Engine.register(syncs);

      // Setup: Create user and profile
      const email = "user@example.com";
      const password = "password123";
      const regResult = await Authenticating.register({ email, password });
      const userId = regResult.user;

      const { accessToken } = await Sessioning.create({ user: userId });

      // Create profile with optional fields
      const bio = "My Bio";
      await Profiling.createProfile({
        user: userId,
        username: "testuser",
        name: "Test User",
        bio
      });

      // =================================================================
      // TEST 1: Success - Verify ID Mapping
      // =================================================================
      console.log("TEST 1: Success");
      const req1 = await Requesting.request({
        path: "/profiles",
        method: "GET",
        accessToken
      });
      const [res1] = await Requesting._awaitResponse({ request: req1.request });
      const data1 = res1.response as any;

      assertExists(data1.profile, "Should return profile");
      
      // CRITICAL: Verify OpenAPI Schema Compliance
      // The API expects 'user' field, even if DB has '_id'
      assertExists(data1.profile.user, "Profile MUST have 'user' field (mapped from _id)");
      assertEquals(data1.profile.user, userId, "User ID must match");
      assertEquals(data1.profile.bio, bio, "Optional field 'bio' should be present");

      // =================================================================
      // TEST 2: Profile Not Found
      // =================================================================
      console.log("TEST 2: Not Found");
      const user2 = freshID();
      const { accessToken: token2 } = await Sessioning.create({ user: user2 });
      
      const req2 = await Requesting.request({
        path: "/profiles",
        method: "GET",
        accessToken: token2
      });
      const [res2] = await Requesting._awaitResponse({ request: req2.request });
      assertEquals(res2.response.statusCode, 404);

      // =================================================================
      // TEST 3: Auth Error - Invalid Token (Rule 5)
      // =================================================================
      console.log("TEST 3: Invalid Token");
      const req3 = await Requesting.request({
        path: "/profiles",
        method: "GET",
        accessToken: "invalid_token"
      });
      const [res3] = await Requesting._awaitResponse({ request: req3.request });
      assertEquals(res3.response.statusCode, 401, "Should return 401 for invalid token");

    } finally {
      await client.close();
    }
  }
});
```

---

## POST /profiles
**Summary:** Create My Profile

**Description:** Initializes the public profile for the user. Demonstrates safe optional field handling.

**OpenAPI Spec:**
```yaml
post:
  summary: Create My Profile
  description: Initializes the public profile for the user.
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required:
            - accessToken
            - username
            - name
          properties:
            accessToken:
              type: string
            username:
              type: string
            name:
              type: string
            bio:
              type: string
              description: Optional biography
            bioImageUrl:
              type: string
              description: Optional profile image URL
  responses:
    '201':
      description: Profile created
      content:
        application/json:
          schema:
            type: object
            required:
              - profile
            properties:
              profile:
                type: object
                required:
                  - user
                  - username
                  - name
                properties:
                  user:
                    type: string
                    description: User ID
                  username:
                    type: string
                  name:
                    type: string
                  bio:
                    type: string
                  bioImageUrl:
                    type: string
    '400':
      description: Missing required fields
    '401':
      description: Unauthorized
    '409':
      description: Profile already exists
```

### Syncs
```typescript
import { actions, Sync, Frames } from "@engine";
import { Requesting, Sessioning, Profiling, db } from "@concepts";

// =============================================================================
// POST /profiles - MULTI-SYNC PATTERN WITH OPTIONAL FIELDS
// =============================================================================
// 1. Authenticate
// 2. Fetch Optional Fields (bio, etc) safely from DB (Rule 5)
// 3. Trigger Creation
// =============================================================================

export const CreateProfileRequest: Sync = ({ request, user, accessToken, username, name, bio, bioImageUrl }) => ({
  when: actions([
    Requesting.request,
    // Only include MANDATORY fields in 'when'. Optional fields are handled in 'where'.
    { path: "/profiles", method: "POST", accessToken, username, name },
    { request }
  ]),
  where: async (frames) => {
    // 1. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 2. Fetch optional fields from DB (Rule 5 compliance)
    const requests = db.collection<any>("Requesting.requests");
    const newFrames = await Promise.all(frames.map(async f => {
        const req = await requests.findOne({ _id: f[request] });
        if (!req) return null;
        return {
            ...f,
            // Default to empty string/null if undefined, to prevent undefined binding errors
            [bio]: req.input.bio || "",
            [bioImageUrl]: req.input.bioImageUrl || ""
        };
    }));
    
    return new Frames(...newFrames.filter(f => f !== null));
  },
  then: actions([
    Profiling.createProfile,
    { user, username, name, bio, bioImageUrl }
  ]),
});

export const CreateProfileSuccess: Sync = ({ request, user, profile }) => ({
  when: actions(
    [Requesting.request, { path: "/profiles", method: "POST" }, { request }],
    [Profiling.createProfile, { user }, { ok: true }]
  ),
  where: async (frames) => {
    // Fetch the created profile to return it
    frames = await frames.query(Profiling._getProfile, { user }, { profile });
    return frames.map(f => {
        const p = f[profile];
        if (!p) return null;
        // MAP ID (Rule 6)
        return { ...f, [profile]: { ...p, user: p._id } };
    }).filter(f => f !== null);
  },
  then: actions([
    Requesting.respond,
    { request, profile, statusCode: 201 }
  ]),
});

export const CreateProfileError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/profiles", method: "POST" }, { request }],
    [Profiling.createProfile, {}, { error }]
  ),
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 409 }
  ]),
});

export const CreateProfileValidationError: Sync = ({ request }) => ({
  when: actions([
    Requesting.request,
    { path: "/profiles", method: "POST" },
    { request }
  ]),
  where: async (frames) => {
    const requests = db.collection<any>("Requesting.requests");
    const newFrames = await Promise.all(frames.map(async f => {
        const req = await requests.findOne({ _id: f[request] });
        if (!req) return null;
        // Check if required fields are missing
        const missingFields = !req.input.username || !req.input.name;
        return missingFields ? f : null;
    }));
    return new Frames(...newFrames.filter(f => f !== null));
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 400, error: "Missing required fields: username and name" }
  ]),
});

export const CreateProfileAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/profiles", method: "POST", accessToken },
    { request }
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" }
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: POST /profiles",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Requesting = concepts.Requesting as any;
    const Sessioning = concepts.Sessioning as any;
    const Profiling = concepts.Profiling as any;
    const Authenticating = concepts.Authenticating as any;

    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Profiling.profiles = db.collection("Profiling.profiles");
    Authenticating.users = db.collection("Authenticating.users");

    try {
        Engine.logging = Logging.OFF;
        Engine.register(syncs);

        // Setup
        const email = "test@example.com";
        const password = "password123";
        const reg = await Authenticating.register({ email, password });
        const userId = reg.user;
        const session = await Sessioning.create({ user: userId });
        const accessToken = session.accessToken;

        // =================================================================
        // TEST 1: Success - Full Profile (Rule 5 & 6)
        // =================================================================
        console.log("TEST 1: Full Profile");
        const fullInputs = {
            path: "/profiles",
            method: "POST",
            accessToken,
            username: "testuser",
            name: "Test User",
            bio: "Bio",
            bioImageUrl: "http://img.com/1.jpg"
        };

        const { request: req1 } = await Requesting.request(fullInputs);
        const [res1] = await Requesting._awaitResponse({ request: req1 });
        const data1 = res1.response as any;

        assertEquals(data1.statusCode, 201);
        assertExists(data1.profile);
        // Rule 6: ID Mapping
        assertEquals(data1.profile.user, userId, "Must map _id to user");
        // Rule 5: Optional fields saved
        assertEquals(data1.profile.bio, "Bio");

        // =================================================================
        // TEST 2: Success - Minimal Profile (Missing Optionals)
        // =================================================================
        console.log("TEST 2: Minimal Profile");
        const user2Id = freshID();
        const session2 = await Sessioning.create({ user: user2Id });
        
        const minInputs = {
            path: "/profiles",
            method: "POST",
            accessToken: session2.accessToken,
            username: "user2",
            name: "User Two"
            // bio omitted
        };

        const { request: req2 } = await Requesting.request(minInputs);
        const [res2] = await Requesting._awaitResponse({ request: req2 });
        const data2 = res2.response as any;

        assertEquals(data2.statusCode, 201);
        // Ensure it didn't crash and saved default/empty
        assertEquals(data2.profile.bio, "");

        // =================================================================
        // TEST 3: Validation Error (Missing Required)
        // =================================================================
        console.log("TEST 3: Validation Error");
        const invalidInputs = {
            path: "/profiles",
            method: "POST",
            accessToken,
            username: "invalid"
            // name omitted
        };
        const { request: req3 } = await Requesting.request(invalidInputs);
        const [res3] = await Requesting._awaitResponse({ request: req3 });
        assertEquals(res3.response.statusCode, 400);

    } finally {
        await client.close();
    }
  }
});
```

// =============================================================================
// PATCH /profiles
// =============================================================================
// OpenAPI:
// paths:
//   /profiles:
//     patch:
//       summary: Update My Profile
//       description: Updates the logged-in user's profile.
//       security:
//         - bearerAuth: []
//       requestBody:
//         content:
//           application/json:
//             schema:
//               type: object
//               properties:
//                 username:
//                   type: string
//                 name:
//                   type: string
//                 bio:
//                   type: string
//                 bioImageUrl:
//                   type: string
//       responses:
//         '200':
//           description: Profile updated successfully
//           content:
//             application/json:
//               schema:
//                 type: object
//                 properties:
//                   success:
//                     type: boolean
//         '400':
//           description: Validation error
//         '401':
//           description: Unauthorized

/**
 * SYNC 1: UpdateProfileRequest
 *
 * Pattern: Multi-Sync Mutation with Current State Merge
 * 1. Match request
 * 2. Authenticate
 * 3. Fetch CURRENT profile (to handle partial updates safely)
 * 4. Fetch optional fields from Requesting collection
 * 5. Merge Input + Current -> New State
 * 6. Pass fully defined state to Profiling.updateProfile
 */
export const UpdateProfileRequest: Sync = ({
  request, accessToken, user, profile,
  username, name, bio, bioImageUrl
}) => ({
  when: actions([
    Requesting.request,
    // Only include GUARANTEED fields
    { path: "/profiles", method: "PATCH", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // 1. Authenticate
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { user });
    frames = frames.filter(f => f[user] !== undefined);

    // 2. Fetch CURRENT profile
    // We need this to fallback to existing values for missing fields
    frames = await frames.query(Profiling._getProfile, { user }, { profile });

    // 3. Fetch input & Merge
    // CRITICAL: Use <any> generic to avoid TS2769 error with _id type mismatch
    const requests = db.collection<any>("Requesting.requests");
    
    const newFrames = await Promise.all(frames.map(async f => {
        const req = await requests.findOne({ _id: f[request] });
        if (!req) return null;

        const input = req.input;
        const current = f[profile] || {};

        return {
            ...f,
            // CRITICAL: Merge Input with Current State
            // If input field is missing/undefined, keep the current value.
            // This ensures we never pass 'undefined' to the 'then' clause,
            // which causes "Missing binding" errors.
            [username]: input.username ?? current.username ?? "",
            [name]: input.name ?? current.name ?? "",
            [bio]: input.bio ?? current.bio ?? "",
            [bioImageUrl]: input.bioImageUrl ?? current.bioImageUrl ?? ""
        };
    }));

    return new Frames(...newFrames.filter(f => f !== null));
  },
  then: actions([
    Profiling.updateProfile,
    { user, username, name, bio, bioImageUrl },
  ]),
});

export const UpdateProfileSuccess: Sync = ({ request }) => ({
  when: actions(
    [Requesting.request, { path: "/profiles", method: "PATCH" }, { request }],
    // Match success output
    [Profiling.updateProfile, {}, { ok: true }]
  ),
  then: actions([
    Requesting.respond,
    { request, success: true }
  ]),
});

export const UpdateProfileError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/profiles", method: "PATCH" }, { request }],
    // Match error output
    [Profiling.updateProfile, {}, { error }]
  ),
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 }
  ]),
});

export const UpdateProfileAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/profiles", method: "PATCH", accessToken },
    { request }
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, { error });
    return frames.filter(f => f[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, statusCode: 401, error: "Unauthorized" }
  ]),
});
```

### Tests
```typescript
import { assertEquals, assertExists } from "jsr:@std/assert";
import { testDb, freshID } from "@utils/database.ts";
import * as concepts from "@concepts";
import { Engine } from "@concepts";
import { Logging } from "@engine";
import syncs from "@syncs";
import "jsr:@std/dotenv/load";

Deno.test({
  name: "Sync: PATCH /profiles",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const [db, client] = await testDb();
    const Requesting = concepts.Requesting as any;
    const Sessioning = concepts.Sessioning as any;
    const Profiling = concepts.Profiling as any;
    const Authenticating = concepts.Authenticating as any;

    // Monkey-patch collections
    Requesting.requests = db.collection("Requesting.requests");
    Requesting.pending = new Map();
    Sessioning.sessions = db.collection("Sessioning.sessions");
    Profiling.profiles = db.collection("Profiling.profiles");
    Authenticating.users = db.collection("Authenticating.users");

    try {
        Engine.logging = Logging.OFF;
        Engine.register(syncs);

        // Setup: User & Session
        const email = "test@example.com";
        const password = "password123";
        const reg = await Authenticating.register({ email, password });
        const userId = reg.user;
        const session = await Sessioning.create({ user: userId });
        const accessToken = session.accessToken;

        // Setup: Initial Profile
        await Profiling.createProfile({
            user: userId,
            username: "original_user",
            name: "Original Name",
            bio: "Original Bio"
        });

        // =================================================================
        // TEST 1: Success - Partial Update (Rule 5)
        // =================================================================
        console.log("TEST 1: Partial Update");
        const partialInputs = {
            path: "/profiles",
            method: "PATCH",
            accessToken,
            bio: "Updated Bio"
            // username/name omitted
        };

        const { request: req1 } = await Requesting.request(partialInputs);
        const [res1] = await Requesting._awaitResponse({ request: req1 });
        assertEquals(res1.response.success, true);

        // Verify DB: Only bio changed
        const profile1 = await Profiling.profiles.findOne({ _id: userId });
        assertEquals(profile1.bio, "Updated Bio");
        assertEquals(profile1.username, "original_user"); // Unchanged

        // =================================================================
        // TEST 2: Success - Full Update
        // =================================================================
        console.log("TEST 2: Full Update");
        const fullInputs = {
            path: "/profiles",
            method: "PATCH",
            accessToken,
            username: "new_username",
            name: "New Name",
            bio: "New Bio"
        };
        const { request: req2 } = await Requesting.request(fullInputs);
        const [res2] = await Requesting._awaitResponse({ request: req2 });
        assertEquals(res2.response.success, true);

        // Verify DB
        const profile2 = await Profiling.profiles.findOne({ _id: userId });
        assertEquals(profile2.username, "new_username");

        // =================================================================
        // TEST 3: Auth Error
        // =================================================================
        console.log("TEST 3: Auth Error");
        const invalidInputs = {
            path: "/profiles",
            method: "PATCH",
            accessToken: "invalid",
            bio: "hacker"
        };
        const { request: req3 } = await Requesting.request(invalidInputs);
        assertEquals(req3.statusCode, undefined); // Response comes later
        const [res3] = await Requesting._awaitResponse({ request: req3 });
        assertEquals(res3.response.statusCode, 401);

    } finally {
        await client.close();
    }
  }
});
```