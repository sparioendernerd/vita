import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLocalVita,
  hasLocalVitas,
  importExistingGraves,
  listVitaSummaries,
  markMailboxMessageRead,
  readMailboxMessages,
  readSharedUserProfile,
  sendMailboxMessage,
} from "../dist/config/spawn-storage.js";
import { getVitaConfigPath, getVitaDir } from "../dist/config/vita-home.js";
import { VitaRegistry } from "../dist/config/vita-registry.js";
import { ensureSpawnInitialized } from "../dist/config/startup-check.js";
import { closeAllMemoryStores, getMemoryStore } from "../dist/memory/index.js";

async function withTempHome(name, fn) {
  const previous = process.env.VITA_HOME;
  const home = mkdtempSync(join(tmpdir(), `vita-${name}-`));
  closeAllMemoryStores();
  process.env.VITA_HOME = home;
  try {
    await fn(home);
    closeAllMemoryStores();
    console.log(`PASS ${name}`);
  } catch (error) {
    closeAllMemoryStores();
    console.error(`FAIL ${name}`);
    throw error;
  } finally {
    process.env.VITA_HOME = previous;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // Ignore Windows file handle lag during test cleanup.
    }
  }
}

await withTempHome("spawn-init", (home) => {
  const vita = createLocalVita({
    name: "iris",
    personality: "Dry and observant.",
    sharedUserProfile: "Mr Vailen likes direct technical answers.",
  });
  assert.equal(vita.name, "iris");
  assert.equal(hasLocalVitas(), true);
  assert.equal(readSharedUserProfile()?.profile, "Mr Vailen likes direct technical answers.");
  assert.equal(existsSync(getVitaConfigPath("iris")), true);
  assert.equal(existsSync(join(getVitaDir("iris"), "IDENTITY.md")), true);
  assert.equal(existsSync(join(home, "shared", "mailbox.json")), true);
});

await withTempHome("spawn-create", () => {
  createLocalVita({
    name: "iris",
    personality: "Dry and observant.",
    sharedUserProfile: "Shared profile text.",
  });
  createLocalVita({
    name: "ember",
    personality: "Brisk and curious.",
  });
  assert.equal(listVitaSummaries().length, 2);
  assert.equal(readSharedUserProfile()?.profile, "Shared profile text.");
});

await withTempHome("registry", () => {
  createLocalVita({ name: "iris", personality: "Dry.", sharedUserProfile: "Shared." });
  createLocalVita({ name: "ember", personality: "Brisk." });
  const registry = new VitaRegistry();
  registry.load();
  assert.deepEqual(
    registry.getAll().map((vita) => vita.name).sort(),
    ["ember", "iris"]
  );
});

await withTempHome("memory-isolation", () => {
  createLocalVita({ name: "alpha", personality: "Calm.", sharedUserProfile: "Shared profile." });
  createLocalVita({ name: "beta", personality: "Sharp." });
  const alphaStore = getMemoryStore("alpha");
  const betaStore = getMemoryStore("beta");
  alphaStore.writeMemory("alpha", "conversations", "Alpha secret", ["test"]);
  assert.equal(alphaStore.readMemory("alpha", "conversations").length, 1);
  assert.equal(betaStore.readMemory("beta", "conversations").length, 0);
  assert.equal(readSharedUserProfile()?.profile, "Shared profile.");
});

await withTempHome("mailbox", () => {
  createLocalVita({ name: "alpha", personality: "Calm.", sharedUserProfile: "Shared profile." });
  createLocalVita({ name: "beta", personality: "Sharp." });
  const sent = sendMailboxMessage({
    fromVita: "alpha",
    toVita: "beta",
    subject: "Status",
    body: "Build is green.",
  });
  const unread = readMailboxMessages("beta", "unread");
  assert.equal(unread.length, 1);
  assert.equal(unread[0].id, sent.id);
  const marked = markMailboxMessageRead("beta", sent.id);
  assert.equal(marked.status, "read");
  const readMessages = readMailboxMessages("beta", "read");
  assert.equal(readMessages.length, 1);
  assert.equal(readMessages[0].id, sent.id);
});

await withTempHome("graves-migration", (home) => {
  const gravesDir = join(home, "graves");
  mkdirSync(gravesDir, { recursive: true });
  writeFileSync(
    join(gravesDir, "memories.json"),
    JSON.stringify({
      conversations: [
        {
          id: "legacy-1",
          category: "conversations",
          content: "Legacy Graves memory",
          tags: ["legacy"],
          timestamp: Date.now(),
        },
      ],
    }, null, 2),
    "utf-8"
  );
  importExistingGraves();
  const store = getMemoryStore("graves");
  const memories = store.readMemory("graves", "conversations");
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, "Legacy Graves memory");
  assert.equal(existsSync(join(gravesDir, "memories.json")), true);
  assert.equal(existsSync(join(gravesDir, ".migrated_v2")), true);
});

await withTempHome("startup-guard", (home) => {
  assert.equal(home.length > 0, true);
  assert.throws(() => ensureSpawnInitialized(), /spawn init/i);
});

console.log("All gateway Spawn tests passed.");
