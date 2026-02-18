import { actions, Sync } from "@engine";
import {
  Authenticating,
  Commenting,
  Liking,
  Paginating,
  Posting,
  Profiling,
  Requesting,
  Sessioning,
} from "@concepts";

/**
 * SYNC 1: DeleteAccountRequest
 * Purpose: Authenticate the user and trigger a cascading deletion of all user data.
 */
export const DeleteAccountRequest: Sync = ({ request, accessToken, user }) => ({
  when: actions([
    Requesting.request,
    { path: "/me", method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Authenticate the user using the access token
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      user,
    });
    // Only proceed if a user was successfully identified
    return frames.filter(($) => $[user] !== undefined);
  },
  then: actions(
    [Authenticating.deleteAuthenticationByUser, { user }],
    [Profiling.deleteProfile, { user }],
    [Posting.deleteByAuthor, { author: user }],
    [Commenting.deleteByAuthor, { author: user }],
    [Liking.deleteByUser, { user }],
    [Paginating.deleteByBound, { bound: user }],
    [Sessioning.deleteByUser, { user }],
  ),
});

/**
 * SYNC 2: DeleteAccountResponseSuccess
 * Purpose: Respond to the client after the primary account record is deleted.
 */
export const DeleteAccountResponseSuccess: Sync = ({ request }) => ({
  when: actions(
    [Requesting.request, { path: "/me", method: "DELETE" }, { request }],
    [Authenticating.deleteAuthenticationByUser, {}, { ok: true }],
  ),
  then: actions([
    Requesting.respond,
    { request }, // Returns {} as per OpenAPI spec
  ]),
});

/**
 * SYNC 3: DeleteAccountResponseError
 * Purpose: Respond with an error if the primary account deletion fails.
 */
export const DeleteAccountResponseError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/me", method: "DELETE" }, { request }],
    [Authenticating.deleteAuthenticationByUser, {}, { error }],
  ),
  then: actions([
    Requesting.respond,
    { request, error, statusCode: 400 },
  ]),
});

/**
 * SYNC 4: DeleteAccountAuthError
 * Purpose: Respond with 401 if authentication fails.
 */
export const DeleteAccountAuthError: Sync = ({ request, accessToken, error }) => ({
  when: actions([
    Requesting.request,
    { path: "/me", method: "DELETE", accessToken },
    { request },
  ]),
  where: async (frames) => {
    frames = await frames.query(Sessioning._getUser, { session: accessToken }, {
      error,
    });
    return frames.filter(($) => $[error] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, error: "Unauthorized", statusCode: 401 },
  ]),
});