import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./config/env.js";
import { requireAuth, type AppEnv } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error.js";
import { me } from "./routes/me.js";
import { exams } from "./routes/exams.js";
import { today } from "./routes/today.js";
import { notes } from "./routes/notes.js";
import { readiness } from "./routes/readiness.js";
import { review } from "./routes/review.js";
import { inferred } from "./routes/inferred.js";
import { streak } from "./routes/streak.js";
import { capture } from "./routes/capture.js";
import { chat } from "./routes/chat.js";
import { share } from "./routes/share.js";
import { graph } from "./routes/graph.js";
import { internal } from "./routes/internal.js";

// The assembled Hono app: global middleware, public + authed route mounts, and
// the error boundary. Kept separate from index.ts (server bootstrap) so the app
// can be imported and exercised without binding a port.
export const app = new Hono<AppEnv>();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: env.WEB_ORIGIN,
    allowHeaders: ["Authorization", "Content-Type"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  })
);

app.get("/health", (c) => c.json({ ok: true }));

// Platform-triggered (Vercel Cron), guarded by CRON_SECRET — see routes/internal.
app.route("/internal", internal);

// Public, unauthenticated: a shared note resolved by its share_token.
app.route("/public/notes", share);

// Everything under /v1 requires a valid InsForge access token.
const v1 = new Hono<AppEnv>();
v1.use("*", requireAuth);
v1.route("/me", me);
v1.route("/exams", exams);
v1.route("/today", today);
v1.route("/notes", notes);
v1.route("/readiness", readiness);
v1.route("/review", review);
v1.route("/inferred", inferred);
v1.route("/streak", streak);
v1.route("/capture", capture);
v1.route("/chat", chat);
v1.route("/graph", graph);
app.route("/v1", v1);

app.onError(errorHandler);

// Vercel's Hono framework preset uses this file as the function entry and invokes
// the DEFAULT export (a Hono app is a fetch handler). index.ts keeps importing the
// named `app` for the local long-running server.
export default app;
