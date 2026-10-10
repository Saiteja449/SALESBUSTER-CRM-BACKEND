import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@langchain/qdrant";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { getOrgCollectionName } from "../../../services/knowledgeService.js";
import { decryptApiKey } from "../../../utils/encryption.js";

/**
 * Creates RAG tool for CRM Feature Guide & Documentation
 */
export const createCRMRAGTool = ({ organization }) => {
  return tool(
    async ({ query }) => {
      try {
        const qdrantUrl = process.env.CLUSTER_ENDPOINT;
        const qdrantApiKey = process.env.QDRANT_API_KEY;
        const geminiApiKey =
          decryptApiKey(organization?.aiSettings?.geminiApiKey) || process.env.GEMINI_API_KEY;

        if (!qdrantUrl || !qdrantApiKey || !geminiApiKey) {
          return JSON.stringify({
            available: false,
            message: "Vector search credentials not configured in environment.",
          });
        }

        const client = new QdrantClient({
          url: qdrantUrl,
          apiKey: qdrantApiKey,
        });

        const embeddings = new GoogleGenerativeAIEmbeddings({
          apiKey: geminiApiKey,
          model: "gemini-embedding-2",
        });

        const collectionsRes = await client.getCollections();
        const existingNames = new Set((collectionsRes.collections || []).map((c) => c.name));

        const matchedChunks = [];

        // 1. Check Platform Knowledge Base (salesbuster_kb)
        if (existingNames.has("salesbuster_kb")) {
          try {
            const platformStore = new QdrantVectorStore(embeddings, {
              client,
              collectionName: "salesbuster_kb",
            });
            const platformResults = await platformStore.similaritySearch(query, 3);
            for (const doc of platformResults) {
              matchedChunks.push({
                source: "SalesBuster CRM User Manual & Feature Guide",
                content: doc.pageContent,
              });
            }
          } catch (pErr) {
            console.warn("[CRM RAG Tool] Platform KB search warning:", pErr.message);
          }
        }

        // 2. Check Org specific documents if available
        const orgColName = getOrgCollectionName(organization);
        if (orgColName && existingNames.has(orgColName)) {
          try {
            const orgStore = new QdrantVectorStore(embeddings, {
              client,
              collectionName: orgColName,
            });
            const orgResults = await orgStore.similaritySearch(query, 2);
            for (const doc of orgResults) {
              matchedChunks.push({
                source: `Organization Document: ${doc.metadata?.docName || "Company Knowledge"}`,
                content: doc.pageContent,
              });
            }
          } catch (oErr) {
            console.warn("[CRM RAG Tool] Org KB search warning:", oErr.message);
          }
        }

        if (matchedChunks.length === 0) {
          return JSON.stringify({
            found: false,
            message: "No specific documentation found matching this feature question.",
          });
        }

        return JSON.stringify({
          found: true,
          documentationExcerpts: matchedChunks,
        });
      } catch (error) {
        return JSON.stringify({ error: `RAG search failed: ${error.message}` });
      }
    },
    {
      name: "search_crm_documentation_and_features",
      description:
        "Searches official SalesBuster CRM documentation, user guides, and feature walkthroughs. Answers: 'How do I use a particular CRM feature?', 'How do I create a template or campaign?', 'How does lead auto-assignment work?', or navigation questions.",
      schema: z.object({
        query: z
          .string()
          .min(2)
          .max(250)
          .describe("The CRM feature or procedural question to search in the knowledge base"),
      }),
    }
  );
};
