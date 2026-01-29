import { actions, Sync } from "@engine";
import {
  Authenticating,
  Requesting,
  UserProfileDisplaying,
  Sessioning,
} from "@concepts";

//-- User Registration --//
// Check if username already exists and return error if it does
export const RegisterUsernameExistsError: Sync = ({
  request,
  username,
  user,
}) => ({
  when: actions([Requesting.request, {
    path: "/auth/register",
    username,
  }, { request }]),
  where: async (frames) => {
    // Check if username already exists
    frames = await frames.query(UserProfileDisplaying._userByUsername, {
      username,
    }, { user });
    // Only proceed if username exists (user is found)
    return frames.filter(($) => $[user] !== undefined);
  },
  then: actions([
    Requesting.respond,
    { request, error: "Username already exists", statusCode: 409 },
  ]),
});

// Proceed with registration only if username doesn't exist
export const RegisterRequest: Sync = ({
  request,
  email,
  password,
  name,
  username,
  error,
}) => ({
  when: actions([Requesting.request, {
    path: "/auth/register",
    email,
    password,
    name,
    username,
  }, { request }]),
  where: async (frames) => {
    // Check if username already exists
    frames = await frames.query(UserProfileDisplaying._userByUsername, {
      username,
    }, { error });
    // Only proceed if username does NOT exist (query returned error)
    return frames.filter(($) => $[error] !== undefined);
  },
  then: actions([Authenticating.register, { email, password }]),
});

export const RegisterSuccessCreatesSession: Sync = ({ user }) => ({
  when: actions([Authenticating.register, {}, { user }]),
  then: actions([Sessioning.create, { user }]),
});

export const RegisterResponseSuccess: Sync = ({
  request,
  user,
  accessToken,
  refreshToken,
}) => ({
  when: actions(
    [Requesting.request, { path: "/auth/register" }, { request }],
    [Authenticating.register, {}, { user }],
    [Sessioning.create, {}, { accessToken, refreshToken }],
  ),
  then: actions([
    Requesting.respond,
    { request, accessToken, refreshToken, user },
  ]),
});

export const RegisterResponseError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/register" }, { request }],
    [Authenticating.register, {}, { error }],
  ),
  then: actions([Requesting.respond, { request, error, statusCode: 409 }]),
});

//-- User Login & Session Creation --//
export const LoginRequest: Sync = ({ request, email, password }) => ({
  when: actions([Requesting.request, {
    path: "/auth/login",
    email,
    password,
  }, { request }]),
  then: actions([Authenticating.login, { email, password }]),
});

export const LoginSuccessCreatesSession: Sync = ({ user }) => ({
  when: actions([Authenticating.login, {}, { user }]),
  then: actions([Sessioning.create, { user }]),
});

export const LoginResponseSuccess: Sync = ({
  request,
  user,
  accessToken,
  refreshToken,
}) => ({
  when: actions(
    [Requesting.request, { path: "/auth/login" }, { request }],
    [Authenticating.login, {}, { user }],
    [Sessioning.create, {}, { accessToken, refreshToken }],
  ),
  then: actions([
    Requesting.respond,
    { request, accessToken, refreshToken, user },
  ]),
});

export const LoginResponseError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/login" }, { request }],
    [Authenticating.login, {}, { error }],
  ),
  then: actions([Requesting.respond, { request, error, statusCode: 401 }]),
});

//-- Token Refresh --//
// Clients send refreshToken in the request body to get a new token pair
export const RefreshRequest: Sync = ({ request, refreshToken }) => ({
  when: actions([Requesting.request, {
    path: "/auth/refresh",
    refreshToken,
  }, { request }]),
  then: actions([Sessioning.refresh, { refreshToken }]),
});

export const RefreshResponseSuccess: Sync = ({
  request,
  accessToken,
  refreshToken,
}) => ({
  when: actions(
    [Requesting.request, { path: "/auth/refresh" }, { request }],
    [Sessioning.refresh, {}, { accessToken, refreshToken }],
  ),
  then: actions([
    Requesting.respond,
    { request, accessToken, refreshToken },
  ]),
});

export const RefreshResponseError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/refresh" }, { request }],
    [Sessioning.refresh, {}, { error }],
  ),
  then: actions([Requesting.respond, { request, error, statusCode: 401 }]),
});

//-- User Logout --//
// Clients send accessToken in the Authorization: Bearer header
export const LogoutRequest: Sync = ({ request, accessToken, user }) => ({
  when: actions([Requesting.request, { path: "/auth/logout", accessToken }, {
    request,
  }]),
  where: async (frames) => {
    // Map accessToken to session (Session type is the access token string)
    frames = await frames.query(Sessioning._getUser, {
      session: accessToken,
    }, { user });
    return frames.filter(($) => $[user] !== undefined);
  },
  then: actions([Sessioning.delete, { session: accessToken }]),
});

export const LogoutResponse: Sync = ({ request }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/logout" }, { request }],
    [Sessioning.delete, {}, {}],
  ),
  then: actions([Requesting.respond, { request, status: "logged_out" }]),
});

export const LogoutResponseError: Sync = ({ request, accessToken, error }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/logout", accessToken }, { request }],
  ),
  where: async (frames) => {
    // Map accessToken to session and check for errors
    frames = await frames.query(Sessioning._getUser, {
      session: accessToken,
    }, { error });
    return frames.filter(($) => $[error] !== undefined);
  },
  then: actions([Requesting.respond, { request, error, statusCode: 401 }]),
});

export const LogoutResponseDeleteError: Sync = ({ request, error }) => ({
  when: actions(
    [Requesting.request, { path: "/auth/logout" }, { request }],
    [Sessioning.delete, {}, { error }],
  ),
  then: actions([Requesting.respond, { request, error, statusCode: 401 }]),
});

//-- Session Validation (frontend may poll /Sessioning/_getUser) --//
// Clients send accessToken in the Authorization: Bearer header
export const SessionValidationSuccess: Sync = (
  { request, accessToken, user },
) => ({
  when: actions([
    Requesting.request,
    { path: "/auth/_getUser", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Map accessToken to session (Session type is the access token string)
    frames = await frames.query(Sessioning._getUser, {
      session: accessToken,
    }, { user });
    return frames.filter(($) => $[user] !== undefined);
  },
  then: actions([Requesting.respond, { request, user }]),
});

export const SessionValidationError: Sync = (
  { request, accessToken, error },
) => ({
  when: actions([
    Requesting.request,
    { path: "/auth/_getUser", accessToken },
    { request },
  ]),
  where: async (frames) => {
    // Map accessToken to session (Session type is the access token string)
    frames = await frames.query(Sessioning._getUser, {
      session: accessToken,
    }, { error });
    return frames.filter(($) => $[error] !== undefined);
  },
  then: actions([Requesting.respond, { request, error, statusCode: 401 }]),
});
