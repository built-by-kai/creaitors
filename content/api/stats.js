// Vercel Serverless Function — Content Production Stats
// Returns broad overview stats for the stat card widget

const CONTENT_DB_ID  = '3188b289e31a80e39bbbf1c01ffdd56b';
const TASKS_DB_ID    = '3348b289e31a80dc89e1eb7ba5b49b1a';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  try {
    const NOTION_KEY = process.env.NOTION_API_KEY;
    if (!NOTION_KEY) return res.status(500).json({ error: 'NOTION_API_KEY not set' });

    const headers = {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    async function queryAll(dbId, filter) {
      let all = [], hasMore = true, cursor;
      while (hasMore) {
        const body = { page_size: 100 };
        if (filter) body.filter = filter;
        if (cursor) body.start_cursor = cursor;
        const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
          method: 'POST', headers, body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error(`DB ${dbId} error (${r.status}): ${await r.text()}`);
        const d = await r.json();
        all = all.concat(d.results);
        hasMore = d.has_more;
        cursor = d.next_cursor;
      }
      return all;
    }

    const getStatus = p => p?.type === 'status' ? p.status?.name : null;
    const getDate   = p => p?.type === 'date'   ? p.date?.start : null;

    const now       = new Date();
    const todayStr  = now.toISOString().slice(0, 10);
    const in7Days   = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);

    // Fetch all active content (not Done) and all active tasks (not Done) in parallel
    const [contentPages, taskPages] = await Promise.all([
      queryAll(CONTENT_DB_ID, {
        and: [
          {
            or: [
              { property: 'Content Status', status: { does_not_equal: 'Done' } },
            ]
          }
        ]
      }).catch(() => queryAll(CONTENT_DB_ID)), // fallback: fetch all
      queryAll(TASKS_DB_ID).catch(() => []),
    ]);

    // ── Content stats ──────────────────────────────────────────
    const ACTIVE_STATUSES = ['Pre-Production', 'In-Production', 'Revision Needed', 'Final QC Review', 'Scripting', 'Recording', 'Editing'];

    let contentInMotion   = 0;
    let contentRevision   = 0;
    let contentQC         = 0;
    let contentOverdue    = 0;
    let contentDueThisWeek= 0;

    for (const page of contentPages) {
      const p      = page.properties;
      const status = getStatus(p['Content Status']);
      if (!status || status === 'Done') continue;

      if (ACTIVE_STATUSES.includes(status)) contentInMotion++;
      if (status === 'Revision Needed')     contentRevision++;
      if (status === 'Final QC Review')     contentQC++;

      const deadline = getDate(p['Content Due']) || getDate(p['Publish Due']);
      if (deadline) {
        if (deadline < todayStr) contentOverdue++;
        else if (deadline <= in7Days) contentDueThisWeek++;
      }
    }

    // ── Task stats ─────────────────────────────────────────────
    const TASK_ACTIVE = ['Not started', 'Waiting', 'Ready to Work', 'Pending QC Review', 'Review Needed', 'In Progress'];

    let tasksTotal     = 0;
    let tasksWaiting   = 0;
    let tasksInProgress= 0;
    let tasksQC        = 0;
    let tasksRevision  = 0;
    let tasksDueThisWeek = 0;
    let tasksOverdue   = 0;

    for (const page of taskPages) {
      const p      = page.properties;
      const status = getStatus(p['Task Status']);
      if (!status || status === 'Done') continue;

      // Skip tasks not linked to any content production
      const contentRel = p['Content Production']?.relation || [];
      if (contentRel.length === 0) continue;

      tasksTotal++;
      if (status === 'Waiting')              tasksWaiting++;
      if (status === 'Ready to Work' || status === 'In Progress' || status === 'Not started') tasksInProgress++;
      if (status === 'Pending QC Review')    tasksQC++;
      if (status === 'Review Needed')        tasksRevision++;

      const dueDate = getDate(p['Task Due']);
      if (dueDate) {
        if (dueDate < todayStr)      tasksOverdue++;
        else if (dueDate <= in7Days) tasksDueThisWeek++;
      }
    }

    return res.status(200).json({
      // Card 1: Content in Motion
      contentInMotion,
      contentBreakdown: { revision: contentRevision, qc: contentQC },

      // Card 2: Active Tasks
      tasksTotal,
      tasksBreakdown: { waiting: tasksWaiting, inProgress: tasksInProgress, qc: tasksQC, revision: tasksRevision },

      // Card 3: Due This Week
      dueThisWeek: contentDueThisWeek + tasksDueThisWeek,
      dueBreakdown: { content: contentDueThisWeek, tasks: tasksDueThisWeek },

      // Card 4: Needs Attention
      needsAttention: contentRevision + contentQC + tasksQC + tasksRevision + contentOverdue + tasksOverdue,
      attentionBreakdown: {
        overdue: contentOverdue + tasksOverdue,
        revision: contentRevision + tasksRevision,
        qc: contentQC + tasksQC,
      },
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
