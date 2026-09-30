import mongoose from 'mongoose';

async function updateRecordingUrls() {
  const uri = 'mongodb+srv://saiteja:Saiteja1920@task-management.rzoshdy.mongodb.net/sb_tenant_infasta_demo_cb79c7?appName=crm-salesbuster-beta';
  const conn = await mongoose.connect(uri);
  const db = conn.connection.db;

  const backendBase = 'https://betaapi.salesbuster.ai';

  // 1. Update CallLogs
  const callLogs = await db.collection('calllogs').find({
    recordingUrl: { $regex: '^/uploads/' }
  }).toArray();

  console.log(`Found ${callLogs.length} call log(s) with relative recordingUrl.`);
  for (const log of callLogs) {
    const newUrl = backendBase + log.recordingUrl;
    await db.collection('calllogs').updateOne(
      { _id: log._id },
      { $set: { recordingUrl: newUrl } }
    );
    console.log(`Updated CallLog [${log.cmiuid}] -> ${newUrl}`);
  }

  // 2. Update Leads recordings array
  const leads = await db.collection('leads').find({
    'recordings.url': { $regex: '^/uploads/' }
  }).toArray();

  console.log(`Found ${leads.length} lead(s) with relative recording URLs.`);
  for (const lead of leads) {
    const updatedRecordings = (lead.recordings || []).map(r => {
      if (r.url && r.url.startsWith('/uploads/')) {
        return { ...r, url: backendBase + r.url };
      }
      return r;
    });
    await db.collection('leads').updateOne(
      { _id: lead._id },
      { $set: { recordings: updatedRecordings } }
    );
    console.log(`Updated lead recordings for ${lead.name || lead._id}`);
  }

  // 3. Verify updated CallLogs
  const allLogs = await db.collection('calllogs').find({
    recordingUrl: { $exists: true, $ne: '' }
  }).toArray();

  console.log('\n--- VERIFIED CALL LOGS IN DATABASE ---');
  for (const log of allLogs) {
    console.log({
      id: log._id.toString(),
      cmiuid: log.cmiuid,
      status: log.status,
      recordingFilename: log.recordingFilename,
      recordingUrl: log.recordingUrl,
      recordingSize: log.recordingSize
    });
  }

  await mongoose.disconnect();
}

updateRecordingUrls().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
