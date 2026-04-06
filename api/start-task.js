// Vercel Serverless Function — Start Task

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

    // Extract task page ID
    const body = req.body || {};
    const taskPageId = (
      body.page_id ||
      (body.data && body.data.id) ||
      (body.source && body.source.page_id)
    );

    if (!taskPageId) {
      return res.status(400).json({ error: 'Missing page_id in request body.' });
    }

    // Fetch task
    const taskRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, { headers });
    if (!taskRes.ok) throw new Error(`Failed to fetch task: ${await taskRes.text()}`);
    const taskPage = await taskRes.json();
    const props = taskPage.properties;

    const taskName = props['Task List']?.title?.map(t => t.plain_text).join('') || '';
    const currentStatus = props['Task Status']?.status?.name || '';
    const existingAccumulatedMins = props['Accumulated Mins']?.number || 0;

    // QC logic
    const isQcRejection = currentStatus === 'Review Needed';
    const newAccumulatedMins = isQcRejection ? existingAccumulatedMins : 0;

    const now = new Date().toISOString();

    // Update task → In progress
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

    // --- Content Planning → In Production (ONLY on transition) ---
    let contentStatusUpdated = false;

    const isStartingNow = currentStatus !== 'In progress';

    if (taskName === 'Content Planning' && isStartingNow) {
      const contentRelation = props['Content Production']?.relation;

      if (contentRelation && contentRelation.length > 0) {
        const contentPageId = contentRelation[0].id;

        const contentUpdateRes = await fetch(`https://api.notion.com/v1/pages/${contentPageId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            properties: {
              'Content Status': { status: { name: 'In Production' } },
            },
          }),
        });

        if (contentUpdateRes.ok) {
          contentStatusUpdated = true;
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: isQcRejection
        ? `"${taskName}" restarted after QC rejection. Accumulated time preserved (${Math.round(newAccumulatedMins)} mins so far).`
        : `"${taskName}" started. Timer is running.`,
      task: taskName,
      startedAt: now,
      accumulatedMins: newAccumulatedMins,
      isQcRejection,
      contentStatusUpdated,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
