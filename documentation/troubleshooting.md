# Troubleshooting

Back to docs home: [ConceptualAI User Documentation](./README.md)

## Build is slow or seems stuck

What is normal:

- Frontend generation can often take **15 to 30 minutes**
- Implementation can be **instant** when there are no custom concepts
- Sync generation can take up to **60 minutes**
- Large apps can take longer than small apps
- Any single sandboxed generation phase has a hard max of **2 hours**

What to do:

- Wait a little longer
- If a single phase passes 2 hours, treat it as broken and restart/resume that phase
- Avoid launching many parallel runs for the same project
- Retry with a simpler initial scope if needed

What happens to your project state:

- Completed outputs from earlier phases are persisted.
- A timeout/failure should not erase your whole project.
- Resume from the last completed phase instead of starting over unless data is clearly corrupted.

## Plan is missing features

- Use the **Modify Plan** action with specific feedback
- Name exact features and user roles you need
- Repeat until plan quality is acceptable

See also: [Beginner App-Building Guide](./getting-started-beginner.md)

## Gemini errors

Checks:

- Is your API key valid?
- Did you provide an allowed tier (`1`, `2`, or `3`)?
- Is your provider quota/rate limit exhausted?

Guide: [Get a Gemini API Key](./get-gemini-api-key.md)

## Database connection errors

Checks:

- `MONGODB_URL` uses the full Atlas connection string
- Username/password placeholders were replaced
- Atlas IP allowlist includes your runtime IP
- `DB_NAME` is set in backend `.env`

Guide: [Get a MongoDB Atlas Connection URL (Free Tier)](./get-mongodb-atlas-url.md)

## Auth/session problems

Checks:

- Backend `JWT_SECRET` is set and long enough
- Frontend points to correct backend API URL
- Access token is being sent with requests

## Deployment works locally but not online

Checks:

- Production env vars are set in your host (Railway)
- Frontend API URL points to the deployed backend domain
- Backend CORS/domain settings allow frontend domain

Guide: [Deploy Your Generated App with Railway](./deploy-with-railway.md)

## Troubleshooting a generated project (Advanced)

While troubleshooting a generated project is generally best suited for those with developing experience, this guide is designed to be accessible enough for anyone to follow.

The most effective way to troubleshoot a generated project is as follows:

1. **Setup**: Open both the frontend and backend of the project in separate tabs/windows of an agentic IDE (like Cursor).
2. **Manual Testing**: Run the project locally and manually look for bugs by interacting with the UI—click buttons, test features, and navigate through the app.
3. **Frontend Agent First**: When you encounter a bug, copy any relevant output or errors from the backend terminal and provide it to the LLM agent in your frontend IDE tab. 
   - Tell the agent what the bug is.
   - Ask the agent to fix the issue if it's frontend-related, or to let you know if it suspects the issue is actually in the backend.
4. **Backend Agent Handoff**: If the frontend agent determines it is a backend issue, switch to your backend IDE tab. Give the backend LLM agent the context of the bug and the frontend agent's findings, and ask it to fix the backend code.
5. **Repeat**: This collaborative process between you and the agent(s) generally resolves most issues. Repeat these steps until there are no bugs left in the website.

## Last resort recovery flow

1. Start from a smaller app prompt.
2. Confirm plan quality first.
3. Re-run phases from a clean baseline.
4. Validate local setup before redeploy.
