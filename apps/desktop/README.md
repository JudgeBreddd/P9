# Desktop

Run pnpm desktop from the app root after pnpm build. start.cjs registers the private
scheme before Electron becomes ready; main.mjs serves the built assets with CSP.
The sandboxed renderer receives only the frozen p9.getStatus bridge. Pass --state
with an absolute daemon state directory to enable the status indicator.
