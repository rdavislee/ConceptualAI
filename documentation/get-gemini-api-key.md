# Get a Gemini API Key

This key is required for pipeline-triggering generation actions.

Back to main docs: [ConceptualAI User Documentation](./README.md)

## Official links

- API key page: https://aistudio.google.com/app/apikey
- API key docs: https://ai.google.dev/gemini-api/docs/api-key
- Gemini quickstart: https://ai.google.dev/gemini-api/docs/quickstart

## Steps

1. Sign in to Google AI Studio.
2. Open the API key page.
3. Create or copy an API key.
4. Store it securely (do not commit it to git).

## Which tier should you use?

ConceptualAI requires a non-free tier value in requests:

- Allowed: `1`, `2`, `3`
- Rejected: `0`

If your UI asks for a Gemini tier, pick a non-zero tier.

## Safety tips

- Never paste your key into public chat/screenshots.
- Never commit keys to `.env.template` or source files.
- Rotate your key if you think it was exposed.

## Next steps

- Continue with: [Get a MongoDB Atlas Connection URL (Free Tier)](./get-mongodb-atlas-url.md)
- Then: [Beginner App-Building Guide](./getting-started-beginner.md)
