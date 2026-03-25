### Concept: GeminiCredentialVault [User]

**purpose**
Store a user's Gemini API credential in encrypted form, expose the KDF metadata needed by the frontend, verify Gemini key/tier validity, and resolve plaintext Gemini credentials in memory for sandbox-spawning request flows.

**principle**
A user can save or replace a wrapped Gemini credential tied to their account, query whether one exists, fetch the metadata needed to derive an unwrap key, and delete the stored credential. Sandbox-spawning request flows can resolve the plaintext Gemini key only when the caller supplies a valid unwrap key.

**state (SSF)**

```
a set of Users with
  an ID
  a ciphertext String
  an iv String
  a kdfSalt String
  a kdfParams Object
  an encryptionVersion String
  a geminiTier String
  a createdAt DateTime
  an updatedAt DateTime
  an optional lastVerifiedAt DateTime
```

**actions**

* **storeCredential(user: User, ciphertext: String, iv: String, kdfSalt: String, kdfParams: Object, encryptionVersion: String, geminiTier: String) : (ok: Flag) | (error: String)**
  requires: the wrapped Gemini credential fields are present and the tier is one of `1`, `2`, or `3`
  effects: creates or replaces the stored wrapped Gemini credential for the user
* **deleteCredential(user: User) : (ok: Flag)**
  requires: true
  effects: deletes any stored Gemini credential for the user
* **verifyGeminiCredential(apiKey: String, geminiTier: String) : (ok: Flag) | (error: String, statusCode: Number)**
  requires: a non-empty Gemini API key and a supported paid tier
  effects: checks the Gemini key and tier against the provider and returns whether the key is valid for paid-tier sandbox use

**queries**

* **_hasCredential(user: User) : (hasGeminiCredential: Flag)**
* **_getStatus(user: User) : (hasGeminiCredential: Flag, kdfSalt: String, kdfParams: Object, encryptionVersion: String, geminiTier: String)**
  if no stored credential exists, returns `(hasGeminiCredential: false)`
* **_resolveCredential(user: User, unwrapKey: String) : (geminiKey: String, geminiTier: String) | (error: String)**
  returns the plaintext Gemini key and stored tier only when the unwrap key successfully decrypts the stored credential

---
