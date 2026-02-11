**concept** Archiving [Target]

**purpose**
Provide a generic way to move items to an "archived" or "inactive" state, allowing them to be hidden from regular views without physical deletion.

**principle**
If a target is archived, then it is marked with an archived status and the time it was archived; if it is later unarchived, the status is removed.

**state**
  a set of ArchivedItems with
    a target (Target)
    an archivedAt DateTime

**actions**

archive (target: Target) : (ok: Flag)
  **requires**
    target is not already archived
  **effects**
    marks the target as archived with archivedAt := now

unarchive (target: Target) : (ok: Flag)
  **requires**
    target is archived
  **effects**
    removes the archived status for the target

**lifecycle cleanups**

deleteByTarget (target: Target) : (ok: Flag)
  **effects** removes the archived record when the target is hard-deleted

**queries**

_isArchived (target: Target) : (archived: Flag)
  **requires** true
  **effects** returns true if the target is currently archived

_allArchived () : (targets: Set<Target>)
  **requires** true
  **effects** returns all currently archived targets, latest first
