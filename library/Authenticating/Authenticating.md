### Concept: Authenticating [User]

**purpose**
Securely verify a user's identity based on credentials (email and password).

**principle**
A user can register with a unique email; they can then login by providing the correct credentials. They can also reset their password or delete their authentication record when needed.

**state (SSF)**

```
a set of Users with
  an ID
  an email String (unique)
  a passwordHash String
```

**actions**

* **register (email: String, password: String) : (user: User) | (error: String)**
  requires: no user exists with the given email
  effects: creates a new user with the given email and a salted scrypt hash of the password; returns the user ID
* **login (email: String, password: String) : (user: User) | (error: String)**
  requires: a user exists with the given email and the password matches the stored hash
  effects: returns the matching user ID
* **resetPassword (email: String, oldPassword: String, newPassword: String) : (ok: Flag) | (error: String)**
  requires: a user exists with the given email and the old password matches the hash
  effects: updates the user's password hash with a salted scrypt hash of the new password
* **deleteAuthentication (email: String) : (ok: Flag) | (error: String)**
  requires: a user exists with the given email
  effects: deletes the user's authentication record
* **deleteAuthenticationByUser (user: User) : (ok: Flag) | (error: String)**
  requires: a user exists with the given user ID
  effects: deletes the user's authentication record (for account deletion flows that only have user ID)

**queries**
`_getUserByEmail(email: String) : (user: User)`

---
