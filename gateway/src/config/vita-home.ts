import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getVitaHome(): string {
  return process.env.VITA_HOME?.trim() || join(homedir(), ".vita");
}

export function ensureVitaHome(): string {
  const home = getVitaHome();
  mkdirSync(home, { recursive: true });
  return home;
}

export function getGlobalConfigPath(): string {
  return join(getVitaHome(), "vita.json");
}

export function getGatewayTokenPath(): string {
  return join(getVitaHome(), "gateway-token");
}

export function getPairingPath(): string {
  return join(getVitaHome(), "paired-nodes.json");
}

export function getSharedDir(): string {
  return join(getVitaHome(), "shared");
}

export function getSharedUserProfilePath(): string {
  return join(getSharedDir(), "user-profile.json");
}

export function getMailboxPath(): string {
  return join(getSharedDir(), "mailbox.json");
}

export function getSharedSchedulePath(): string {
  return join(getSharedDir(), "schedule.json");
}

export function getBackgroundTasksPath(): string {
  return join(getSharedDir(), "background-tasks.json");
}

export function getVitaDir(vitaName: string): string {
  return join(getVitaHome(), vitaName);
}

export function getVitaConfigPath(vitaName: string): string {
  return join(getVitaDir(vitaName), "config.json");
}

export function getVitaSecretsPath(vitaName: string): string {
  return join(getVitaDir(vitaName), "secrets.json");
}
