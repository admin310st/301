import { Hono } from "hono";
import { corsMiddleware } from "./lib/cors";
import verify from "./auth/verify";
import register from "./auth/register";
import login from "./auth/login";
import refresh from "./auth/refresh";
import logout from "./auth/logout";
import me from "./auth/me";
import resetPassword from "./auth/reset_password";
import confirmPassword from "./auth/confirm_password";
import keysRouter from "./integrations/keys/router";
import googleStart from "./auth/oauth/google/start";
import googleCallback from "./auth/oauth/google/callback";
import githubStart from "./auth/oauth/github/start";
import githubCallback from "./auth/oauth/github/callback";
import { handleInitKeyCF } from "./integrations/providers/cloudflare/initkey";
import { handleInitKeyNamecheap } from "./integrations/providers/namecheap/initkey";

// Cloudflare Zones
import {
  handleListZones,
  handleGetZone,
  handleCreateZone,
  handleDeleteZone,
  handleSyncZones,
  handleSyncZone,
  handleCheckActivation,
} from "./integrations/providers/cloudflare/zones";

// Cloudflare Zone Config (DNS, SSL, Cache, WAF)
import {
  handleListDNS,
  handleBatchDNS,
  handleGetZoneSettings,
  handleUpdateZoneSettings,
  handlePurgeCache,
} from "./integrations/providers/cloudflare/zoneconf";

// Domains
import {
  handleListDomains,
  handleGetDomain,
  handleCreateDomain,
  handleUpdateDomain,
  handleDeleteDomain,
  handleBatchCreateDomains, 
} from "./domains/domains";

import { handleBatchCreateZones } from "./domains/zones-batch";

// Cron
import cronHandler from "./jobs/cron";

const app = new Hono<{ Bindings: Env }>();

app.use("*", corsMiddleware);

// --- Auth endpoints ---
app.route("/auth/verify", verify);
app.route("/auth/register", register);
app.route("/auth/login", login);
app.route("/auth/refresh", refresh);
app.route("/auth/logout", logout);
app.route("/auth/me", me);
app.route("/auth/reset_password", resetPassword);
app.route("/auth/confirm_password", confirmPassword);
app.route("/auth/oauth/google/start", googleStart);
app.route("/auth/oauth/google/callback", googleCallback);
app.route("/auth/oauth/github/start", githubStart);
app.route("/auth/oauth/github/callback", githubCallback);

// --- Integrations ---
app.route("/integrations/keys", keysRouter);
app.post("/integrations/cloudflare/init", handleInitKeyCF);
app.post("/integrations/namecheap/init", handleInitKeyNamecheap);

// --- Cloudflare Zones ---
app.get("/zones", handleListZones);
app.get("/zones/:id", handleGetZone);
app.post("/zones", handleCreateZone);
app.delete("/zones/:id", handleDeleteZone);
app.post("/zones/sync", handleSyncZones);
app.post("/zones/:id/sync", handleSyncZone);
app.post("/zones/:id/check-activation", handleCheckActivation);

// --- Cloudflare Zone Config ---
app.get("/zones/:id/dns", handleListDNS);
app.post("/zones/:id/dns/batch", handleBatchDNS);
app.get("/zones/:id/settings", handleGetZoneSettings);
app.patch("/zones/:id/settings", handleUpdateZoneSettings);
app.post("/zones/:id/purge-cache", handlePurgeCache);

// --- Domains ---
app.get("/domains", handleListDomains);
app.get("/domains/:id", handleGetDomain);
app.post("/domains", handleCreateDomain);
app.post("/domains/batch", handleBatchCreateDomains);
app.patch("/domains/:id", handleUpdateDomain);
app.delete("/domains/:id", handleDeleteDomain);
app.post("/domains/zones/batch", handleBatchCreateZones);

export default {
  fetch: app.fetch,
  scheduled: cronHandler.scheduled,
};
