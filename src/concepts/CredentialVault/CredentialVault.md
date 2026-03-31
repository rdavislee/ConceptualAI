### Concept: CredentialVault [User]

**purpose**
Store one credential vault per user with shared KDF metadata and a set of provider-scoped encrypted secrets, while exposing only redacted status metadata and resolving plaintext credentials only for internal flows that are allowed to use them.

**principle**
Each user has one vault-level KDF/encryption configuration. The frontend derives one unwrap key from the user's password and vault metadata, then reuses that derived key across provider secrets in the vault. Credential writes verify `accountPassword`; credential reads and runtime resolution use the derived unwrap key.

**state (SSF)**

```text
a set of Users with
  an ID
  a kdfSalt String
  a kdfParams Object
  an encryptionVersion String
  a createdAt DateTime
  an updatedAt DateTime
  a set of Credentials with
    a provider String
    a ciphertext String
    an iv String
    a redactedMetadata Object
    an optional externalAccountId String
    a createdAt DateTime
    an updatedAt DateTime
    an optional lastVerifiedAt DateTime
```

**actions**

* **storeCredential(user: User, provider: String, ciphertext: String, iv: String, redactedMetadata: Object, externalAccountId?: String, kdfSalt?: String, kdfParams?: Object, encryptionVersion?: String) : (ok: Flag) | (error: String)**
  requires: wrapped credential fields are present; a first credential also supplies valid KDF metadata
  effects: creates or replaces the provider-scoped credential inside the user's vault
* **deleteCredential(user: User, provider: String) : (ok: Flag)**
  requires: true
  effects: removes the provider-scoped credential; deletes the whole vault if no credentials remain
* **deleteByUser(user: User) : (ok: Flag)**
  requires: true
  effects: deletes the entire credential vault for the user
* **verifyGeminiCredential(apiKey: String, geminiTier: String) : (ok: Flag) | (error: String, statusCode: Number)**
  requires: a non-empty Gemini API key and a supported paid tier
  effects: checks the Gemini key and tier against the provider and returns whether the key is valid for paid-tier sandbox use
* **refreshGithubCredential(user: User, provider: String, unwrapKey: String) : (ok: Flag) | (error: String)**
  requires: a stored GitHub credential exists and includes a refresh token
  effects: refreshes the stored GitHub user token and re-encrypts the updated payload in the user's vault

**queries**

* **_hasCredential(user: User, provider: String) : (hasCredential: Flag)**
  returns a provider-specific flag such as `hasGeminiCredential` or `hasGithubCredential`
* **_getStatus(user: User, provider: String) : (redactedStatus: Object, kdfSalt: String, kdfParams: Object, encryptionVersion: String)**
  returns provider-specific redacted metadata plus the shared vault KDF metadata; if no credential exists, returns the provider-specific `has*Credential: false` shape
* **_resolveCredential(user: User, provider: String, unwrapKey: String) : (resolvedCredential: Object) | (error: String, statusCode: Number)**
  returns provider-specific plaintext credential data only when the unwrap key successfully decrypts the stored credential
* **_getLinkedUser(provider: String, externalAccountId: String) : (user: User)**
  returns the ConceptualAI user linked to the given external account for that provider

---
