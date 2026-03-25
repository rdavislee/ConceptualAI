# Gemini Key Security in ConceptualAI

This page explains why it is secure to use your Gemini API key with ConceptualAI and how the app reduces repeated setup friction without lowering the security standard of normal Gemini-key usage.

Back to docs home: [ConceptualAI User Documentation](./README.md)

## Why this is secure

ConceptualAI is designed around two important goals:

- your Gemini API key should not be stored in readable form in the database
- your raw Gemini API key should not need to be sent on every generation request

## What this means for you

In normal use:

- you save your Gemini API key once
- the app keeps a protected stored version of that key
- later generation requests use a temporary unlock value instead of resending the raw Gemini API key each time

This is meant to keep the user experience smoother while maintaining a secure way to use your Gemini credential.

## The protections you get

This design gives you several practical security benefits:

- your Gemini API key is protected when stored
- your Gemini-backed requests continue to use protected credential handling
- sensitive credential material is treated carefully and redacted from request logging paths
- replacing a stored Gemini credential requires extra verification

In plain language:

- if someone gets only the database, they should not get your readable Gemini API key from it
- your Gemini credential is handled in a way that supports normal secure use without making you paste the raw key every time

## How your key is used safely

ConceptualAI is built so that your Gemini API key can be used for generation without needing to live as plain text in storage.

In practice:

- you provide the raw Gemini API key when you first connect or replace it
- your password is used on your side to help lock and unlock the stored Gemini credential
- the app keeps a protected stored version of that key for later use
- later generation requests use a temporary unlock value rather than resending the raw Gemini API key each time

This gives you a strong balance of usability and security:

- secure storage
- smoother day-to-day use
- less repeated credential entry

## Why HTTPS still matters

HTTPS/TLS is still essential.

Even though your Gemini key is protected at rest, sensitive information still travels between your browser and the server during:

- initial Gemini credential save
- Gemini-backed generation requests

Without HTTPS, those requests would not be safe.

## What happens if you refresh or log out

For safety, the app may need you to re-enter your password after a refresh, tab close, or logout so it can unlock your stored Gemini credential again.

That is because your password is part of how the Gemini credential is protected on your side.

That is expected behavior.

In general:

- staying in the same active session should feel seamless
- refreshing the app may require re-unlocking
- logging out should clear the temporary unlock state

## What you should do as a user

- Keep your Gemini API key private.
- Use a strong account password.
- Do not paste keys into screenshots, chats, or source code.
- Rotate your Gemini API key if you think it was exposed.
- Reconnect or re-save your Gemini credential if the app tells you it can no longer use it.

## Summary

ConceptualAI is designed to let you use Gemini-backed features without having to paste your Gemini API key over and over again.

The goal of this system is convenience without lowering the security bar of normal Gemini-key usage.
Your key remains protected in storage, sensitive request material is handled carefully, and the overall flow is designed to stay secure while reducing friction.

## Related guides

- [Get a Gemini API Key](./get-gemini-api-key.md)
- [Troubleshooting](./troubleshooting.md)
