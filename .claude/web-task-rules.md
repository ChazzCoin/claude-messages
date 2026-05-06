# Web task rules (platform extensions)

> **STATUS: PLACEHOLDER.** Populate from real web-project conventions
> the next time a web project (e.g. `vsi-web`) integrates with the kit.

Platform-specific extensions to `task-rules.md` for web projects. Read
this when working on web code or any task that touches a web frontend.

The universal `task-rules.md` is generic and references "the project's
verification command," "the project's protected files," etc. This file
fills those in for any web project.

## Scope of "web project" for this file

Any project where the primary deployable is a browser-served bundle:

- React / Next.js / Remix
- Vue / Nuxt
- Vite-based SPAs
- Static sites (Astro, Eleventy, etc.)

Backend-only Node projects use a different convention (see
`backend-task-rules.md` if/when that exists).

## Verification gate (typical)

```sh
# Build (production-equivalent)
npm run build         # or: pnpm build / yarn build / vite build

# Verification suite (project-defined)
npm run test:e2e      # or: playwright test, cypress run, etc.
```

Project's `package.json` `scripts` is the source of truth for actual
commands. `CLAUDE.md` documents which scripts are the verification
gate vs. iteration loops.

## Protected files (typical)

- `package.json` — adding/upgrading/removing deps
- `package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` — lockfiles
- Build config: `vite.config.*`, `webpack.*`, `rollup.config.*`,
  `tsconfig*.json`, `babel.config.*`, `postcss.config.*`,
  `tailwind.config.*`
- Hosting / deploy config: `vercel.json`, `netlify.toml`, `firebase.json`,
  `wrangler.toml`
- Environment templates: `.env`, `.env.example` (the actual `.env` is
  always gitignored)
- Security rules: `firestore.rules`, `database.rules.json`, similar

## Common gotchas (placeholder — fill in from real projects)

- **Hot reload vs production build divergence.** Code that works in
  dev may break in build (tree shaking, minification, dynamic imports).
- **Browser-side env vars.** `VITE_*` / `NEXT_PUBLIC_*` prefixes are
  the build-time inlining convention; everything else is server-only.
- **Hydration mismatches** in Next.js / Remix — typically caused by
  rendering different content server-side vs client-side.
- **CORS** when calling APIs from the browser — different from
  server-side fetch.

## Cloud config (when applicable)

- **Firebase RTDB** rules in `database.rules.json` — security
  contract; treat as protected
- **Firestore** rules in `firestore.rules` — same
- **Cloud Functions** deploy via `firebase deploy --only functions`

## Test infrastructure

- **Unit tests**: Jest, Vitest
- **Component tests**: Testing Library, Cypress component
- **E2E tests**: Playwright, Cypress
- Headless mode for CI / automation; headed mode for human review

`CLAUDE.md` documents which test layer is the verification gate.

---

This file will be expanded with concrete patterns the next time a web
project integrates with the kit. The structure mirrors
`ios-task-rules.md` so projects can cross-reference cleanly.
