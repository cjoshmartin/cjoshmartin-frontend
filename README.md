This is a [Next.js](https://nextjs.org/) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/basic-features/font-optimization) to automatically optimize and load Inter, a custom Google Font.

## Content (Sanity)

All content comes from Sanity (project `j3vdh6ti`). The Studio lives in [`studio/`](studio) and is
deployed at <https://cjoshmartin.sanity.studio> (`/admin` redirects there). The app needs these
environment variables (put them in `.env.local` for local development):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SANITY_PROJECT_ID` | `j3vdh6ti` |
| `NEXT_PUBLIC_SANITY_DATASET` | `production` (or `staging`) |
| `NEXT_PUBLIC_SANITY_STUDIO_URL` | `https://cjoshmartin.sanity.studio` |
| `SANITY_API_READ_TOKEN` | a Sanity API token with the Viewer role (server only; used for Draft Mode and Visual Editing) |

Queries live in `sanity/lib/queries.ts`. After changing a query or the Studio schema, run
`npm run typegen` (it runs the Studio's TypeGen and rewrites `sanity.types.ts`). Redirect documents
are read from Sanity when the app is built, so a new redirect needs a redeploy.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js/) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/deployment) for more details.
