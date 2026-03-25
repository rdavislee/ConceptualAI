# Get a Gemini API Key

This key is required for Gemini-backed generation actions.

Back to main docs: [ConceptualAI User Documentation](./README.md)

Security details: [How Gemini Key Security Works](./gemini-key-security.md)

## Official links

- API key page: https://aistudio.google.com/app/apikey
- API key docs: https://ai.google.dev/gemini-api/docs/api-key
- Gemini quickstart: https://ai.google.dev/gemini-api/docs/quickstart

## Steps

1. Sign in to Google AI Studio.
2. Open the API key page.
3. Create or copy an API key.
4. Store it securely (do not commit it to git).
5. In ConceptualAI, use the app's Gemini credential save flow to store it as a wrapped credential instead of resending it on every generation request.

## Which tier should you use?

ConceptualAI requires a non-free tier value for stored Gemini credentials and Gemini-backed generation:

- Allowed: `1`, `2`, `3`
- Rejected: `0`

If your UI asks for a Gemini tier, pick a non-zero tier.

## How ConceptualAI uses this key

ConceptualAI is designed so that your raw Gemini API key is not sent on every generation request.

What happens instead:

- You provide the raw Gemini API key when you first connect or replace it.
- ConceptualAI keeps a protected stored version of that key for later use.
- Later generation requests do not need to resend the raw Gemini API key every time.

Important transparency note:

- This is designed to keep the key protected in storage while removing the need to paste it again for every Gemini-backed action.
- The goal is a lower-friction experience without lowering the security standard of normal Gemini-key usage.

Read the full explanation here: [How Gemini Key Security Works](./gemini-key-security.md)

## Safety tips

- Never paste your key into public chat/screenshots.
- Never commit keys to `.env.template` or source files.
- Rotate your key if you think it was exposed.
- Use a strong account password, because the frontend derives the unwrap key from your password plus Gemini credential metadata.

## Next steps

- Continue with: [Get a MongoDB Atlas Connection URL (Free Tier)](./get-mongodb-atlas-url.md)
- Then: [Beginner App-Building Guide](./getting-started-beginner.md)
