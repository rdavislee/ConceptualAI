**concept** Joining [Member, Target]

**purpose**
Manage many-to-many associations between members and targets, such as users joining a group or subscribing to a list.

**principle**
If a member joins a target, they are added to the target's membership set; if they later leave, they are removed.

**state**
  a set of Memberships with
    a member (Member)
    a target (Target)
    a joinedAt DateTime

**actions**

join (member: Member, target: Target) : (ok: Flag)
  **requires**
    member is not already a member of target
  **effects**
    adds the member to the membership set for the target with joinedAt := now

leave (member: Member, target: Target) : (ok: Flag)
  **requires**
    member is a member of target
  **effects**
    removes the member from the membership set for the target

deleteByMember (member: Member) : (ok: Flag)
  **requires** true
  **effects** removes all memberships for the member (lifecycle cleanup when member account is deleted)

deleteByTarget (target: Target) : (ok: Flag)
  **requires** true
  **effects** removes all memberships for the target (lifecycle cleanup when target is deleted)

**queries**

_getMembers (target: Target) : (members: Set<Member>)
  **requires** true
  **effects** returns all members who are members of the given target

_getMemberships (member: Member) : (targets: Set<Target>)
  **requires** true
  **effects** returns all targets the member has joined

_isMember (member: Member, target: Target) : (member: Flag)
  **requires** true
  **effects** returns true if the member is a member of the target
