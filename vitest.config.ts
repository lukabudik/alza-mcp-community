import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Tests must never load (or, since refreshed tokens are persisted, write)
    // the developer's real ~/.alza-mcp/tokens.json; a test that needs a store
    // points ALZA_TOKEN_FILE at a temp file itself. Same for the signed-in web
    // session (~/.alza-mcp/web-session.json).
    env: { ALZA_TOKEN_FILE: "none", ALZA_WEB_SESSION_FILE: "none" },
  },
});
