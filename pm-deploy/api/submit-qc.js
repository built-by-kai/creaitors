// Vercel Serverless Function — Submit QC
// Triggered by a Notion Button on a Task page ("📋 Submit QC")
// Computes current cycle duration (Task Started On → now), adds to Accumulated Mins,
// stores formatted total in Duration Display, stamps Task Done On, sets status = Pending QC Review
// Environment variables: NOTION_API_KEY

function formatDuration(minutes) {
  minutes = Math.abs(Math.round(minutes));
  if (minutes < 60) return `${minutes} mins`;
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  if (minutes < 10080) {
    const d = Math.floor(minutes / 1440);
    const h = Math.floor((minutes % 1440) / 60);
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
  }
  const w = Math.floor(minutes / 10080);
  const d = Math.floor((minutes % 10080) / 1440);
  return d > 0 ? `${w}w ${d}d` : `${w}w`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  try {
    const NOTION_KEY = process.env.NOTION_API_KEY;
    if (!NOTION_KEY) return res.status(500).json({ error: 'NOTION_API_KEY not set' });

    const headers = {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    // Extract task page ID from Notion button webhook payload
    const body = req.body || {};
    const taskPageId = (
      body.page_id ||
      (body.data && body.data.id) ||
      (body.source && body.source.page_id)
    );

    if (!taskPageId) {
      return res.status(400).json({ error: 'Missing page_id in request body.' });
    }

    // Fetch current task page
    const taskRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, { headers });
    if (!taskRes.ok) throw new Error(`Failed to fetch task: ${await taskRes.text()}`);
    const taskPage = await taskRes.json();
    const props = taskPage.properties;

    const taskName = props['Task List']?.title?.map(t => t.plain_text).join('') || '';
    const startedOnRaw = props['Task Started On']?.date?.start || null;
    const accumulatedMins = props['Accumulated Mins']?.number || 0;

    const now = new Date().toISOString();

    // Compute current cycle duration (Task Started On → now)
    const currentCycleMins = startedOnRaw
      ? (new Date(now).getTime() - new Date(startedOnRaw).getTime()) / 60000
      : 0;

    // Total time = all previous cycles + this cycle
    const totalMins = accumulatedMins + currentCycleMins;
    const durationDisplay = formatDuration(totalMins);

    // Patch: store total accumulated mins, formatted display, stamp done, set Pending QC Review
    const updateRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        properties: {
          'Task Status':       { status: { name: 'Pending QC Review' } },
          'Task Done On':      { date: { start: now } },
          'Accumulated Mins':  { number: totalMins },
          'Duration Display':  { rich_text: [{ type: 'text', text: { content: durationDisplay } }] },
        },
      }),
    });

    if (!updateRes.ok) throw new Error(`Failed to submit QC: ${await updateRes.text()}`);

    return res.status(200).json({
      success: true,
      message: `"${taskName}" submitted for QC review. Total time: ${durationDisplay}.`,
      task: taskName,
      submittedAt: now,
      currentCycleMins: Math.round(currentCycleMins),
      totalMins: Math.round(totalMins),
      durationDisplay,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
