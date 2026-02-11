### Concept: Following [Follower, Followed]

**purpose**
Maintain a directed social graph where users (followers) can subscribe to updates or signals from other users (followed).

**principle**
A user can follow another user once; following is asymmetric.

**state (SSF)**

```
a set of Followed with
  a user ID
  a set of Followers with
    a user ID
    a DateTime

a set of Followers with
  a user ID
  a set of Following with
    a user ID
    a DateTime
```

**actions**

* **follow (follower: userID, followed: userID) : (ok: Flag)**
  requires: follower != followed, no following exists for (follower, followed)
  effects: create relationship with at := now and adds to both sets
* **unfollow (follower: userID, followed: userID) : (ok: Flag)**
  requires: following exists for (follower, followed)
  effects: delete that relationship from both sets

* **deleteByFollower (follower: userID) : (ok: Flag)**
  requires: true
  effects: removes all following relationships where the user is the follower (lifecycle cleanup)

* **deleteByFollowed (followed: userID) : (ok: Flag)**
  requires: true
  effects: removes all following relationships where the user is the followed (lifecycle cleanup)

**queries**
`_isFollowing(follower: userID, followed: userID) : (following: Flag)`
`_followers(followed: userID) : (users: Set<userID>)`
`_following(follower: userID) : (users: Set<userID>)`

---
