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
import { handleInitKeyVirusTotal, handleGetVirusTotalQuota } from "./integrations/providers/virustotal/initkey";
import {
  handleListTemplates,
  handleListPresets,
  handleListSiteRedirects,
  handleListDomainRedirects,
  handleGetRedirect,
  handleCreateRedirect,
  handleCreatePreset,
  handleUpdateRedirect,
  handleDeleteRedirect,
  handleGetZoneRedirectLimits,
} from "./redirects/redirects";


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

// Projects
import {
  handleListProjects,
  handleGetProject,
  handleCreateProject,
  handleUpdateProject,
  handleDeleteProject,
  handleListProjectIntegrations,
  handleAddProjectIntegration,
  handleRemoveProjectIntegration,
} from "./projects/projects";

// Sites
import {
  handleListProjectSites,
  handleGetSite,
  handleCreateSite,
  handleUpdateSite,
  handleDeleteSite,
  handleAssignDomainToSite,
  handleUnassignDomainFromSite,
} from "./sites/sites";

// Domains
import {
  handleListDomains,
  handleGetDomain,
  handleCreateDomain,
  handleUpdateDomain,
  handleDeleteDomain,
  handleBatchCreateDomains,
} from "./domains/domains";

// Domain Health
import { handleGetDomainHealth } from "./domains/health";
import { handleSetupClientWorker, handleGetClientStatus } from "./health/setup";

// Worker Configs
import {
  handleGenerateConfig,
  handleGetConfigs,
  handleGetConfig,
  handleUpdateConfig,
  handleDownloadConfig,
  handleAddRoute,
  handleRemoveRoute,
  handleSetupWorker,
} from "./workers/config";

import { handleBatchCreateZones } from "./domains/zones-batch";

// Redirects CF Sync
import {
  handleApplyZoneRedirects,
  handleGetZoneRedirectStatus,
} from "./redirects/cf-sync";

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
app.post("/integrations/virustotal/init", handleInitKeyVirusTotal);
app.get("/integrations/virustotal/quota", handleGetVirusTotalQuota);

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

// --- Projects ---
app.get("/projects", handleListProjects);
app.get("/projects/:id", handleGetProject);
app.post("/projects", handleCreateProject);
app.patch("/projects/:id", handleUpdateProject);
app.delete("/projects/:id", handleDeleteProject);
app.get("/projects/:id/integrations", handleListProjectIntegrations);
app.post("/projects/:id/integrations", handleAddProjectIntegration);
app.delete("/projects/:id/integrations/:keyId", handleRemoveProjectIntegration);

// --- Sites ---
app.get("/projects/:id/sites", handleListProjectSites);
app.post("/projects/:id/sites", handleCreateSite);
app.get("/sites/:id", handleGetSite);
app.patch("/sites/:id", handleUpdateSite);
app.delete("/sites/:id", handleDeleteSite);
app.post("/sites/:id/domains", handleAssignDomainToSite);
app.delete("/sites/:id/domains/:domainId", handleUnassignDomainFromSite);

// --- Domains ---
app.get("/domains", handleListDomains);
app.get("/domains/:id", handleGetDomain);
app.get("/domains/:id/health", handleGetDomainHealth);

// --- Health Client ---
app.post("/health/client/setup", handleSetupClientWorker);
app.get("/health/client/status", handleGetClientStatus);

// --- Worker Configs ---
app.post("/workers/config", handleGenerateConfig);
app.get("/workers/config", handleGetConfigs);
app.get("/workers/config/:type", handleGetConfig);
app.put("/workers/config/:type", handleUpdateConfig);
app.get("/workers/config/:type/download", handleDownloadConfig);
app.post("/workers/config/:type/setup", handleSetupWorker);
app.post("/workers/config/:type/routes", handleAddRoute);
app.delete("/workers/config/:type/routes", handleRemoveRoute);

app.post("/domains", handleCreateDomain);
app.post("/domains/batch", handleBatchCreateDomains);
app.patch("/domains/:id", handleUpdateDomain);
app.delete("/domains/:id", handleDeleteDomain);
app.post("/domains/zones/batch", handleBatchCreateZones);

// --- Redirects ---
// Templates & Presets (public)
app.get("/redirects/templates", handleListTemplates);
app.get("/redirects/presets", handleListPresets);

// List redirects
app.get("/sites/:siteId/redirects", handleListSiteRedirects);
app.get("/domains/:domainId/redirects", handleListDomainRedirects);

// CRUD redirects
app.get("/redirects/:id", handleGetRedirect);
app.post("/domains/:domainId/redirects", handleCreateRedirect);
app.post("/domains/:domainId/redirects/preset", handleCreatePreset);
app.patch("/redirects/:id", handleUpdateRedirect);
app.delete("/redirects/:id", handleDeleteRedirect);

// Sync & Limits
app.get("/zones/:id/redirect-limits", handleGetZoneRedirectLimits);

// CF Apply (zone-level)
app.post("/zones/:id/apply-redirects", handleApplyZoneRedirects);
app.get("/zones/:id/redirect-status", handleGetZoneRedirectStatus);

export default {
  fetch: app.fetch,
  scheduled: cronHandler.scheduled,
};
