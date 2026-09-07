import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@langchain/qdrant";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env vars
dotenv.config({ path: path.join(__dirname, "../.env") });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ingestToQdrant() {
  try {
    const qdrantUrl = process.env.CLUSTER_ENDPOINT;
    const qdrantApiKey = process.env.QDRANT_API_KEY;
    const geminiApiKey = process.env.GEMINI_API_KEY;

    if (!qdrantUrl || !qdrantApiKey) {
      throw new Error("Missing CLUSTER_ENDPOINT or QDRANT_API_KEY in .env");
    }
    if (!geminiApiKey) {
      throw new Error("Missing GEMINI_API_KEY in .env");
    }

    const docPath = path.join(__dirname, "../data/kranthi_kb.pdf");
    if (!fs.existsSync(docPath)) {
      throw new Error(`Document not found at ${docPath}`);
    }

    console.log("Loading document...");
    const loader = new PDFLoader(docPath);
    const docs = await loader.load();

    console.log("Splitting text into chunks...");
    const textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    const splitDocs = await textSplitter.splitDocuments(docs);
    console.log(`Generated ${splitDocs.length} chunks.`);

    console.log("Connecting to Qdrant Cloud...");
    const client = new QdrantClient({
      url: qdrantUrl,
      apiKey: qdrantApiKey,
    });

    const collectionName = "kranthi_kb";
    const embeddings = new GoogleGenerativeAIEmbeddings({
      apiKey: geminiApiKey,
      model: "gemini-embedding-2",
      maxRetries: 3,
    });

    console.log(
      `Uploading ${splitDocs.length} chunks to Qdrant collection '${collectionName}' in batches...`,
    );

    const BATCH_SIZE = 25;
    const DELAY_MS = 15000; // 15 seconds per batch of 25 = 100 per minute

    // We can use an existing collection or QdrantVectorStore.fromDocuments creates/upserts
    for (let i = 0; i < splitDocs.length; i += BATCH_SIZE) {
      const batch = splitDocs.slice(i, i + BATCH_SIZE);
      console.log(
        `Processing batch ${i / BATCH_SIZE + 1} (${batch.length} chunks)...`,
      );

      // Ingest the batch
      await QdrantVectorStore.fromDocuments(batch, embeddings, {
        client,
        collectionName,
      });

      if (i + BATCH_SIZE < splitDocs.length) {
        console.log(
          `Waiting ${DELAY_MS / 1000} seconds to respect rate limits...`,
        );
        await delay(DELAY_MS);
      }
    }

    console.log("Successfully ingested documents into Qdrant!");
  } catch (error) {
    console.error("Error during Qdrant ingestion:", error);
  }
}

ingestToQdrant();
