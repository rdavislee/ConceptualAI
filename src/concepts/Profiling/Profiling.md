**concept** Profiling [User]

**purpose**
Allows users to present a public identity and additional information about themselves to others.

**principle**
If a user creates a profile, then it becomes visible to others with their name and bio; the user can later update the contents of their profile or delete it entirely.

**state**
  a set of Profiles with
    a user (User)
    a username String
    a name String
    a bio String
    a bioImageUrl String
    a createdAt DateTime
    an updatedAt DateTime

**actions**

createProfile (user: User, username: String, name: String, bio: String, bioImageUrl: String) : (ok: Flag)
  **requires**
    profile for user does not already exist, username is unique
  **effects**
    create profile for user with username, name, bio, bioImageUrl, createdAt := now, updatedAt := now

updateProfile (user: User, username?: String, name?: String, bio?: String, bioImageUrl?: String) : (ok: Flag)
  **requires**
    profile for user exists, at least one field provided, if username provided it must be unique
  **effects**
    update specified fields and set updatedAt := now

changeUsername (user: User, newUsername: String) : (ok: Flag)
  **requires**
    profile for user exists, newUsername is unique
  **effects**
    set profile's username to newUsername and set updatedAt := now

deleteProfile (user: User) : (ok: Flag)
  **requires**
    profile for user exists
  **effects**
    delete the profile

**queries**

_getProfile (user: User) : (profile: Profile | null)
  **requires** true
  **effects** returns the profile for the given user, or null if none exists

_getProfileByUsername (username: String) : (profile: Profile | null)
  **requires** true
  **effects** returns the profile with the given username, or null if none exists
