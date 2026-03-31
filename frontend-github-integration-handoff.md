# Frontend GitHub Integration Handoff

## Scope

This backend change adds GitHub account linking and manual GitHub export of assembled backend/frontend artifacts.

Gemini is intentionally unchanged:

- same Gemini routes
- same Gemini request fields
- same Gemini headers
- same Gemini response payloads
- no required Gemini frontend migration work

Frontend work should be limited to GitHub settings/linking UI, popup callback handling, and separate backend/frontend export actions.

## New Endpoints

### `GET /api/me/github`

Auth:
- `Authorization: Bearer <accessToken>`

Returns either:

```json
{
  "hasGithubCredential": false
}
```

or:

```json
{
  "hasGithubCredential": true,
  "kdfSalt": "base64-salt",
  "kdfParams": {
    "algorithm": "PBKDF2",
    "iterations": 600000
  },
  "encryptionVersion": "v1",
  "githubLogin": "octocat",
  "externalAccountId": "12345",
  "githubInstallationId": "6789",
  "githubPermissions": {
    "administration": "write",
    "contents": "write"
  },
  "githubTokenType": "bearer",
  "githubAccessTokenExpiresAt": "2026-04-01T00:00:00.000Z",
  "githubRefreshTokenExpiresAt": "2026-10-01T00:00:00.000Z"
}
```

Notes:
- This returns shared vault KDF metadata, not GitHub tokens.
- The same `kdfSalt`, `kdfParams`, and `encryptionVersion` are shared with Gemini inside the user vault.

### `POST /api/me/github/link/start`

Auth:
- `Authorization: Bearer <accessToken>`

Body:

```json
{
  "frontendOrigin": "https://app.example.com",
  "returnPath": "/settings/integrations"
}
```

`returnPath` is optional. If omitted, backend defaults to `"/settings"`.

Response:

```json
{
  "statusCode": 200,
  "authorizationUrl": "https://github.com/login/oauth/authorize?...",
  "stateExpiresAt": "2026-04-01T00:00:00.000Z"
}
```

### `GET /api/auth/github/callback`

This is the popup callback target registered with the GitHub App.

It returns HTML, not JSON. That page calls `window.opener.postMessage(...)`.

Success message payload:

```json
{
  "type": "conceptualai:github-link-callback",
  "ok": true,
  "returnPath": "/settings/integrations",
  "githubCredential": {
    "accessToken": "ghu_...",
    "refreshToken": "ghr_...",
    "tokenType": "bearer",
    "accessTokenExpiresAt": "2026-04-01T00:00:00.000Z",
    "refreshTokenExpiresAt": "2026-10-01T00:00:00.000Z",
    "githubLogin": "octocat",
    "externalAccountId": "12345",
    "installationId": "6789",
    "permissions": {
      "administration": "write",
      "contents": "write"
    }
  }
}
```

Error message payload:

```json
{
  "type": "conceptualai:github-link-callback",
  "ok": false,
  "error": "GitHub callback state mismatch or expiration."
}
```

### `POST /api/me/github/link/complete`

Auth:
- `Authorization: Bearer <accessToken>`

Body:

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
  "encryptionVersion": "v1",
  "externalAccountId": "12345",
  "githubLogin": "octocat",
  "installationId": "6789",
  "permissions": {
    "administration": "write",
    "contents": "write"
  },
  "tokenType": "bearer",
  "accessTokenExpiresAt": "2026-04-01T00:00:00.000Z",
  "refreshTokenExpiresAt": "2026-10-01T00:00:00.000Z"
}
```

Only these fields are required:
- `accountPassword`
- `ciphertext`
- `iv`
- `kdfSalt`
- `kdfParams`
- `encryptionVersion`
- `externalAccountId`
- `githubLogin`

The remaining GitHub metadata fields are optional and should be sent when available from the callback payload.

Success response:
- same shape as `GET /api/me/github`

### `DELETE /api/me/github`

Auth:
- `Authorization: Bearer <accessToken>`

Response:

```json
{
  "ok": true
}
```

### `POST /api/projects/:projectId/export/backend/github`

Auth:
- `Authorization: Bearer <accessToken>`

Body:

```json
{
  "unwrapKey": "client-derived-shared-vault-key",
  "repoName": "optional-custom-backend-repo",
  "visibility": "private"
}
```

`repoName` is optional.
`visibility` is optional and defaults to `"private"`.

Success response:

```json
{
  "project": "project_id",
  "artifact": "backend",
  "status": "processing",
  "repoName": "my-project-backend",
  "visibility": "private"
}
```

### `POST /api/projects/:projectId/export/frontend/github`

Auth:
- `Authorization: Bearer <accessToken>`

Body:

```json
{
  "unwrapKey": "client-derived-shared-vault-key",
  "repoName": "optional-custom-frontend-repo",
  "visibility": "public"
}
```

Success response:

```json
{
  "project": "project_id",
  "artifact": "frontend",
  "status": "processing",
  "repoName": "my-project-frontend",
  "visibility": "public"
}
```

### `GET /api/projects/:projectId/export/github/status`

Auth:
- `Authorization: Bearer <accessToken>`

Response:

```json
{
  "backend": {
    "artifact": "backend",
    "repoName": "my-project-backend",
    "visibility": "private",
    "status": "complete",
    "repoUrl": "https://github.com/octocat/my-project-backend",
    "repoOwner": "octocat",
    "repoId": "123456",
    "remoteExists": true,
    "lastRemoteCheckAt": "2026-04-01T00:00:00.000Z",
    "logs": [
      "Queued a new GitHub export attempt."
    ],
    "createdAt": "2026-04-01T00:00:00.000Z",
    "updatedAt": "2026-04-01T00:00:10.000Z"
  },
  "frontend": null
}
```

Status meanings:
- `processing`: export job created and running
- `complete`: repo created and initial push finished
- `error`: export failed
- `stale`: previously tracked repo no longer exists remotely, so re-export is allowed

## Shared Vault Behavior

The vault is now shared across providers per user.

Frontend implications:

1. Derive one unwrap key per signed-in user session.
2. Reuse that same unwrap key for Gemini and GitHub.
3. Keep Gemini API behavior unchanged.
4. Require `accountPassword` for GitHub credential writes, even if an unwrap key already exists in memory.

Recommended client behavior:

1. After login, continue calling `GET /api/me/gemini-credential` exactly as before.
2. Also call `GET /api/me/github` when rendering GitHub settings/export UI.
3. If either response returns shared vault metadata, derive the unwrap key once and reuse it.
4. If neither provider is linked yet, generate fresh `kdfSalt`/`kdfParams` when the user first stores a credential.

## Link Flow

Recommended flow:

1. User clicks `Connect GitHub`.
2. Frontend calls `POST /api/me/github/link/start` with `frontendOrigin` and optional `returnPath`.
3. Open `authorizationUrl` in a popup.
4. Listen for `message` events from the popup.
5. Validate:
   - `event.origin` matches your frontend origin
   - `event.data.type === "conceptualai:github-link-callback"`
6. If `ok === false`, show the returned error.
7. If `ok === true`, prompt for the current account password if it is not already available.
8. Build the plaintext GitHub credential payload from `event.data.githubCredential`.
9. Determine vault metadata:
   - reuse existing `kdfSalt`, `kdfParams`, `encryptionVersion` if available from `GET /api/me/github` or `GET /api/me/gemini-credential`
   - otherwise create fresh metadata for this first stored credential
10. Encrypt the GitHub credential client-side with the shared derived key.
11. Call `POST /api/me/github/link/complete`.
12. Replace local UI state with the returned redacted GitHub status payload.
13. Redirect back to `returnPath` if you launched linking from a pending export action.

## Export Flow

The assembled-project view should expose separate actions:

- `Export Backend to GitHub`
- `Export Frontend to GitHub`

Recommended flow:

1. On assembled-project page load, call `GET /api/projects/:projectId/export/github/status`.
2. If GitHub is not linked, disable export buttons or route the user into the connect flow.
3. If the user clicks export while unlinked:
   - save the pending action locally
   - route them to settings/integrations
   - after successful linking, return them to the project and resume the intended export
4. On export click, send the shared `unwrapKey` in the JSON body.
5. Allow optional custom repo name and visibility selection per artifact.
6. Poll `GET /api/projects/:projectId/export/github/status` until the job leaves `processing`.

## Expected UI States

### Settings / Integration states

- Unlinked:
  - show `Connect GitHub`
  - show no GitHub account metadata
- Linking popup open:
  - show spinner or `Waiting for GitHub...`
- Linked:
  - show `githubLogin`
  - show `Disconnect GitHub`
  - optionally show permissions and token expiry metadata
- Link error:
  - show backend-provided error text

### Export states

- Unlinked:
  - export buttons should route through connect flow
- Ready to export:
  - backend/frontend buttons enabled independently
- Processing:
  - disable only the artifact currently exporting
- Export complete:
  - show repo link from `repoUrl`
- Export blocked because repo exists:
  - show the backend error `This artifact is already exported to a live GitHub repository.`
  - disable repeat export while `remoteExists === true`
- Re-export allowed after remote deletion:
  - when status becomes `stale`, re-enable export
- Export error:
  - show latest log/error summary and allow retry when appropriate

## Minimal Frontend Changes

Required:

- settings/integrations GitHub connect + disconnect UI
- popup-based GitHub callback handling
- client-side wrapping for GitHub credential storage
- separate backend/frontend export buttons on assembled-project view
- export status polling UI
- pending-export redirect/resume flow

Not required:

- Gemini route changes
- Gemini response-shape changes
- Gemini header changes
- GitHub sign-in as an auth provider

## Rollout Notes

- Existing users with Gemini already stored should keep working without frontend Gemini changes.
- A user may have Gemini only, GitHub only, or both under the same vault metadata.
- GitHub exports are create-only for now. There is no ongoing sync/update flow.
- The callback route returns HTML for popup bridging; do not fetch it with XHR expecting JSON.
