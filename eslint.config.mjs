import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
    // studio/, migration/ and scripts/ are separate packages with their own lint setup.
    globalIgnores(["studio/**", "migration/**", "scripts/**"]),
    {
        extends: [...nextCoreWebVitals],
    },
]);
