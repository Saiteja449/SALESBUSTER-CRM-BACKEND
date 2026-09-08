import fs from "fs";
import path from "path";
import crypto from "crypto";
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@langchain/qdrant";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { Document } from "@langchain/core/documents";
import mammoth from "mammoth";
import { decryptApiKey } from "../utils/encryption.js";

const getQdrantConfig = (customApiKey = null) => {
  const qdrantUrl = process.env.CLUSTER_ENDPOINT;
  const qdrantApiKey = process.env.QDRANT_API_KEY;
  const geminiApiKey = customApiKey;

  if (!qdrantUrl || !qdrantApiKey) {
    throw new Error("Missing CLUSTER_ENDPOINT or QDRANT_API_KEY in environment");
  }
  if (!geminiApiKey) {
    throw new Error(
      "Organization Google Gemini API Key is not configured. Please add and save your Gemini API Key in Step 1 before uploading knowledge documents.",
    );
  }

  const client = new QdrantClient({
    url: qdrantUrl,
    apiKey: qdrantApiKey,
  });

  const embeddings = new GoogleGenerativeAIEmbeddings({
    apiKey: geminiApiKey,
    model: "gemini-embedding-2",
  });

  return { client, embeddings };
};

/**
 * Returns clean, safe collection name for an organization
 */
export const getOrgCollectionName = (organization) => {
  if (organization?.aiSettings?.qdrantCollection) {
    return organization.aiSettings.qdrantCollection;
  }
  const orgId = organization?._id ? organization._id.toString() : "default";
  return `org_${orgId}_kb`;
};

/**
 * Extracts raw text documents from a file based on its extension
 */
const loadFileDocuments = async (filePath, originalName) => {
  const ext = path.extname(originalName || filePath).toLowerCase();

  if (ext === ".pdf") {
    const loader = new PDFLoader(filePath);
    return await loader.load();
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return [new Document({ pageContent: result.value || "", metadata: { source: originalName } })];
  }

  // Fallback for .txt, .md, .json, .csv
  const content = fs.readFileSync(filePath, "utf-8");
  return [new Document({ pageContent: content, metadata: { source: originalName } })];
};

/**
 * Ingests an uploaded document into the organization's Qdrant vector store
 */
export const ingestDocumentForOrg = async ({ organization, filePath, originalName, fileSize }) => {
  const geminiApiKey = decryptApiKey(organization?.aiSettings?.geminiApiKey);
  const { client, embeddings } = getQdrantConfig(geminiApiKey);
  const collectionName = getOrgCollectionName(organization);
  const docId = `doc_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;

  console.log(`[KnowledgeService] Ingesting "${originalName}" for Org: ${organization.name} (${collectionName})`);

  // 1. Load document content
  const rawDocs = await loadFileDocuments(filePath, originalName);

  // 2. Split into chunks
  const textSplitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });
  const splitDocs = await textSplitter.splitDocuments(rawDocs);

  if (splitDocs.length === 0) {
    throw new Error("No readable text content found in document.");
  }

  // 3. Attach metadata
  for (const doc of splitDocs) {
    doc.metadata = {
      ...(doc.metadata || {}),
      docId,
      docName: originalName,
      organizationId: organization._id.toString(),
      organizationName: organization.name,
      uploadedAt: new Date().toISOString(),
    };
  }

  // 4. Ensure Qdrant collection exists (dimension 768 for gemini-embedding-2)
  try {
    const collectionsRes = await client.getCollections();
    const exists = collectionsRes.collections?.some((c) => c.name === collectionName);
    if (!exists) {
      console.log(`[KnowledgeService] Creating Qdrant collection: ${collectionName}`);
      await client.createCollection(collectionName, {
        vectors: {
          size: 768,
          distance: "Cosine",
        },
      });
    }
  } catch (collErr) {
    console.warn(`[KnowledgeService] Error checking collection '${collectionName}':`, collErr.message);
  }

  // 5. Ingest chunks in batches to avoid rate limits
  const BATCH_SIZE = 25;
  const DELAY_MS = 3000;

  for (let i = 0; i < splitDocs.length; i += BATCH_SIZE) {
    const batch = splitDocs.slice(i, i + BATCH_SIZE);
    await QdrantVectorStore.fromDocuments(batch, embeddings, {
      client,
      collectionName,
    });
    if (i + BATCH_SIZE < splitDocs.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  // 6. Record document in Organization aiSettings
  if (!organization.aiSettings) organization.aiSettings = {};
  if (!organization.aiSettings.knowledgeDocs) organization.aiSettings.knowledgeDocs = [];
  if (!organization.aiSettings.qdrantCollection) {
    organization.aiSettings.qdrantCollection = collectionName;
  }

  const docRecord = {
    docId,
    name: originalName,
    originalName,
    fileSize: fileSize || 0,
    chunkCount: splitDocs.length,
    status: "indexed",
    uploadedAt: new Date(),
  };

  organization.aiSettings.knowledgeDocs.push(docRecord);
  await organization.save();

  console.log(`[KnowledgeService] Successfully indexed ${splitDocs.length} chunks for ${originalName}`);
  return docRecord;
};

/**
 * Deletes a document from the organization's Qdrant vector store and schema
 */
export const deleteDocumentForOrg = async ({ organization, docId }) => {
  const { client } = getQdrantConfig();
  const collectionName = getOrgCollectionName(organization);

  console.log(`[KnowledgeService] Deleting docId: ${docId} from collection: ${collectionName}`);

  try {
    // Delete vector points matching docId metadata
    await client.delete(collectionName, {
      filter: {
        must: [
          {
            key: "metadata.docId",
            match: { value: docId },
          },
        ],
      },
    });
  } catch (err) {
    console.warn(`[KnowledgeService] Qdrant point delete warning: ${err.message}`);
  }

  // Remove from organization metadata
  if (organization.aiSettings?.knowledgeDocs) {
    organization.aiSettings.knowledgeDocs = organization.aiSettings.knowledgeDocs.filter(
      (d) => d.docId !== docId,
    );
    await organization.save();
  }

  return { success: true, docId };
};

/**
 * Returns list of knowledge documents for organization
 */
export const listDocumentsForOrg = (organization) => {
  return organization?.aiSettings?.knowledgeDocs || [];
};
