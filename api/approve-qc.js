// Vercel Serverless Function — Approve QC
// Triggered by a Notion Button on a Task page ("✅ Approve QC")
// Guards: task must be in Pending QC Review
// If last task → Task Status = "Ready for Posting", Content Production = "Ready to Post"
// If not last task → Task Status = "Done", next task (by Order) = "Ready to Work"
// Cascade failure is non-fatal
// Environment variables: NOTION_API_KEY

const TASKS_DB_ID = '3348b289e31a80dc89e1eb7ba5b49b1a';

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

    const taskName      = props['Task List']?.title?.map(t => t.plain_text).join('') || '';
    const currentStatus = props['Task Status']?.status?.name || '';
    const currentOrder  = props['Order']?.number ?? null;
    const contentLinks  = props['Content Production']?.relation || [];

    // Guard: only run if task is in Pending QC Review
    if (currentStatus !== 'Pending QC Review') {
      return res.status(400).json({
        error: `"${taskName}" is not in Pending QC Review (current: "${currentStatus}"). Cannot approve.`,
      });
    }

    const now = new Date().toISOString();

    // Step 1: Cascade check — figure out if this is the last task BEFORE deciding status
    let nextTask = null;
    let contentProductionId = contentLinks[0]?.id || null;

    try {
      if (contentProductionId && currentOrder !== null) {
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
        if (queryRes.ok) {
          const allTasks = (await queryRes.json()).results;
          nextTask = allTasks.find(t => t.properties['Order']?.number === currentOrder + 1) || null;
        }
      }
    } catch (e) {
      console.error('Cascade check error (non-fatal):', e.message);
    }

    const isLastTask = contentProductionId && currentOrder !== null && nextTask === null;

    // Step 2: Set task status based on position in workflow
    // Last task → Ready for Posting (content still needs to be published)
    // Any other task → Done
    const newTaskStatus = isLastTask ? 'Ready for Posting' : 'Done';

    const updateRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        properties: {
          'Task Status': { status: { name: newTaskStatus } },
        },
      }),
    });
    if (!updateRes.ok) {
      throw new Error(`Failed to update task status: ${await updateRes.text()}`);
    }

    // Step 3: Cascade actions — non-fatal
    let cascadeResult = null;
    try {
      if (isLastTask) {
        // Last task QC approved → Content Production moves to Ready to Post
        await fetch(`https://api.notion.com/v1/pages/${contentProductionId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            properties: {
              'Content Status': { status: { name: 'Ready for Posting' } },
            },
          }),
        });
        cascadeResult = { contentStatus: 'Ready for Posting', lastTask: true };
      } else if (nextTask) {
        // Not last task — unlock the next one
        const nextTaskName = nextTask.properties['Task List']?.title?.map(t => t.plain_text).join('') || '';
        const readyRes = await fetch(`https://api.notion.com/v1/pages/${nextTask.id}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            properties: {
              'Task Status': { status: { name: 'Ready to Work' } },
            },
          }),
        });
        if (readyRes.ok) {
          cascadeResult = { nextTask: nextTaskName, order: currentOrder + 1, status: 'Ready to Work' };
        }
      }
    } catch (cascadeErr) {
      console.error('Cascade error (non-fatal):', cascadeErr.message);
    }

    const message = cascadeResult?.lastTask
      ? `"${taskName}" QC approved ✓ — ready for posting. Content moved to Ready for Posting.`
      : cascadeResult?.nextTask
        ? `"${taskName}" QC approved ✓ → "${cascadeResult.nextTask}" is now Ready to Work.`
        : `"${taskName}" QC approved and marked ${newTaskStatus}.`;

    return res.status(200).json({
      success: true,
      message,
      currentTask: { name: taskName, order: currentOrder, status: newTaskStatus, approvedAt: now },
      ...(cascadeResult ? { cascade: cascadeResult } : {}),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
