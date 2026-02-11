**concept** Identifying [User]

**purpose**
To assign global permissions levels or job functions to users within the system.

**principle**
A user is assigned a specific role (e.g., "Manager", "Employee"). This role is stored and can be queried to determine the user's capabilities throughout the system. A user can only hold one role at a time (replacing any previous one).

**state**
  a set of Identities with
    a user (User)
    a role String

**actions**

setRole (user: User, role: String) : (ok: Flag)
  **requires**
    role is not empty
  **effects**
    creates or updates the Identity for the user, setting the role to role

removeRole (user: User) : (ok: Flag)
  **requires**
    user has an identity
  **effects**
    removes the Identity for the user

**queries**

_getRole (user: User) : (role: String | null)
  **requires** true
  **effects** returns the role name for the user, or null if none is set

_hasRole (user: User, role: String) : (hasRole: Flag)
  **requires** true
  **effects** returns true if the user's current role exactly matches the specified role
