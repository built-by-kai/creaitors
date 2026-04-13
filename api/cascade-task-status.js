// Vercel Serverless Function — Cascade Task Status
// Triggered by a Notion Button on a Task page ("✅ Complete Task")
// Finalizes timer: adds current cycle (Task Started On → now) to Accumulated Mins,
// stores formatted total in Duration Display, marks task Done, cascades next task to Ready to Work
// Only affects tasks linked to the same Content Production page — not globally
// Environment variables: NOTION_API_KEY

const TASKS_DB_ID = '3348b289e31a80dc89e1eb7ba5b49b1a';

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

    // Fetch the current task page
    const taskRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, { headers });
    if (!taskRes.ok) throw new Error(`Failed to fetch task: ${await taskRes.text()}`);
    const taskPage = await taskRes.json();
    const props = taskPage.properties;

    // Get task name, order, and linked Content Production pages
    const taskName = props['Task List']?.title?.map(t => t.plain_text).join('') || '';
    const currentOrder = props['Order']?.number ?? null;
    const contentProductionLinks = props['Content Production']?.relation || [];

    // Compute final duration:
    // If Submit QC already ran, Task Done On is already stamped and Accumulated Mins is final —
    // do NOT add more time (QC review wait time should not count).
    // If task skipped QC entirely, Task Done On is null — compute from Task Started On → now.
    const startedOnRaw = props['Task Started On']?.date?.start || null;
    const doneOnRaw = props['Task Done On']?.date?.start || null;
    const accumulatedMins = props['Accumulated Mins']?.number || 0;
    const existingDisplay = props['Duration Display']?.rich_text?.map(t => t.plain_text).join('') || '';
    const now = new Date().toISOString();

    let totalMins = accumulatedMins;
    let durationDisplay = existingDisplay;

    // Only compute new time if Submit QC has NOT already finalized it
    const timerAlreadyFinalized = !!doneOnRaw && !!existingDisplay;
    if (!timerAlreadyFinalized && startedOnRaw) {
      const currentCycleMins = (new Date(now).getTime() - new Date(startedOnRaw).getTime()) / 60000;
      totalMins += currentCycleMins;
      durationDisplay = totalMins > 0 ? formatDuration(totalMins) : '';
    }

    // Step 1: Always mark current task as Done, stamp Task Done On = now, store final duration
    const doneRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        properties: {
          'Task Status':       { status: { name: 'Done' } },
          'Task Done On':      { date: { start: now } },
          'Accumulated Mins':  { number: totalMins },
          'Duration Display':  { rich_text: durationDisplay ? [{ type: 'text', text: { content: durationDisplay } }] : [] },
        },
      }),
    });
    if (!doneRes.ok) throw new Error(`Failed to mark task as Done: ${await doneRes.text()}`);

    // Step 2: Try to cascade to next task (only if Content Production + Order are set)
    if (contentProductionLinks.length === 0) {
      return res.status(200).json({
        success: true,
        message: `"${taskName}" marked Done (${durationDisplay || 'no timer'}). No Content Production linked — cascade skipped.`,
        currentTask: taskName,
        doneAt: now,
        durationDisplay,
      });
    }

    if (currentOrder === null) {
      return res.status(200).json({
        success: true,
        message: `"${taskName}" marked Done (${durationDisplay || 'no timer'}). No Order number set — cascade skipped.`,
        currentTask: taskName,
        doneAt: now,
        durationDisplay,
      });
    }

    const contentProductionId = contentProductionLinks[0].id;

    // Step 3: Find all tasks linked to the same Content Production page
    const queryRes = await fetch(`https://api.notion.com/v1/databases/${TASKS_DB_ID}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        filter: {
          property: 'Content Production',
          relation: { contains: contentProductionId },
        },
      }),
    });
    if (!queryRes.ok) throw new Error(`Failed to query tasks: ${await queryRes.text()}`);
    const queryData = await queryRes.json();
    const allTasks = queryData.results;

    // Step 4: Find the next task by Order number
    const nextOrder = currentOrder + 1;
    const nextTask = allTasks.find(t => t.properties['Order']?.number === nextOrder);

    if (!nextTask) {
      // Last task — update Content Production status to Ready to Post
      try {
        await fetch(`https://api.notion.com/v1/pages/${contentProductionId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            properties: {
              'Content Status': { status: { name: 'Ready for Posting' } },
            },
          }),
        });
      } catch (e) {
        console.error('Failed to update Content Production status (non-fatal):', e.message);
      }

      return res.status(200).json({
        success: true,
        message: `"${taskName}" marked Done — all tasks complete. Content moved to Ready to Post.`,
        currentTask: taskName,
        currentOrder,
        doneAt: now,
        durationDisplay,
        contentStatus: 'Ready for Posting',
      });
    }

    const nextTaskName = nextTask.properties['Task List']?.title?.map(t => t.plain_text).join('') || '';

    // Step 5: Set next task to Ready to Work
    const readyRes = await fetch(`https://api.notion.com/v1/pages/${nextTask.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        properties: {
          'Task Status': { status: { name: 'Ready to Work' } },
        },
      }),
    });
    if (!readyRes.ok) throw new Error(`Failed to update next task: ${await readyRes.text()}`);

    return res.status(200).json({
      success: true,
      message: `"${taskName}" marked Done (${durationDisplay || 'no timer'}) → "${nextTaskName}" is now Ready to Work.`,
      currentTask: { name: taskName, order: currentOrder, status: 'Done', doneAt: now, durationDisplay },
      nextTask: { name: nextTaskName, order: nextOrder, status: 'Ready to Work' },
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
