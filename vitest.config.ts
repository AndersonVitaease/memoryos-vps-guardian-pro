import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The public dependency ships TypeScript sources (no build step): inline
    // it so Vite transforms its .ts files instead of externalizing them to
    // plain Node (which cannot load .ts).
    server: {
      deps: {
        inline: [/memoryos-vps-guardian/],
      },
    },
  },
});
