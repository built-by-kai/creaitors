// Vercel Serverless Function — Approve QC
// Triggered by a Notion Button on a Task page ("✅ Approve QC")
// Guards: task must be in Pending QC Review
// Marks current task as Done (preserves timer already set by Submit QC, no double-counting)
// Cascades next task (by Order) on same Content Production page → Ready to Work
// Cascade failure is non-fatal — task is always marked Done on success
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

    // Step 1: Mark task Done — this is the critical action.
    // Preserve existing timer: submit-qc already stamped Task Done On, don't overwrite it.
    const doneRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        properties: {
          'Task Status': { status: { name: 'Done' } },
        },
      }),
    });
    if (!doneRes.ok) {
      throw new Error(`Failed to mark task as Done: ${await doneRes.text()}`);
    }

    // Step 2: Cascade — try to unlock next task. Non-fatal if this fails.
    let cascadeResult = null;
    try {
      if (contentLinks.length > 0 && currentOrder !== null) {
        const contentProductionId = contentLinks[0].id;

        // Find all tasks linked to the same Content Production page
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
          const nextTask = allTasks.find(t => t.properties['Order']?.number === currentOrder + 1);

          if (nextTask) {
            // Unlock next task
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
          } else {
            // No next task — this was the last one. Move content to Scheduled / Distribution.
            await fetch(`https://api.notion.com/v1/pages/${contentProductionId}`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({
                properties: {
                  'Content Status': { status: { name: 'Scheduled / Distribution' } },
                },
              }),
            });
            cascadeResult = { contentStatus: 'Scheduled / Distribution', lastTask: true };
          }
        }
      }
    } catch (cascadeErr) {
      // Cascade failure is non-fatal — log it but don't fail the whole request
      console.error('Cascade error (non-fatal):', cascadeErr.message);
    }

    const message = cascadeResult?.lastTask
      ? `"${taskName}" QC approved ✓ — all tasks complete. Content moved to Scheduled / Distribution.`
      : cascadeResult?.nextTask
        ? `"${taskName}" QC approved ✓ → "${cascadeResult.nextTask}" is now Ready to Work.`
        : `"${taskName}" QC approved and marked Done.`;

    return res.status(200).json({
      success: true,
      message,
      currentTask: { name: taskName, order: currentOrder, status: 'Done', approvedAt: now },
      ...(cascadeResult ? { nextTask: cascadeResult } : {}),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
