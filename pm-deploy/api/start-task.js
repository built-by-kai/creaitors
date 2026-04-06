// Vercel Serverless Function — Start Task
// Triggered by a Notion Button on a Task page ("▶️ Start Task")
// Sets Task Started On = now, clears Task Done On + Duration Display, Task Status = In Progress
// If current Task Status is "Review Needed" → keeps Accumulated Mins (continuation after QC rejection)
// Otherwise → resets Accumulated Mins to 0 (fresh start)
// Environment variables: NOTION_API_KEY

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

    // Fetch current task page to read Task Status and Accumulated Mins
    const taskRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, { headers });
    if (!taskRes.ok) throw new Error(`Failed to fetch task: ${await taskRes.text()}`);
    const taskPage = await taskRes.json();
    const props = taskPage.properties;

    const taskName = props['Task List']?.title?.map(t => t.plain_text).join('') || '';
    const currentStatus = props['Task Status']?.status?.name || '';
    const existingAccumulatedMins = props['Accumulated Mins']?.number || 0;

    // If restarting after QC rejection, preserve accumulated time; otherwise fresh start
    const isQcRejection = currentStatus === 'Review Needed';
    const newAccumulatedMins = isQcRejection ? existingAccumulatedMins : 0;

    const now = new Date().toISOString();

    // Patch: stamp Task Started On, clear Task Done On + Duration Display, set In Progress
    // Reset or preserve Accumulated Mins based on whether this is a QC rejection restart
    const updateRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        properties: {
          'Task Started On':   { date: { start: now } },
          'Task Done On':      { date: null },
          'Duration Display':  { rich_text: [] },
          'Task Status':       { status: { name: 'In progress' } },
          'Accumulated Mins':  { number: newAccumulatedMins },
        },
      }),
    });

    if (!updateRes.ok) throw new Error(`Failed to start task: ${await updateRes.text()}`);

    return res.status(200).json({
      success: true,
      message: isQcRejection
        ? `"${taskName}" restarted after QC rejection. Accumulated time preserved (${Math.round(newAccumulatedMins)} mins so far).`
        : `"${taskName}" started. Timer is running.`,
      task: taskName,
      startedAt: now,
      accumulatedMins: newAccumulatedMins,
      isQcRejection,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
