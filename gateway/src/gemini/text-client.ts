import { GoogleGenAI } from "@google/genai";

export function makeTextModelFn(apiKey: string, model: string): (prompt: string) => Promise<string> {
  const genai = new GoogleGenAI({ apiKey });
  return async (prompt: string): Promise<string> => {
    const result = await genai.models.generateContent({
      model,
      contents: prompt,
    });
    return result.text ?? "";
  };
}
