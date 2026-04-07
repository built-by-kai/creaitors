// Vercel Serverless Function — Bottlenecks (Needs Action)
// Queries Content Production DB + Tasks DB
// Employee Hub DB for name resolution

const CONTENT_DB_ID  = '3188b289e31a80e39bbbf1c01ffdd56b';
const TASKS_DB_ID    = '3348b289e31a80dc89e1eb7ba5b49b1a';
const EMPLOYEE_DB_ID = 'bc5b99b59468498e8a294149d6f03134';

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

    async function fetchPage(id) {
      const r = await fetch(`https://api.notion.com/v1/pages/${id}`, { headers });
      if (!r.ok) return null;
      return r.json();
    }

    const getTitle       = p => p?.type === 'title'        ? p.title?.map(t => t.plain_text).join('') : '';
    const getStatus      = p => p?.type === 'status'       ? p.status?.name : null;
    const getDate        = p => p?.type === 'date'         ? p.date?.start  : null;
    const getMultiSelect = p => p?.type === 'multi_select' ? p.multi_select?.map(s => s.name) : [];
    const getRelIds      = p => p?.type === 'relation'     ? (p.relation || []).map(r => r.id) : [];
    const getRollupText  = p => {
      if (!p || p.type !== 'rollup') return null;
      const arr = p.rollup?.array || [];
      if (!arr.length) return null;
      const first = arr[0];
      return first.title?.map(t => t.plain_text).join('') ||
             first.select?.name || first.status?.name || null;
    };

    const now      = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Fetch all three DBs in parallel
    const [contentPages, taskPages, empPages] = await Promise.all([
      queryAll(CONTENT_DB_ID, {
        or: [
          { property: 'Content Status', status: { equals: 'Revision Needed' } },
          { property: 'Content Status', status: { equals: 'Final QC Review' } },
          { property: 'Content Status', status: { equals: 'In Production' } },
          { property: 'Content Status', status: { equals: 'Pre-Production' } },
        ],
      }),
      queryAll(TASKS_DB_ID, {
        or: [
          { property: 'Task Status', status: { equals: 'Pending QC Review' } },
          { property: 'Task Status', status: { equals: 'Review Needed' } },
        ],
      }),
      queryAll(EMPLOYEE_DB_ID).catch(() => []),
    ]);

    // Build employee name map: id -> first name
    const empNames = {};
    for (const e of empPages) {
      const titleProp = Object.values(e.properties).find(p => p.type === 'title');
      const name = getTitle(titleProp);
      if (name) empNames[e.id] = name.split(' ')[0];
    }
    function resolveNames(ids) {
      return ids.map(id => empNames[id]).filter(Boolean);
    }

    // Batch-resolve campaign + client page names
    const pageIdSet = new Set();
    for (const p of contentPages) {
      getRelIds(p.properties['Campaign']).slice(0, 1).forEach(id => pageIdSet.add(id));
      getRelIds(p.properties['Client']).slice(0, 1).forEach(id => pageIdSet.add(id));
    }
    const pageNameCache = {};
    await Promise.all(Array.from(pageIdSet).map(async id => {
      const page = await fetchPage(id).catch(() => null);
      if (!page) return;
      for (const prop of Object.values(page.properties)) {
        if (prop.type === 'title' && prop.title?.length) {
          pageNameCache[id] = prop.title.map(t => t.plain_text).join('');
          break;
        }
      }
    }));

    const contentItems = [];
    const taskItems    = [];

    // Content Production bottlenecks
    for (const page of contentPages) {
      const p        = page.properties;
      const status   = getStatus(p['Content Status']);
      const title    = getTitle(p['Content Title']) || 'Untitled';
      const deadline = getDate(p['Content Due']) || getDate(p['Publish Due']);
      const channel  = getMultiSelect(p['Channel']);
      const type     = getMultiSelect(p['Content Type']);

      const people   = resolveNames(getRelIds(p['Assigned By']));
      const clientId = getRelIds(p['Client'])[0];
      const client   = clientId ? (pageNameCache[clientId] || null) : null;

      const isOverdue  = deadline && deadline < todayStr;
      const isDueToday = deadline === todayStr;
      const daysOverdue = isOverdue ? Math.floor((now - new Date(deadline)) / 86400000) : 0;

      const reasons = [];
      if (status === 'Revision Needed') reasons.push('Revision');
      if (status === 'Final QC Review') reasons.push('QC Review');
      if (isOverdue)  reasons.push('Overdue');
      if (isDueToday) reasons.push('Due Today');

      if (reasons.length === 0) continue;

      contentItems.push({ title, status, deadline, daysOverdue, channel, type, people, client, reasons, url: page.url });
    }

    // Task QC bottlenecks
    for (const page of taskPages) {
      const p       = page.properties;
      const title   = getTitle(p['Task List']) || 'Untitled Task';
      const status  = getStatus(p['Task Status']);
      const dueDate = getDate(p['Task Due']);
      const qcNotes = p['QC Notes']?.rich_text?.map(t => t.plain_text).join('') || null;
      const people  = resolveNames(getRelIds(p['Assigned To']));
      const campaign = getRollupText(p['Campaign']) || null;

      const isOverdue   = dueDate && dueDate < todayStr;
      const isDueToday  = dueDate === todayStr;
      const daysOverdue = isOverdue ? Math.floor((now - new Date(dueDate)) / 86400000) : 0;

      const reasons = [];
      if (status === 'Pending QC Review') reasons.push('Pending QC');
      if (status === 'Review Needed')     reasons.push('Revision');
      if (isOverdue)  reasons.push('Overdue');
      if (isDueToday) reasons.push('Due Today');

      taskItems.push({ title, status, deadline: dueDate, daysOverdue, people, campaign, qcNotes, reasons, url: page.url });
    }

    const sortFn = (a, b) => {
      const aOver = a.reasons.includes('Overdue') ? 1 : 0;
      const bOver = b.reasons.includes('Overdue') ? 1 : 0;
      if (aOver !== bOver) return bOver - aOver;
      if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
      return (b.reasons.includes('Due Today') ? 1 : 0) - (a.reasons.includes('Due Today') ? 1 : 0);
    };
    contentItems.sort(sortFn);
    taskItems.sort(sortFn);

    const all = [...contentItems, ...taskItems];
    return res.status(200).json({
      total:        all.length,
      contentCount: contentItems.length,
      taskCount:    taskItems.length,
      overdue:      all.filter(i => i.reasons.includes('Overdue')).length,
      dueToday:     all.filter(i => i.reasons.includes('Due Today')).length,
      contentQC:    contentItems.filter(i => i.reasons.includes('QC Review')).length,
      taskQC:       taskItems.filter(i => i.reasons.includes('Pending QC')).length,
      revisions:    all.filter(i => i.reasons.includes('Revision')).length,
      content: contentItems,
      tasks:   taskItems,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
