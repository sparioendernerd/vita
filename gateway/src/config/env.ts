import { z } from "zod";

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1),
  GATEWAY_PORT: z.coerce.number().default(8765),
  GATEWAY_HOST: z.string().default("0.0.0.0"),
  DISCORD_TOKEN: z.string().optional(),
  DISCORD_APPLICATION_ID: z.string().optional(),
  DISCORD_DM_USER_ID: z.string().optional(),
  CHROMA_URL: z.string().optional(),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(): Env {
  return envSchema.parse(process.env);
}
