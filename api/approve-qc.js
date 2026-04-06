// Vercel Serverless Function — Approve QC (Enhanced)

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

    // Extract task ID
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

    const taskName      = props['Task List']?.title?.map(t => t.plain_text).join('') || '';
    const currentStatus = props['Task Status']?.status?.name || '';
    const currentOrder  = props['Order']?.number ?? null;
    const contentLinks  = props['Content Production']?.relation || [];

    // Guard
    if (currentStatus !== 'Pending QC Review') {
      return res.status(400).json({
        error: `"${taskName}" is not in Pending QC Review (current: "${currentStatus}").`,
      });
    }

    const now = new Date().toISOString();
    const isPostingTask = taskName === 'Content Posting';

    // --- STEP 1: Update task status ---
    const newStatus = isPostingTask ? 'Ready for Posting' : 'Done';

    const updateRes = await fetch(`https://api.notion.com/v1/pages/${taskPageId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        properties: {
          'Task Status': { status: { name: newStatus } },
        },
      }),
    });

    if (!updateRes.ok) {
      throw new Error(`Failed to update task: ${await updateRes.text()}`);
    }

    let contentUpdate = null;

    // --- STEP 2: If Content Posting → update Content status ---
    if (isPostingTask && contentLinks.length > 0) {
      const contentId = contentLinks[0].id;

      try {
        await fetch(`https://api.notion.com/v1/pages/${contentId}`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            properties: {
              'Content Status': { status: { name: 'Ready for Posting' } },
            },
          }),
        });

        contentUpdate = 'Ready for Posting';
      } catch (e) {
        console.error('Content update failed (non-fatal):', e.message);
      }
    }

    // --- STEP 3: Cascade ONLY if NOT posting task ---
    let cascadeResult = null;

    if (!isPostingTask) {
      try {
        if (contentLinks.length > 0 && currentOrder !== null) {
          const contentProductionId = contentLinks[0].id;

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
                cascadeResult = { nextTask: nextTaskName, status: 'Ready to Work' };
              }
            }
          }
        }
      } catch (err) {
        console.error('Cascade error (non-fatal):', err.message);
      }
    }

    // --- RESPONSE ---
    return res.status(200).json({
      success: true,
      message: isPostingTask
        ? `"${taskName}" QC approved → Ready for Posting. Content updated.`
        : cascadeResult?.nextTask
          ? `"${taskName}" QC approved → "${cascadeResult.nextTask}" unlocked.`
          : `"${taskName}" QC approved.`,
      taskStatus: newStatus,
      contentStatus: contentUpdate,
      nextTask: cascadeResult,
      approvedAt: now,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
