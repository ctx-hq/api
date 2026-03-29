import { Hono } from "hono";
import type { AppEnv } from "../bindings";
import { APP_VERSION } from "../version";

const app = new Hono<AppEnv>();

app.get("/", (c) => {
  return c.json({
    name: "ctx registry",
    version: APP_VERSION,
    docs: "https://getctx.org/docs",
    api: "https://api.getctx.org/v1",
  });
});

export default app;
