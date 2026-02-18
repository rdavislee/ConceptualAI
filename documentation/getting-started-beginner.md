# Beginner App-Building Guide

This guide is for first-time users. It is written to be simple and step-by-step.

If you have never done this before, you can still do it.

## Before You Start

You need:

- A **Gemini API key** (guide: [Get a Gemini API Key](./get-gemini-api-key.md))
- A **MongoDB Atlas URL** (guide: [Get a MongoDB Atlas Connection URL (Free Tier)](./get-mongodb-atlas-url.md))
- A **JWT secret** (you can generate one later)
- About **30 to 90 minutes** for one full run

## Cost Note (Important)

Using AI generation costs money.

- A small/medium app (around 30 endpoints) can be about **$5** in API usage.
- A larger app (around 60 endpoints) can be about **$10**.
- Bigger or more complex apps can cost more.

Treat each run like a real cost decision.

## Step 1: Start with a clear app prompt

Write a simple app idea in plain language.

Good example:

> "Build a school task app where students can add tasks, mark them done, and teachers can post announcements."

Tips:

- Say who the users are.
- Say what they can do.
- Say what should happen when they click things.

## Step 2: Check the Plan carefully

After you submit your app idea, the system creates a **Plan**.

Read it before moving on.

Look for:

- Features you definitely wanted
- Missing features you expected
- Wrong assumptions

If something is wrong, use the **Modify Plan** button and ask for changes.

Example:

> "Please add password reset and add student/teacher roles."

You can repeat this until the plan looks right.

## Step 3: Beginners can skip design details

There is a design phase, but beginners usually do not need to inspect it deeply.

If you are curious, see: [Design Phase (Advanced)](./design-phase-advanced.md)

For now, you can continue through the rest of the phases.

## Step 4: Click through the remaining phases

After your plan is approved, move through the remaining generation steps.

Typical timing (varies by app size and model speed):

- Planning and edits: about **1 to 5 minutes**
- Design generation: about **2 to 10 minutes**
- Implementation: can be **instant** when there are no custom concepts
- Sync generation: can take up to **60 minutes** on complex projects
- Build/frontend generation: often **15 to 30 minutes**

A full run can be quick for small apps or longer for bigger ones.

Important timeout rule:

- Any single sandboxed generation phase has a hard max of **2 hours**.
- If a phase runs longer than 2 hours, treat it as broken and retry/resume.
- Your project should return to the last persisted state (previous completed outputs remain in storage).

## Step 5: Configure environment files in generated projects

When your build finishes, you will have generated backend and frontend projects.

### Backend setup

In the generated **backend** folder:

1. Rename `.env.template` to `.env`
2. Fill in:
   - `MONGODB_URL`
   - `DB_NAME`
   - `JWT_SECRET`

Why these matter:

- `MONGODB_URL`: tells backend where your database server is.
- `DB_NAME`: tells backend which database inside that server to use.
- `JWT_SECRET`: signs login tokens so user sessions are secure.

If you still need values:

- MongoDB URL guide: [Get a MongoDB Atlas Connection URL (Free Tier)](./get-mongodb-atlas-url.md)
- JWT secret tip: use at least 32 random characters

### Frontend setup

In the generated **frontend** folder:

1. Rename `.env.template` to `.env`
2. For local runs, the default values are usually already correct.
3. Change frontend `.env` values only for non-local runs (for example, when deploying to the internet).

## Step 6: Run and test your app

Use: [Run Your Generated App Locally](./run-generated-app-locally.md)

Check:

- Can you register and log in?
- Do core pages load?
- Do your key features actually work?

## Step 7: Share it online (optional)

When local testing works, deploy it so other people can use it.

Guide: [Deploy Your Generated App with Railway](./deploy-with-railway.md)

## Want to learn the deeper ideas?

If you want advanced understanding of how the system composes behavior:

- [Concepts and Syncs (Advanced)](./concepts-and-syncs.md)
- [Design Phase (Advanced)](./design-phase-advanced.md)
- [Troubleshooting](./troubleshooting.md)
