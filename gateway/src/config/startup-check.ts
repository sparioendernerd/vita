import { hasLocalVitas } from "./spawn-storage.js";

export function getSpawnInitInstruction(): string {
  return "Run `npm run cli -- spawn init` to create your first VITA.";
}

export function ensureSpawnInitialized(): void {
  if (!hasLocalVitas()) {
    throw new Error(`No local VITAs found. ${getSpawnInitInstruction()}`);
  }
}

