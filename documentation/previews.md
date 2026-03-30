# Previews

Previews let you open a temporary hosted version of your generated app directly from the website.

They are meant for quick testing. Instead of downloading code and running it yourself, you can launch a preview and open it in the browser.

## What You Get

When a preview is ready, the website gives you a live link to your app.

That hosted preview includes:

- A frontend you can click through like a normal website
- A backend running behind it so the app behaves like a real deployment

## How Previews Are Hosted

Previews are created from the latest successful build of your project.

That means:

- You need to build the project first
- Starting a preview does not regenerate your app
- The preview is based on the most recent build artifacts already created for your project

Each preview is temporary. It is hosted for testing, not as a permanent production deployment.

## Why Use a Preview

Previews are useful when you want to:

- Quickly check how your app looks and feels
- Click through the generated flows in a real browser
- Share a temporary hosted version during review
- Validate the latest build before downloading code

## What to Expect When You Launch One

When you start a preview from the website:

1. The system prepares a hosted copy of your latest built app.
2. The website shows that preview startup is in progress.
3. When hosting is ready, the preview link appears.
4. You can open the live preview in your browser.

Starting a preview may take a little time. The website should show a loading state until the preview is ready.

## What to Expect When You Stop One

When you stop a preview, it does not disappear instantly.

The website first shows that the preview is stopping, then finishes cleanup in the background. Once that cleanup is done, the preview is fully stopped.

This is why you may briefly see a loading or disabled stop button before the preview disappears completely.

## Important Limits

- Previews only work after a successful build
- Previews are temporary and can expire
- There may be a limit on how many active previews one user can have at once
- Starting a new preview for the same project can replace the older one

## When a Preview Stops Automatically

The website may stop a preview for you if the project changes in a way that would make the old hosted version outdated.

For example, this can happen when you:

- Build the project again
- Reassemble the project
- Revert the project to an earlier stage
- Delete the project

This keeps previews aligned with the latest valid version of the project.

## If a Preview Does Not Start

The most common reason is that the project has not been built yet.

Other cases include:

- The latest build is incomplete
- Preview hosting is temporarily unavailable
- Your active preview limit has been reached

If that happens, finish the build first or try again later.

## Previews vs Local Running

Previews are the fastest way to test your app from the website.

If you want full control over the code, environment files, and runtime, use the downloaded project and run it locally instead. See [Run Generated App Locally](./run-generated-app-locally.md).
