**concept** Accessing [Subject, Target]

**purpose**
Control access permissions for targets, defining who can view, edit, or manage them.

**principle**
A subject is granted a specific role (e.g., viewer, editor, owner) on a target; any subsequent check for that subject's access level returns their assigned role, or none if no access was granted.

**state**
  a set of AccessRules with
    a subject (Subject)
    a target (Target)
    a role String (e.g., "viewer", "editor", "owner")

**actions**

grantAccess (subject: Subject, target: Target, role: String) : (ok: Flag)
  **requires**
    role is one of "viewer", "editor", "owner"
  **effects**
    grants the subject the specified role on the target (replaces any existing role)

revokeAccess (subject: Subject, target: Target) : (ok: Flag)
  **requires**
    access rule exists for subject and target
  **effects**
    removes the access rule for the subject and target

**lifecycle cleanups**

deleteBySubject (subject: Subject) : (ok: Flag)
  **effects** removes all access rules for the subject (e.g. when subject/user is deleted)

deleteByTarget (target: Target) : (ok: Flag)
  **effects** removes all access rules for the target (e.g. when target/item is deleted)

**queries**

_getAccess (subject: Subject, target: Target) : (role: String | null)
  **requires** true
  **effects** returns the role assigned to the subject for the target, or null if none

_hasAccess (subject: Subject, target: Target, requiredRole: String) : (hasAccess: Flag)
  **requires** requiredRole is one of "viewer", "editor", "owner"
  **effects** returns true if the subject's role on the target is equal to or greater than the requiredRole.
    (owner > editor > viewer)
