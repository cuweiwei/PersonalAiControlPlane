import assert from "node:assert/strict";
import test from "node:test";
import { ControlPlaneDatabase } from "../apps/control-plane/src/db/database.ts";
import { EventHub } from "../apps/control-plane/src/events/event-hub.ts";
import { SettingsService } from "../apps/control-plane/src/settings/settings-service.ts";
import { HealthMonitor } from "../apps/control-plane/src/systems/health-monitor.ts";

test("system registry includes Information Radar and preserves health evidence", async () => {
  const db = new ControlPlaneDatabase(":memory:");
  const events = new EventHub();
  const health = new HealthMonitor(db, events);
  const originalFetch = globalThis.fetch;
  let responseStatus = 200;
  try {
    health.seed();
    globalThis.fetch = async () => new Response(null, { status: responseStatus });
    await health.checkOnce(123);
    let items = health.list(true);
    assert.deepEqual(items.map((item) => item.id), ["control-plane", "contexthub", "hermes", "information-radar"]);
    assert.equal(items.find((item) => item.id === "information-radar")?.status, "HEALTHY");

    responseStatus = 503;
    await health.checkOnce(456);
    items = health.list(true);
    assert.equal(items.find((item) => item.id === "information-radar")?.status, "DEGRADED");
    assert.equal(items.find((item) => item.id === "information-radar")?.message, "HTTP_503");

    globalThis.fetch = async () => { throw new Error("simulated timeout"); };
    await health.checkOnce(789);
    items = health.list(true);
    assert.equal(items.find((item) => item.id === "information-radar")?.status, "OFFLINE");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("browser entry settings reject executable URLs", () => {
  const db = new ControlPlaneDatabase(":memory:");
  try {
    const settings = new SettingsService(db);
    assert.throws(() => settings.patch({ information_radar_entry_url: "javascript:alert(1)" }), /INVALID_SETTING_VALUE:information_radar_entry_url/);
    settings.patch({ information_radar_entry_url: "https://gnest.taila77e5f.ts.net:8789/" });
    assert.equal(settings.get().information_radar_entry_url, "https://gnest.taila77e5f.ts.net:8789/");
  } finally {
    db.close();
  }
});
