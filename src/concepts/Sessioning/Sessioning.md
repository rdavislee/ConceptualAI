# Concept: Sessioning [User]

**purpose**
To maintain a user's logged-in state across multiple requests without re-sending credentials using JWT (JSON Web Token) access and refresh tokens.

**principle**
After a user is authenticated, a session is created with a pair of JWT tokens: a short-lived access token and a long-lived refresh token. Subsequent requests using the access token are treated as being performed by that user. When the access token expires, the refresh token can be used to obtain a new token pair. Sessions can be revoked (logout), which invalidates both tokens.

**state (SSF)**

```ssf
a set of Sessions with
  a refreshTokenJti String (unique, JWT ID of refresh token)
  a user User
  an accessTokenJti String (JWT ID of associated access token)
  a status String ("active" or "revoked")
  a createdAt DateTime
  an expiresAt DateTime
  an optional revokedAt DateTime
```

**actions**

* **create (user: User): (accessToken: String, refreshToken: String)**
  requires: true.
  effects: generates a short-lived access JWT token and a long-lived refresh JWT token; creates a new Session `s` with status="active" storing the refresh token's `jti` and associated access token's `jti`; associates the session with the given `user`; returns both tokens.

* **refresh (refreshToken: String): (accessToken: String, refreshToken: String)**
  requires: the refresh token is valid (signature valid, not expired, type="refresh"), and a Session exists with the refresh token's `jti` and status="active".
  effects: marks the old session as status="revoked"; generates a new access token and refresh token pair; creates a new Session with status="active" for the new tokens; returns the new token pair.

* **refresh (refreshToken: String): (error: String)**
  requires: the refresh token is invalid, expired, or the associated session does not exist or is revoked.
  effects: returns an error message.

* **delete (session: Session): ()**
  requires: the given `session` (access token) exists and is valid.
  effects: finds the associated Session by the access token's `jti`; marks the session as status="revoked" and sets `revokedAt`.

* **delete (refreshToken: String): ()**
  requires: the given `refreshToken` is valid and a Session exists with the refresh token's `jti`.
  effects: marks the session as status="revoked" and sets `revokedAt`.

* **delete (session: Session): (error: String)**
  requires: the given `session` does not exist or is invalid.
  effects: returns an error message.

**queries**

* **_getUser (session: Session): (user: User)**
  requires: the `session` (access token) is valid (signature valid, not expired, type="access"), and a Session exists with the access token's `jti` and status="active".
  effects: validates the access token, finds the associated Session, and returns the user associated with the session.

* **_getUser (session: Session): (error: String)**
  requires: the access token is invalid, expired, or the associated session does not exist or is revoked.
  effects: returns an error message.

* **_validateRefreshToken (refreshToken: String): (user: User)**
  requires: the refresh token is valid (signature valid, not expired, type="refresh"), and a Session exists with the refresh token's `jti` and status="active".
  effects: validates the refresh token, finds the associated Session, and returns the user associated with the session.

* **_validateRefreshToken (refreshToken: String): (error: String)**
  requires: the refresh token is invalid, expired, or the associated session does not exist or is revoked.
  effects: returns an error message.
