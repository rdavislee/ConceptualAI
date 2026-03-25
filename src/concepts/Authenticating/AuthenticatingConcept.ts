import { Collection, Db } from "npm:mongodb";
import { ID } from "@utils/types.ts";
import { freshID } from "@utils/database.ts";
import { Buffer } from "node:buffer";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_PREFIX = "scrypt";
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function deriveScrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  { n, r, p }: { n: number; r: number; p: number },
): Buffer {
  return scryptSync(password, salt, keyLength, {
    N: n,
    r,
    p,
  }) as Buffer;
}

function secureStringEquals(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
}

async function hashPasswordLegacy(password: string): Promise<string> {
  const data = new TextEncoder().encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface PasswordVerificationResult {
  valid: boolean;
  needsRehash: boolean;
}

// Uses salted scrypt and stores hashes as: scrypt$N$r$p$saltB64$hashB64.
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derivedKey = deriveScrypt(password, salt, SCRYPT_KEYLEN, {
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `${SCRYPT_PREFIX}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${
    salt.toString("base64")
  }$${derivedKey.toString("base64")}`;
}

async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<PasswordVerificationResult> {
  // Backward compatibility for existing SHA-256 hashes.
  if (!storedHash.startsWith(`${SCRYPT_PREFIX}$`)) {
    const legacyHash = await hashPasswordLegacy(password);
    const valid = secureStringEquals(legacyHash, storedHash);
    return { valid, needsRehash: valid };
  }

  const parts = storedHash.split("$");
  if (parts.length !== 6) {
    return { valid: false, needsRehash: false };
  }

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((value) => Number.isFinite(value) && value > 0)) {
    return { valid: false, needsRehash: false };
  }

  let salt: Buffer;
  let expectedHash: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expectedHash = Buffer.from(parts[5], "base64");
  } catch {
    return { valid: false, needsRehash: false };
  }

  if (salt.length === 0 || expectedHash.length === 0) {
    return { valid: false, needsRehash: false };
  }

  const derivedKey = deriveScrypt(password, salt, expectedHash.length, {
    n,
    r,
    p,
  });

  if (derivedKey.length !== expectedHash.length) {
    return { valid: false, needsRehash: false };
  }
  return {
    valid: timingSafeEqual(derivedKey, expectedHash),
    needsRehash: false,
  };
}

// Collection prefix for this concept
const PREFIX = "Authenticating" + ".";

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
 * @concept Authenticating
 * @purpose To securely verify a user's identity based on credentials.
 */
export default class AuthenticatingConcept {
  users: Collection<UserDoc>;
  private indexesCreated = false;

  constructor(private readonly db: Db) {
    this.users = this.db.collection(PREFIX + "users");
  }

  private async ensureIndexes(): Promise<void> {
    if (this.indexesCreated) return;
    // Ensure email is unique at the database level.
    await this.users.createIndex({ email: 1 }, { unique: true });
    this.indexesCreated = true;
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
    await this.ensureIndexes();
    try {
      const passwordHash = await hashPassword(password);
      const newUser: UserDoc = {
        _id: freshID(),
        email,
        passwordHash,
      };

      await this.users.insertOne(newUser);
      return { user: newUser._id };
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && e.code === 11000) {
        return { error: "Email already exists" };
      }
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

    const passwordCheck = await verifyPassword(password, user.passwordHash);
    if (!passwordCheck.valid) {
      return { error: "Invalid email or password" };
    }

    // Opportunistically migrate legacy SHA-256 hashes on successful login.
    if (passwordCheck.needsRehash) {
      const upgradedHash = await hashPassword(password);
      await this.users.updateOne(
        { _id: user._id, passwordHash: user.passwordHash },
        { $set: { passwordHash: upgradedHash } },
      );
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

  /**
   * _verifyPasswordByUser (user: User, password: String): (ok: Flag) | (error: String)
   *
   * **requires**: a User exists with the given `user` ID and the password
   * matches their `passwordHash`.
   * **effects**: returns `ok: true`.
   *
   * **requires**: no User exists with the given `user` ID or the password does
   * not match.
   * **effects**: returns an error message.
   */
  async _verifyPasswordByUser(
    { user, password }: { user: User; password: string },
  ): Promise<Array<{ ok: true }> | [{ error: string }]> {
    const auth = await this.users.findOne({ _id: user });
    if (!auth) {
      return [{ error: "Invalid email or password" }];
    }

    const passwordCheck = await verifyPassword(password, auth.passwordHash);
    if (!passwordCheck.valid) {
      return [{ error: "Invalid email or password" }];
    }

    return [{ ok: true }];
  }

  /**
   * resetPassword (email: String, oldPassword: String, newPassword: String): (ok: Flag) | (error: String)
   *
   * **requires**: a User exists with the given `email` and `oldPassword` matches their `passwordHash`.
   * **effects**: updates the User's `passwordHash` with a hash of the `newPassword`.
   *
   * **requires**: no User exists with the given `email` or the `oldPassword` does not match.
   * **effects**: returns an error message.
   */
  async resetPassword(
    {
      email,
      oldPassword,
      newPassword,
    }: { email: string; oldPassword: string; newPassword: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const user = await this.users.findOne({ email });
    if (!user) {
      return { error: "Invalid email or password" };
    }

    const oldPasswordCheck = await verifyPassword(oldPassword, user.passwordHash);
    if (!oldPasswordCheck.valid) {
      return { error: "Invalid email or password" };
    }

    const newPasswordHash = await hashPassword(newPassword);
    await this.users.updateOne(
      { email },
      { $set: { passwordHash: newPasswordHash } },
    );

    return { ok: true };
  }

  /**
   * deleteAuthentication (email: String): (ok: Flag) | (error: String)
   *
   * **requires**: a User exists with the given `email`.
   * **effects**: deletes the matching User authentication record.
   *
   * **requires**: no User exists with the given `email`.
   * **effects**: returns an error message.
   */
  async deleteAuthentication(
    { email }: { email: string },
  ): Promise<{ ok: boolean } | { error: string }> {
    const user = await this.users.findOne({ email });
    if (!user) {
      return { error: "User not found" };
    }

    await this.users.deleteOne({ _id: user._id });
    return { ok: true };
  }

  /**
   * deleteAuthenticationByUser (user: User): (ok: Flag) | (error: String)
   *
   * **requires**: a User exists with the given `user` ID.
   * **effects**: deletes the matching User authentication record. Use for account deletion flows that only have user ID.
   *
   * **requires**: no User exists with the given `user` ID.
   * **effects**: returns an error message.
   */
  async deleteAuthenticationByUser(
    { user }: { user: User },
  ): Promise<{ ok: boolean } | { error: string }> {
    const res = await this.users.deleteOne({ _id: user });
    if (res.deletedCount === 0) {
      return { error: "User not found" };
    }
    return { ok: true };
  }
}
