import dotenv from "dotenv";

// CLI entrypoints do not get Next.js's automatic env-file loading. Load the
// local developer file without overriding values supplied by the shell/host.
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });
