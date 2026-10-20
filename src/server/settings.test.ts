import { describe, expect, it } from "vitest";

import { openMemoryDatabase } from "../db/index.ts";
import { DEFAULT_ALLOWED_DOMAINS } from "../media/validate-url.ts";
import {
  DEFAULT_SETTINGS,
  isPrivateIpv4,
  isValidDomainName,
  migrateAllowedDomains,
  readSettings,
  SETTING_ALLOWED_DOMAINS,
  SETTING_GLOBAL_VOLUME,
  validateSettingsPatch,
  writeSettings,
} from "./settings.ts";

describe("readSettings", () => {
  it("devuelve los valores por defecto con la base vacía", () => {
    const settings = readSettings(openMemoryDatabase());
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("hace round-trip de escritura y lectura", () => {
    const db = openMemoryDatabase();
    const result = validateSettingsPatch({
      globalVolume: 40,
      defaultMaxDurationSec: 15,
      watchdogMarginSec: 15,
      maxVideoDurationSec: 300,
      maxVideoBytes: 50 * 1024 * 1024,
      allowedDomains: ["Youtube.com", "tiktok.com", "youtube.com"],
      port: 9000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    writeSettings(db, result.value);

    const settings = readSettings(db);
    expect(settings.globalVolume).toBe(40);
    expect(settings.defaultMaxDurationSec).toBe(15);
    expect(settings.watchdogMarginSec).toBe(15);
    expect(settings.maxVideoDurationSec).toBe(300);
    expect(settings.maxVideoBytes).toBe(50 * 1024 * 1024);
    expect(settings.allowedDomains).toEqual(["youtube.com", "tiktok.com"]);
    expect(settings.port).toBe(9000);
  });

  it("ignora un valor guardado fuera de rango y usa el defecto", () => {
    const db = openMemoryDatabase();
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(SETTING_GLOBAL_VOLUME, "999");
    expect(readSettings(db).globalVolume).toBe(DEFAULT_SETTINGS.globalVolume);
  });
});

describe("dominios permitidos por defecto y migración", () => {
  // La lista por defecto ANTERIOR (antes de sumar instagram.com).
  const PREVIOUS_DEFAULT = ["youtube.com", "youtu.be", "tiktok.com", "clips.twitch.tv", "kick.com"];

  it("instagram.com está en los dominios por defecto", () => {
    expect(DEFAULT_ALLOWED_DOMAINS).toContain("instagram.com");
    expect(DEFAULT_SETTINGS.allowedDomains).toContain("instagram.com");
  });

  it("migra la lista por defecto anterior agregando instagram.com", () => {
    expect(migrateAllowedDomains(PREVIOUS_DEFAULT)).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
  });

  it("no toca una lista personalizada (quitó o agregó dominios)", () => {
    const customized = ["youtube.com", "tiktok.com"];
    expect(migrateAllowedDomains(customized)).toEqual(customized);

    const withExtra = [...PREVIOUS_DEFAULT, "vimeo.com"];
    expect(migrateAllowedDomains(withExtra)).toEqual(withExtra);

    const reordered = ["kick.com", "youtube.com", "youtu.be", "tiktok.com", "clips.twitch.tv"];
    expect(migrateAllowedDomains(reordered)).toEqual(reordered);
  });

  it("readDomains migra solo la lista guardada que es la default anterior", () => {
    // Guardada como default ANTERIOR => migra.
    const db1 = openMemoryDatabase();
    db1
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(SETTING_ALLOWED_DOMAINS, PREVIOUS_DEFAULT.join(","));
    expect(readSettings(db1).allowedDomains).toEqual([...DEFAULT_ALLOWED_DOMAINS]);

    // Guardada y personalizada => se respeta.
    const db2 = openMemoryDatabase();
    db2
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(SETTING_ALLOWED_DOMAINS, "youtube.com,tiktok.com");
    expect(readSettings(db2).allowedDomains).toEqual(["youtube.com", "tiktok.com"]);
  });

  it("la lista ya migrada no se vuelve a tocar", () => {
    const db = openMemoryDatabase();
    db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
      .run(SETTING_ALLOWED_DOMAINS, DEFAULT_ALLOWED_DOMAINS.join(","));
    expect(readSettings(db).allowedDomains).toEqual([...DEFAULT_ALLOWED_DOMAINS]);
  });
});

describe("validateSettingsPatch", () => {
  it("rechaza campos desconocidos y tipos inválidos", () => {
    expect(validateSettingsPatch({ nope: 1 }).ok).toBe(false);
    expect(validateSettingsPatch({ globalVolume: "50" }).ok).toBe(false);
    expect(validateSettingsPatch({ globalVolume: 1.5 }).ok).toBe(false);
    expect(validateSettingsPatch([]).ok).toBe(false);
    expect(validateSettingsPatch(null).ok).toBe(false);
  });

  it("rechaza valores fuera de rango", () => {
    expect(validateSettingsPatch({ globalVolume: 101 }).ok).toBe(false);
    expect(validateSettingsPatch({ globalVolume: -1 }).ok).toBe(false);
    expect(validateSettingsPatch({ port: 80 }).ok).toBe(false);
    expect(validateSettingsPatch({ port: 70000 }).ok).toBe(false);
    expect(validateSettingsPatch({ defaultMaxDurationSec: 0 }).ok).toBe(false);
    expect(validateSettingsPatch({ watchdogMarginSec: 0 }).ok).toBe(false);
    expect(validateSettingsPatch({ watchdogMarginSec: 121 }).ok).toBe(false);
  });

  it("rechaza una whitelist vacía o con dominios inválidos", () => {
    expect(validateSettingsPatch({ allowedDomains: [] }).ok).toBe(false);
    expect(validateSettingsPatch({ allowedDomains: ["192.168.1.1"] }).ok).toBe(false);
    expect(validateSettingsPatch({ allowedDomains: ["localhost"] }).ok).toBe(false);
    expect(validateSettingsPatch({ allowedDomains: ["sinpunto"] }).ok).toBe(false);
  });

  it("acepta un parche parcial válido", () => {
    const result = validateSettingsPatch({ globalVolume: 0 });
    expect(result).toEqual({ ok: true, value: { globalVolume: 0 } });
  });

  it("acepta la política de cooldown y sus topes", () => {
    expect(validateSettingsPatch({ redemptionsOnCooldown: "queue" })).toEqual({
      ok: true,
      value: { redemptionsOnCooldown: "queue" },
    });
    expect(validateSettingsPatch({ redemptionsOnCooldown: "skip" })).toEqual({
      ok: true,
      value: { redemptionsOnCooldown: "skip" },
    });
    expect(validateSettingsPatch({ redemptionsWaitMax: 50 }).ok).toBe(true);
    expect(validateSettingsPatch({ redemptionsWaitTimeoutMin: 30 }).ok).toBe(true);
  });

  it("rechaza una política de cooldown desconocida y topes fuera de rango", () => {
    expect(validateSettingsPatch({ redemptionsOnCooldown: "otra" }).ok).toBe(false);
    expect(validateSettingsPatch({ redemptionsWaitMax: 0 }).ok).toBe(false);
    expect(validateSettingsPatch({ redemptionsWaitMax: 201 }).ok).toBe(false);
    expect(validateSettingsPatch({ redemptionsWaitTimeoutMin: 0 }).ok).toBe(false);
    expect(validateSettingsPatch({ redemptionsWaitTimeoutMin: 121 }).ok).toBe(false);
  });
});

describe("isValidDomainName", () => {
  it("acepta dominios y subdominios públicos", () => {
    for (const domain of ["youtube.com", "www.youtube.com", "clips.twitch.tv", "example.co.uk"]) {
      expect(isValidDomainName(domain), domain).toBe(true);
    }
  });

  it("rechaza IPs, rangos privados, localhost y nombres internos", () => {
    for (const value of [
      "8.8.8.8",
      "192.168.1.1",
      "10.0.0.1",
      "127.0.0.1",
      "::1",
      "[::1]",
      "localhost",
      "algo.localhost",
      "sinpunto",
    ]) {
      expect(isValidDomainName(value), value).toBe(false);
    }
  });

  it("rechaza caracteres y labels inválidos", () => {
    for (const value of [
      "foo_bar.com",
      "-foo.com",
      "foo-.com",
      "foo..com",
      "foo.c",
      "https://youtube.com",
      "youtube.com/path",
      "youtube.com:8080",
      "foo bar.com",
      "",
      "   ",
    ]) {
      expect(isValidDomainName(value), value).toBe(false);
    }
  });
});

describe("isPrivateIpv4", () => {
  it("detecta rangos privados y especiales", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0"]) {
      expect(isPrivateIpv4(ip), ip).toBe(true);
    }
  });

  it("no marca direcciones públicas ni no-IPs", () => {
    for (const value of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "youtube.com", "999.1.1.1"]) {
      expect(isPrivateIpv4(value), value).toBe(false);
    }
  });
});