import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";

// A simple helper function to hash passwords using the Web Crypto API.
// In a production system, a more robust, salted hashing algorithm like Argon2 or bcrypt would be preferred.
async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Collection prefix for this concept
const PREFIX = "UserAuthenticating" + ".";

// Generic types of this concept
type User = ID;

/**
 * Represents the state of a single user in the database.
 * a set of `User`s with
 *   an `email` String (unique)
 *   a `passwordHash` String
 */
interface UserDoc {
  _id: User;
  email: string;
  passwordHash: string;
}

/**
 * @concept UserAuthenticating
 * @purpose To securely verify a user's identity based on credentials.
 */
export default class UserAuthenticationConcept {
  users: Collection<UserDoc>;

  constructor(private readonly db: Db) {
    this.users = this.db.collection(PREFIX + "users");
    // Ensure email is unique at the database level
    this.users.createIndex({ email: 1 }, { unique: true });
  }

  /**
   * register (email: String, password: String): (user: User) | (error: String)
   *
   * **requires**: no User exists with the given `email`.
   * **effects**: creates a new User `u`; sets their `email` and a hash of their `password`; returns `u` as `user`.
   *
   * **requires**: a User already exists with the given `email`.
   * **effects**: returns an error message.
   */
  async register(
    { email, password }: { email: string; password: string },
  ): Promise<{ user: User } | { error: string }> {
    // Check if a user with this email already exists.
    // We also rely on the unique index in MongoDB, but this provides a cleaner error message.
    try {
      const existingUser = await this.users.findOne({ email });
      if (existingUser) {
        return { error: "Email already exists" };
      }

      const passwordHash = await hashPassword(password);
      const newUser: UserDoc = {
        _id: freshID(),
        email,
        passwordHash,
      };

      await this.users.insertOne(newUser);
      return { user: newUser._id };
    } catch (e: any) {
      // Catch potential duplicate key error from the database index
      if (e.code === 11000) {
        return { error: "Email already exists" };
      }
      // For other unexpected errors, re-throw or handle appropriately
      throw e;
    }
  }

  /**
   * login (email: String, password: String): (user: User) | (error: String)
   *
   * **requires**: a User exists with the given `email` and the `password` matches their `passwordHash`.
   * **effects**: returns the matching User `u` as `user`.
   *
   * **requires**: no User exists with the given `email` or the `password` does not match.
   * **effects**: returns an error message.
   */
  async login(
    { email, password }: { email: string; password: string },
  ): Promise<{ user: User } | { error: string }> {
    const user = await this.users.findOne({ email });

    // To prevent timing attacks and email enumeration, use a generic error message.
    if (!user) {
      return { error: "Invalid email or password" };
    }

    const providedPasswordHash = await hashPassword(password);
    if (user.passwordHash !== providedPasswordHash) {
      return { error: "Invalid email or password" };
    }

    return { user: user._id };
  }

  /**
   * _getUserByEmail (email: String): (user: User)
   *
   * **requires**: a User with the given `email` exists.
   * **effects**: returns the corresponding User.
   */
  async _getUserByEmail(
    { email }: { email: string },
  ): Promise<{ user: User }[]> {
    const user = await this.users.findOne({ email });
    if (user) {
      return [{ user: user._id }];
    }
    // As per specification, queries must return an array.
    return [];
  }
}
