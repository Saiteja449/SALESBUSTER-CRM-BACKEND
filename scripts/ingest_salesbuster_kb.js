import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mammoth from "mammoth";
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@langchain/qdrant";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const COLLECTION_NAME = "salesbuster_kb";
const VECTOR_DIMENSION = 3072;
const DOCX_PATH = path.join(__dirname, "..", "SalesBuster Knowledge Base.docx");

async function ingestSalesBusterKB() {
  console.log("==================================================");
  console.log("   SalesBuster Qdrant Knowledge Base Ingestion    ");
  console.log("==================================================");

  const qdrantUrl = process.env.CLUSTER_ENDPOINT;
  const qdrantApiKey = process.env.QDRANT_API_KEY;
  const geminiApiKey = process.env.GEMINI_API_KEY;

  if (!qdrantUrl || !qdrantApiKey) {
    throw new Error("Missing CLUSTER_ENDPOINT or QDRANT_API_KEY in .env");
  }
  if (!geminiApiKey) {
    throw new Error("Missing GEMINI_API_KEY in .env");
  }

  if (!fs.existsSync(DOCX_PATH)) {
    throw new Error(`Knowledge document not found at: ${DOCX_PATH}`);
  }

  console.log(`\n1. Reading document: ${path.basename(DOCX_PATH)}...`);
  const result = await mammoth.extractRawText({ path: DOCX_PATH });
  const rawText = result.value || "";

  if (!rawText.trim()) {
    throw new Error("Extracted document text is empty.");
  }
  console.log(`   Document extracted successfully (${rawText.length} characters).`);

  console.log("\n2. Chunking document...");
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 800,
    chunkOverlap: 150,
  });

  const rawDocs = [
    new Document({
      pageContent: rawText,
      metadata: {
        source: "SalesBuster Knowledge Base.docx",
        topic: "SalesBuster CRM Platform, Features & Pricing",
      },
    }),
  ];

  const splitDocs = await textSplitter.splitDocuments(rawDocs);
  const validDocs = splitDocs.filter(
    (d) => d.pageContent && d.pageContent.trim().length > 0,
  );
  console.log(`   Generated ${validDocs.length} text chunks.`);

  // Tag metadata
  validDocs.forEach((doc, idx) => {
    doc.metadata = {
      ...doc.metadata,
      chunkIndex: idx,
      totalChunks: validDocs.length,
      uploadedAt: new Date().toISOString(),
    };
  });

  console.log("\n3. Connecting to Qdrant & preparing collection...");
  const client = new QdrantClient({
    url: qdrantUrl,
    apiKey: qdrantApiKey,
  });

  const collectionsRes = await client.getCollections();
  const exists = collectionsRes.collections?.some(
    (c) => c.name === COLLECTION_NAME,
  );

  if (exists) {
    console.log(`   Collection '${COLLECTION_NAME}' exists. Recreating for clean indexing...`);
    await client.deleteCollection(COLLECTION_NAME);
  }

  console.log(`   Creating collection '${COLLECTION_NAME}' (dim: ${VECTOR_DIMENSION}, metric: Cosine)...`);
  await client.createCollection(COLLECTION_NAME, {
    vectors: {
      size: VECTOR_DIMENSION,
      distance: "Cosine",
    },
  });

  console.log("\n4. Embedding and inserting vectors into Qdrant...");
  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: geminiApiKey,
    model: "gemini-embedding-2",
  });

  const BATCH_SIZE = 15;
  const DELAY_MS = 2000;

  for (let i = 0; i < validDocs.length; i += BATCH_SIZE) {
    const batch = validDocs.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(validDocs.length / BATCH_SIZE);

    console.log(`   Indexing batch ${batchNum}/${totalBatches} (${batch.length} chunks)...`);

    let attempts = 0;
    let success = false;
    while (!success && attempts < 3) {
      try {
        attempts++;
        await QdrantVectorStore.fromDocuments(batch, embeddings, {
          client,
          collectionName: COLLECTION_NAME,
        });
        success = true;
      } catch (err) {
        console.warn(`   ⚠️ Batch ${batchNum} attempt ${attempts} failed: ${err.message}`);
        if (attempts >= 3) throw err;
        await new Promise((r) => setTimeout(r, 3000 * attempts));
      }
    }

    if (i + BATCH_SIZE < validDocs.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  console.log(`\n✅ Finished! ${validDocs.length} chunks indexed into collection '${COLLECTION_NAME}'.`);

  // Quick verification search
  console.log("\n5. Running verification similarity search...");
  const vectorStore = await QdrantVectorStore.fromExistingCollection(embeddings, {
    client,
    collectionName: COLLECTION_NAME,
  });

  const testQuery = "How much does SalesBuster cost?";
  const testResults = await vectorStore.similaritySearch(testQuery, 2);
  console.log(`   Query: "${testQuery}"`);
  console.log(`   Found ${testResults.length} matching chunks:`);
  testResults.forEach((res, i) => {
    console.log(`   --- Match #${i + 1} ---`);
    console.log(`   ${res.pageContent.substring(0, 150)}...`);
  });

  console.log("\n🎉 Ingestion and verification completed successfully!");
}

ingestSalesBusterKB().catch((err) => {
  console.error("\n❌ Ingestion Failed:", err);
  process.exit(1);
});
