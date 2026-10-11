import express from "express";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { connect, ping } from "./db/mongodb.js";
import { messagesRouter } from "./routes/messages.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    try {
      res.json({ ok: true, mongo: await ping() });
    } catch (err) {
      res.status(503).json({ ok: false, mongo: false, error: (err as Error).message });
    }
  });

  app.use(messagesRouter);

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ ok: false, error: "internal_error" });
  });

  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await connect();
  createApp().listen(config.port, () => console.log(`OwnerOrbit listening on :${config.port}`));
}
