import { MongoClient } from "mongodb";

const SOURCE_URI =
  "mongodb+srv://saiteja:Saiteja1920@task-management.rzoshdy.mongodb.net/crm-salesbuster-beta?appName=crm-salesbuster-beta";
const TARGET_URI =
  "mongodb://salesbuster_beta_user:salesbusterBeta%402026@127.0.0.1:27017/salesbuster_master_beta?authSource=admin";

const MASTER_DB_NAME = "salesbuster_master_beta";

/**
 * Copies a full database (all collections, documents, and indexes)
 */
async function copyDatabase(srcClient, tgtClient, dbName) {
  console.log(`\n========================================`);
  console.log(`>>> Starting transfer for DB: ${dbName}`);
  console.log(`========================================`);

  const srcDb = srcClient.db(dbName);
  const tgtDb = tgtClient.db(dbName);

  const collections = await srcDb.listCollections().toArray();
  console.log(`Found ${collections.length} collections in '${dbName}'.`);

  let totalDocsCopied = 0;

  for (const colInfo of collections) {
    const colName = colInfo.name;
    if (colName.startsWith("system.")) continue;

    const srcCol = srcDb.collection(colName);
    const tgtCol = tgtDb.collection(colName);

    const docCount = await srcCol.countDocuments();
    process.stdout.write(`  - Collection '${colName}' (${docCount} docs): `);

    if (docCount === 0) {
      // Create empty collection and copy indexes
      try {
        await tgtDb.createCollection(colName);
      } catch (_) {}

      try {
        const indexes = await srcCol.indexes();
        const nonIdIndexes = indexes
          .filter((idx) => idx.name !== "_id_")
          .map((idx) => {
            const { v, ns, ...rest } = idx;
            return rest;
          });
        if (nonIdIndexes.length > 0) {
          await tgtCol.createIndexes(nonIdIndexes);
        }
      } catch (_) {}

      console.log(`created (empty).`);
      continue;
    }

    // Drop existing target collection if any
    try {
      await tgtCol.drop();
    } catch (_) {}

    // Stream documents in batches of 1,000
    const batchSize = 1000;
    let batch = [];
    let copiedInCol = 0;

    const cursor = srcCol.find({});
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= batchSize) {
        await tgtCol.insertMany(batch, { ordered: false });
        copiedInCol += batch.length;
        batch = [];
        process.stdout.write(`.`);
      }
    }

    if (batch.length > 0) {
      await tgtCol.insertMany(batch, { ordered: false });
      copiedInCol += batch.length;
    }

    // Copy indexes
    try {
      const indexes = await srcCol.indexes();
      const nonIdIndexes = indexes
        .filter((idx) => idx.name !== "_id_")
        .map((idx) => {
          const { v, ns, ...rest } = idx;
          return rest;
        });
      if (nonIdIndexes.length > 0) {
        await tgtCol.createIndexes(nonIdIndexes);
      }
    } catch (idxErr) {
      // Ignore minor index conflicts if any
    }

    totalDocsCopied += copiedInCol;
    console.log(` done (${copiedInCol} docs copied).`);
  }

  console.log(`Finished '${dbName}'! Total documents copied: ${totalDocsCopied}`);
  return totalDocsCopied;
}

async function main() {
  console.log("Connecting to Source (MongoDB Atlas)...");
  const srcClient = new MongoClient(SOURCE_URI);
  await srcClient.connect();
  console.log("Connected to Source successfully.");

  console.log("Connecting to Target (Local MongoDB)...");
  const tgtClient = new MongoClient(TARGET_URI);
  await tgtClient.connect();
  console.log("Connected to Target successfully.");

  try {
    // 1. Dump primary requested database: salesbuster_master_beta
    await copyDatabase(srcClient, tgtClient, MASTER_DB_NAME);

    // 2. Discover active tenant databases from organizations in salesbuster_master_beta
    const orgs = await srcClient
      .db(MASTER_DB_NAME)
      .collection("organizations")
      .find({})
      .toArray();

    const tenantDbs = orgs
      .map((o) => o.tenantDbName)
      .filter(Boolean);

    console.log(`\nDiscovered ${tenantDbs.length} tenant database(s) in organizations:`, tenantDbs);

    // 3. Also copy tenant databases and crm-salesbuster-beta for full operational local copy
    const otherDbs = ["crm-salesbuster-beta", ...tenantDbs];
    const uniqueDbs = [...new Set(otherDbs)];

    for (const dbName of uniqueDbs) {
      try {
        await copyDatabase(srcClient, tgtClient, dbName);
      } catch (err) {
        console.error(`Error copying '${dbName}':`, err.message);
      }
    }

    console.log("\n========================================================");
    console.log("ALL DATA DUMP & TRANSFER COMPLETED SUCCESSFULLY!");
    console.log("========================================================");
  } finally {
    await srcClient.close();
    await tgtClient.close();
  }
}

main().catch((err) => {
  console.error("Migration fatal error:", err);
  process.exit(1);
});
