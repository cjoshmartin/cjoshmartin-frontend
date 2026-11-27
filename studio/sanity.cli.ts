import {defineCliConfig} from 'sanity/cli'

export default defineCliConfig({
  api: {
    projectId: 'j3vdh6ti',
    dataset: 'production',
  },
  // Hosted Studio at https://cjoshmartin.sanity.studio. `deployment.appId` identifies it and takes
  // precedence; the hostname is kept so the URL is documented next to the id.
  studioHost: 'cjoshmartin',
  deployment: {
    /** Application id of the hosted Studio, assigned by its first `sanity deploy`. */
    appId: 'uihrx4okiju6hmbteqql9b8u',
    /**
     * Enable auto-updates for studios.
     * Learn more at https://www.sanity.io/docs/studio/latest-version-of-sanity#k47faf43faf56
     */
    autoUpdates: true,
  },
  /**
   * `sanity build`, `sanity dev` and `sanity deploy` keep schema.json current. Both workspaces
   * share one schema, so extracting the production workspace covers staging too.
   */
  schemaExtraction: {
    enabled: true,
    workspace: 'production',
    path: './schema.json',
  },
  /**
   * TypeGen for the Next.js app in the repo root. Run `npm run typegen` in studio/ after changing
   * the schema or any defineQuery query. It is not run automatically by `sanity build`, so
   * building the Studio never writes outside studio/.
   */
  typegen: {
    path: [
      '../app/**/*.{ts,tsx,js,jsx}',
      '../components/**/*.{ts,tsx,js,jsx}',
      '../lib/**/*.{ts,tsx,js,jsx}',
      '../sanity/**/*.{ts,tsx,js,jsx}',
    ],
    schema: './schema.json',
    generates: '../sanity.types.ts',
    overloadClientMethods: true,
  },
})
