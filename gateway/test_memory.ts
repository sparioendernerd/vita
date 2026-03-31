import { memoryStore } from "./src/memory/index.js";

console.log("--- Memory Store Test ---");

const vitaName = "graves_test";
console.log(`Writing test memory for ${vitaName}...`);

const writeRes = memoryStore.writeMemory(
    vitaName, 
    "user-profiles", 
    "User's favorite test color is ultraviolet.", 
    ["color", "test"]
);
console.log("Write response:", writeRes);

console.log("Reading memory for user-profiles...");
const memories = memoryStore.readMemory(vitaName, "user-profiles");
console.log("Memories:", JSON.stringify(memories, null, 2));

console.log("Searching memory for 'ultraviolet'...");
const searchRes = memoryStore.searchMemory(vitaName, "ultraviolet");
console.log("Search results:", JSON.stringify(searchRes, null, 2));

console.log("Core memories:", memoryStore.getCoreMemories(vitaName));

console.log("--- Test Complete ---");
