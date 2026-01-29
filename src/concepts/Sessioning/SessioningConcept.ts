// Concept: Sessioning
import { Collection, Db } from "npm:mongodb";
import { signJWT, verifyJWT } from "npm:djwt";
import { freshID } from "@utils/database.ts";
import { Empty, ID } from "@utils/types.ts";
import "jsr:@std/dotenv/load";

// Define generic types for the concept
type User = ID;
type Session = string; // JWT access token string

// ============================================================================
// Constants
// ============================================================================

const JWT_ACCESS_EXPIRATION_MINUTES = 15;
const JWT_REFRESH_EXPIRATION_DAYS = 7;
const JWT_ISSUER = "concepthub";
const JWT_ALGORITHM = "HS256" as const;
const JTI_PREFIX_ACCESS = "acc_";
const JTI_PREFIX_REFRESH = "ref_";

// ============================================================================
// JWT Secret Configuration
// ============================================================================

const JWT_SECRET_ENV = Deno.env.get("JWT_SECRET");
if (!JWT_SECRET_ENV || JWT_SECRET_ENV.length < 32) {
  // Use a default for testing if not set, but warn
  if (!JWT_SECRET_ENV) {
      console.warn("WARNING: JWT_SECRET not set, using insecure default for testing only.");
  }
}
const JWT_SECRET: string = JWT_SECRET_ENV || "insecure_default_secret_for_testing_only_must_be_32_chars";

// ============================================================================
// JWT Signer/Verifier Utilities
// ============================================================================

/**
 * Creates an HMAC-SHA256 key from a string secret for JWT signing/verification.
 * The key is cached to avoid recreating it on every operation.
 */
let cachedHmacKey: CryptoKey | null = null;

async function getHmacKey(): Promise<CryptoKey> {
  if (cachedHmacKey) {
    return cachedHmacKey;
  }
  const encoder = new TextEncoder();
  const keyData = encoder.encode(JWT_SECRET);
  cachedHmacKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  return cachedHmacKey;
}

/**
 * Creates a signer function for djwt.
 * The signer receives the base64url-encoded header.payload string and returns
 * the signature as a hex string.
 */
async function createSigner() {
  const key = await getHmacKey();
  return async (payload: string): Promise<string> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(payload);
    const signature = await crypto.subtle.sign("HMAC", key, data);
    // Convert signature to hex string (djwt expects hex format)
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
}

/**
 * Creates a verifier function for djwt.
 * The verifier receives the base64url-encoded header.payload string and
 * the signature (with optional "0x" prefix), and returns a boolean.
 */
async function createVerifier() {
  const key = await getHmacKey();
  return async (payload: string, signature: string): Promise<boolean> => {
    const encoder = new TextEncoder();
    const data = encoder.encode(payload);
    // Strip "0x" prefix if present (djwt may pass signatures with this prefix)
    const hexSig = signature.startsWith("0x") ? signature.slice(2) : signature;
    const sigBytes = new Uint8Array(
      hexSig.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );
    return await crypto.subtle.verify("HMAC", key, sigBytes, data);
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Converts a Date to Unix timestamp (seconds since epoch).
 */
function getNumericDate(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Extracts the actual JTI from a prefixed JTI string.
 * @param prefixedJti - JTI with prefix (e.g., "acc_123" or "ref_456")
 * @returns The actual JTI without prefix
 */
function extractJti(prefixedJti: string): string {
  if (prefixedJti.startsWith(JTI_PREFIX_ACCESS)) {
    return prefixedJti.slice(JTI_PREFIX_ACCESS.length);
  }
  if (prefixedJti.startsWith(JTI_PREFIX_REFRESH)) {
    return prefixedJti.slice(JTI_PREFIX_REFRESH.length);
  }
  return prefixedJti; // Fallback for backward compatibility
}

/**
 * Checks if a JTI belongs to an access token.
 */
function isAccessTokenJti(jti: string): boolean {
  return jti.startsWith(JTI_PREFIX_ACCESS);
}

/**
 * Checks if a JTI belongs to a refresh token.
 */
function isRefreshTokenJti(jti: string): boolean {
  return jti.startsWith(JTI_PREFIX_REFRESH);
}

// Define the shape of the document in the 'sessions' collection
/**
 * a set of Sessions with
 *   a refreshTokenJti String (unique, JWT ID of refresh token)
 *   a user User
 *   an accessTokenJti String (JWT ID of associated access token)
 *   a status String ("active" or "revoked")
 *   a createdAt DateTime
 *   an expiresAt DateTime
 *   an optional revokedAt DateTime
 */
interface SessionDoc {
  _id: string; // jti (JWT ID) of refresh token
  user: User;
  accessTokenJti: string; // jti of associated access token
  status: "active" | "revoked";
  createdAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
}

// JWT payload types
// Note: Token type is encoded in jti prefix ("acc_" or "ref_")
interface AccessTokenPayload {
  sub: string; // User ID
  iat: number;
  exp: number;
  jti: string; // Format: "acc_{actualJti}"
  iss: string; // Required by djwt
  nonce: number; // Required by djwt
}

interface RefreshTokenPayload {
  sub: string; // User ID
  iat: number;
  exp: number;
  jti: string; // Format: "ref_{actualJti}"
  iss: string; // Required by djwt
  nonce: number; // Required by djwt
}

const PREFIX = "Sessioning" + ".";

/**
 * @concept Sessioning
 * @purpose To maintain a user's logged-in state across multiple requests without re-sending credentials using JWT (JSON Web Token) access and refresh tokens.
 */
export default class SessioningConcept {
  public readonly sessions: Collection<SessionDoc>;

  constructor(private readonly db: Db) {
    this.sessions = this.db.collection<SessionDoc>(PREFIX + "sessions");
    // Note: Indexes can be created manually if needed for performance
    // MongoDB will create them automatically on first use, or they can be added via migration
  }

  /**
   * create (user: User): (accessToken: String, refreshToken: String)
   *
   * **requires**: true.
   *
   * **effects**: generates a short-lived access JWT token and a long-lived refresh JWT token; creates a new Session `s` with status="active" storing the refresh token's `jti` and associated access token's `jti`; associates the session with the given `user`; returns both tokens.
   */
  async create({ user }: { user: User }): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const now = new Date();
    const accessJti = freshID();
    const refreshJti = freshID();

    // Calculate expiration times
    const accessExpirationMs = JWT_ACCESS_EXPIRATION_MINUTES * 60 * 1000;
    const refreshExpirationMs = JWT_REFRESH_EXPIRATION_DAYS * 24 * 60 * 60 *
      1000;

    const iat = getNumericDate(now);
    const accessExp = getNumericDate(
      new Date(now.getTime() + accessExpirationMs),
    );
    const refreshExp = getNumericDate(
      new Date(now.getTime() + refreshExpirationMs),
    );

    // Create access token payload
    // Note: djwt requires 'iss' and 'nonce' fields
    // Token type is encoded in jti prefix for easy identification
    const accessPayload = {
      sub: user,
      iat,
      exp: accessExp,
      jti: `${JTI_PREFIX_ACCESS}${accessJti}`,
      iss: JWT_ISSUER,
      nonce: iat, // Use iat as nonce (required by djwt, must be number)
    };

    // Create refresh token payload
    const refreshPayload = {
      sub: user,
      iat,
      exp: refreshExp,
      jti: `${JTI_PREFIX_REFRESH}${refreshJti}`,
      iss: JWT_ISSUER,
      nonce: iat, // Use iat as nonce (required by djwt, must be number)
    };

    // Generate JWT tokens
    const signer = await createSigner();
    const accessToken = await signJWT(accessPayload, signer, {
      algorithm: JWT_ALGORITHM,
    });
    const refreshToken = await signJWT(refreshPayload, signer, {
      algorithm: JWT_ALGORITHM,
    });

    // Store session in database (use actual jti without prefix)
    const sessionDoc: SessionDoc = {
      _id: refreshJti, // Store without prefix
      user,
      accessTokenJti: accessJti, // Store without prefix
      status: "active",
      createdAt: now,
      expiresAt: new Date(now.getTime() + refreshExpirationMs),
    };

    await this.sessions.insertOne(sessionDoc);

    return { accessToken, refreshToken };
  }

  /**
   * refresh (refreshToken: String): (accessToken: String, refreshToken: String) | (error: String)
   *
   * **requires**: the refresh token is valid (signature valid, not expired, type="refresh"), and a Session exists with the refresh token's `jti` and status="active".
   * **effects**: marks the old session as status="revoked"; generates a new access token and refresh token pair; creates a new Session with status="active" for the new tokens; returns the new token pair.
   *
   * **requires**: the refresh token is invalid, expired, or the associated session does not exist or is revoked.
   * **effects**: returns an error message.
   */
  async refresh({ refreshToken }: { refreshToken: string }): Promise<
    {
      accessToken: string;
      refreshToken: string;
    } | { error: string }
  > {
    try {
      const verifier = await createVerifier();
      const payload = await verifyJWT(refreshToken, verifier, {
        algorithm: JWT_ALGORITHM,
      }) as RefreshTokenPayload;

      // Validate token type
      if (!isRefreshTokenJti(payload.jti)) {
        return { error: "Invalid token type" };
      }

      const actualJti = extractJti(payload.jti);

      // Find session by refresh token jti (remove prefix)
      const session = await this.sessions.findOne({
        _id: actualJti,
        status: "active",
      });

      if (!session) {
        return { error: "Refresh token not found or revoked" };
      }

      // Mark old session as revoked
      await this.sessions.updateOne(
        { _id: session._id },
        {
          $set: {
            status: "revoked",
            revokedAt: new Date(),
          },
        },
      );

      // Create new token pair (same as create)
      return await this.create({ user: session.user });
    } catch (error) {
      // Handle JWT verification errors (expired, invalid signature, etc.)
      if (error instanceof Error) {
        if (error.message.includes("expired")) {
          return { error: "Refresh token expired" };
        }
        if (error.message.includes("signature")) {
          return { error: "Invalid token signature" };
        }
      }
      return { error: "Invalid refresh token" };
    }
  }

  /**
   * delete (session: Session | refreshToken: String): () | (error: String)
   *
   * **requires**: the given `session` (access token) exists and is valid.
   * **effects**: finds the associated Session by the access token's `jti`; marks the session as status="revoked" and sets `revokedAt`.
   *
   * **requires**: the given `refreshToken` is valid and a Session exists with the refresh token's `jti`.
   * **effects**: marks the session as status="revoked" and sets `revokedAt`.
   *
   * **requires**: the given `session` does not exist or is invalid.
   * **effects**: returns an error message.
   */
  async delete({ session, refreshToken }: {
    session?: Session;
    refreshToken?: string;
  }): Promise<Empty | { error: string }> {
    const token = session || refreshToken;
    if (!token) {
      return { error: "Either session or refreshToken must be provided" };
    }

    try {
      const verifier = await createVerifier();
      const payload = (await verifyJWT(token, verifier, {
        algorithm: JWT_ALGORITHM,
      })) as AccessTokenPayload | RefreshTokenPayload;

      // Determine token type and find session
      let sessionDoc: SessionDoc | null = null;
      const actualJti = extractJti(payload.jti);

      if (isAccessTokenJti(payload.jti)) {
        sessionDoc = await this.sessions.findOne({
          accessTokenJti: actualJti,
        });
      } else if (isRefreshTokenJti(payload.jti)) {
        sessionDoc = await this.sessions.findOne({ _id: actualJti });
      } else {
        return { error: "Invalid token type" };
      }

      if (!sessionDoc) {
        return { error: "Session not found" };
      }

      // Mark session as revoked
      await this.sessions.updateOne(
        { _id: sessionDoc._id },
        {
          $set: {
            status: "revoked",
            revokedAt: new Date(),
          },
        },
      );

      return {};
    } catch (error) {
      if (error instanceof Error && error.message.includes("expired")) {
        return { error: "Token expired" };
      }
      return { error: "Invalid token" };
    }
  }

  /**
   * _getUser (session: Session): (user: User) | (error: String)
   *
   * **requires**: the `session` (access token) is valid (signature valid, not expired, type="access"), and a Session exists with the access token's `jti` and status="active".
   * **effects**: validates the access token, finds the associated Session, and returns the user associated with the session.
   *
   * **requires**: the access token is invalid, expired, or the associated session does not exist or is revoked.
   * **effects**: returns an error message.
   */
  async _getUser({ session }: { session: Session }): Promise<
    Array<{ user: User }> | [{ error: string }]
  > {
    try {
      const verifier = await createVerifier();
      const payload = await verifyJWT(session, verifier, {
        algorithm: JWT_ALGORITHM,
      }) as AccessTokenPayload;

      // Validate token type
      if (!isAccessTokenJti(payload.jti)) {
        return [{ error: "Invalid token type" }];
      }

      const actualJti = extractJti(payload.jti);

      // Find session by access token jti and check status
      const sessionDoc = await this.sessions.findOne({
        accessTokenJti: actualJti,
        status: "active",
      });

      if (!sessionDoc) {
        return [{ error: "Session not found or revoked" }];
      }

      return [{ user: sessionDoc.user }];
    } catch (error) {
      if (error instanceof Error && error.message.includes("expired")) {
        return [{ error: "Access token expired" }];
      }
      if (error instanceof Error && error.message.includes("signature")) {
        return [{ error: "Invalid token signature" }];
      }
      return [{ error: "Invalid access token" }];
    }
  }

  /**
   * _validateRefreshToken (refreshToken: String): (user: User) | (error: String)
   *
   * **requires**: the refresh token is valid (signature valid, not expired, type="refresh"), and a Session exists with the refresh token's `jti` and status="active".
   * **effects**: validates the refresh token, finds the associated Session, and returns the user associated with the session.
   *
   * **requires**: the refresh token is invalid, expired, or the associated session does not exist or is revoked.
   * **effects**: returns an error message.
   */
  async _validateRefreshToken({ refreshToken }: {
    refreshToken: string;
  }): Promise<Array<{ user: User }> | [{ error: string }]> {
    try {
      const verifier = await createVerifier();
      const payload = await verifyJWT(refreshToken, verifier, {
        algorithm: JWT_ALGORITHM,
      }) as RefreshTokenPayload;

      // Validate token type
      if (!isRefreshTokenJti(payload.jti)) {
        return [{ error: "Invalid token type" }];
      }

      const actualJti = extractJti(payload.jti);

      // Find session by refresh token jti and check status
      const sessionDoc = await this.sessions.findOne({
        _id: actualJti,
        status: "active",
      });

      if (!sessionDoc) {
        return [{ error: "Refresh token not found or revoked" }];
      }

      return [{ user: sessionDoc.user }];
    } catch (error) {
      if (error instanceof Error && error.message.includes("expired")) {
        return [{ error: "Refresh token expired" }];
      }
      if (error instanceof Error && error.message.includes("signature")) {
        return [{ error: "Invalid token signature" }];
      }
      return [{ error: "Invalid refresh token" }];
    }
  }
}
