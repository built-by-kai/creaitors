// Vercel Serverless Function — Employee Stats
// Queries Tasks DB only (already shared with integration),
// fetches individual employee pages by ID, groups stats per employee.

const TASKS_DB_ID     = '3348b289e31a80dc89e1eb7ba5b49b1a';
const EMPLOYEES_DB_ID = 'bc5b99b59468498e8a294149d6f03134';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const NOTION_KEY = process.env.NOTION_API_KEY;
    if (!NOTION_KEY) return res.status(500).json({ error: 'NOTION_API_KEY not set' });

    const headers = {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    // ── 1. Fetch all tasks (paginate) ──────────────────────────────
    let allTasks = [], cursor;
    do {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;
      const r = await fetch(`https://api.notion.com/v1/databases/${TASKS_DB_ID}/query`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`Tasks query failed: ${await r.text()}`);
      const d = await r.json();
      allTasks = allTasks.concat(d.results);
      cursor = d.has_more ? d.next_cursor : undefined;
    } while (cursor);

    // ── 2. Try to load all employees from Employee Hub (if shared) ──
    const empMap = {};
    const empIdSet = new Set();

    try {
      const empRes = await fetch(`https://api.notion.com/v1/databases/${EMPLOYEES_DB_ID}/query`, {
        method: 'POST', headers, body: JSON.stringify({ page_size: 100 }),
      });
      if (empRes.ok) {
        const empData = await empRes.json();
        empData.results.forEach(emp => {
          const p = emp.properties;
          empIdSet.add(emp.id);
          empMap[emp.id] = {
            name:   p['Name']?.title?.map(t => t.plain_text).join('') || 'Unknown',
            role:   p['Role']?.select?.name || '',
            dept:   p['Department']?.select?.name || '',
            status: p['Status']?.select?.name || 'Active',
            email:  p['Email']?.email || '',
            phone:  p['Phone']?.phone_number || '',
          };
        });
      }
    } catch (_) { /* Employee Hub not shared yet — will fall back to task-derived list */ }

    // Also collect any employee IDs found in tasks (catches employees not in hub)
    allTasks.forEach(task => {
      const assigned = task.properties['Assigned To']?.relation || [];
      assigned.forEach(r => empIdSet.add(r.id));
    });

    // ── 3. Fetch each employee page ────────────────────────────────
    await Promise.all([...empIdSet].map(async empId => {
      try {
        const r = await fetch(`https://api.notion.com/v1/pages/${empId}`, { headers });
        if (!r.ok) {
          empMap[empId] = { name: 'Unknown', role: '', dept: '', status: 'Active', email: '', phone: '' };
          return;
        }
        const p = (await r.json()).properties;
        empMap[empId] = {
          name:   p['Name']?.title?.map(t => t.plain_text).join('') || 'Unknown',
          role:   p['Role']?.select?.name || '',
          dept:   p['Department']?.select?.name || '',
          status: p['Status']?.select?.name || 'Active',
          email:  p['Email']?.email || '',
          phone:  p['Phone']?.phone_number || '',
          tasks:  [],
        };
      } catch {
        empMap[empId] = { name: 'Unknown', role: '', dept: '', status: 'Active', email: '', phone: '', tasks: [] };
      }
    }));

    // ── 4. Bucket tasks per employee ───────────────────────────────
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const statsMap = {};
    [...empIdSet].forEach(id => {
      statsMap[id] = { done: 0, inProgress: 0, pendingQC: 0, reviewNeeded: 0, notStarted: 0, overdue: 0, dueToday: 0, totalMins: 0, total: 0 };
    });

    allTasks.forEach(task => {
      const tp = task.properties;
      const taskStatus = tp['Task Status']?.status?.name || '';
      const dueRaw     = tp['Task Due']?.date?.start || null;
      const accMins    = tp['Accumulated Mins']?.number || 0;
      const assigned   = tp['Assigned To']?.relation || [];

      assigned.forEach(({ id: empId }) => {
        if (!statsMap[empId]) return;
        const s = statsMap[empId];
        s.total++;
        s.totalMins += accMins;

        if      (taskStatus === 'Done')               s.done++;
        else if (taskStatus === 'In progress')        s.inProgress++;
        else if (taskStatus === 'Pending QC Review')  s.pendingQC++;
        else if (taskStatus === 'Review Needed')      s.reviewNeeded++;
        else                                          s.notStarted++;

        if (dueRaw && taskStatus !== 'Done') {
          const due = new Date(dueRaw); due.setHours(0,0,0,0);
          if      (due < today)                      s.overdue++;
          else if (due.getTime() === today.getTime()) s.dueToday++;
        }
      });
    });

    // ── 5. Build result array ──────────────────────────────────────
    const employees = [...empIdSet].map(id => {
      const s = statsMap[id];
      return {
        id,
        ...empMap[id],
        stats: { ...s, totalHrs: Math.round((s.totalMins / 60) * 10) / 10 },
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    return res.status(200).json({ employees, generatedAt: new Date().toISOString() });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
