import { ChromaClient, type EmbeddingFunction } from "chromadb";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "../logger.js";

/**
 * Custom embedding function for Chroma using Google's Gemini/Generative AI
 */
class GeminiEmbeddingFunction implements EmbeddingFunction {
  private genAI: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model = "text-embedding-004") {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  public async generate(texts: string[]): Promise<number[][]> {
    try {
      const model = this.genAI.getGenerativeModel({ model: this.model });
      
      // Batch embedding request
      const results = await Promise.all(
        texts.map(text => model.embedContent(text))
      );
      
      return results.map(r => r.embedding.values);
    } catch (err: any) {
      logger.error(`[vector] Embedding generation failed: ${err.message}`);
      throw err;
    }
  }
}

export interface VectorMetadata {
  id: string;
  vitaName: string;
  category: string;
  timestamp: number;
  [key: string]: any;
}

export class VectorStore {
  private client: ChromaClient;
  private embeddingFunction: GeminiEmbeddingFunction;
  private collectionName: string;

  constructor(apiKey: string, vitaName: string) {
    this.client = new ChromaClient();
    this.embeddingFunction = new GeminiEmbeddingFunction(apiKey);
    // Chroma collections must be 3-63 chars, alphanumeric/underscore/hyphen
    this.collectionName = `vita_memories_${vitaName.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
  }

  private async getCollection() {
    return await this.client.getOrCreateCollection({
      name: this.collectionName,
      embeddingFunction: this.embeddingFunction,
    });
  }

  public async addMemory(id: string, content: string, metadata: VectorMetadata): Promise<void> {
    try {
      const collection = await this.getCollection();
      
      // Remove any non-primitive values from metadata for Chroma
      const chromaSafemetadata: any = {};
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          chromaSafemetadata[key] = value;
        } else {
          chromaSafemetadata[key] = JSON.stringify(value);
        }
      }

      await collection.add({
        ids: [id],
        documents: [content],
        metadatas: [chromaSafemetadata],
      });
      logger.debug(`[vector] Added memory ${id} to vector store`);
    } catch (err: any) {
      logger.error(`[vector] Failed to add memory to vector store: ${err.message}`);
    }
  }

  public async search(query: string, limit = 5): Promise<{ id: string; content: string; metadata: VectorMetadata; distance: number }[]> {
    try {
      const collection = await this.getCollection();
      const results = await collection.query({
        queryTexts: [query],
        nResults: limit,
      });

      const memories: any[] = [];
      if (results.ids[0]) {
        for (let i = 0; i < results.ids[0].length; i++) {
          memories.push({
            id: results.ids[0][i],
            content: results.documents[0][i],
            metadata: results.metadatas[0][i],
            distance: results.distances ? results.distances[0][i] : 0,
          });
        }
      }
      return memories;
    } catch (err: any) {
      logger.error(`[vector] Vector search failed: ${err.message}`);
      return [];
    }
  }

  public async deleteMemory(id: string): Promise<void> {
    try {
      const collection = await this.getCollection();
      await collection.delete({ ids: [id] });
    } catch (err: any) {
      logger.error(`[vector] Failed to delete memory from vector store: ${err.message}`);
    }
  }
}
