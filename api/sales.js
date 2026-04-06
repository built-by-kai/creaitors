// Vercel Serverless Function — Sales Dashboard Stats
// Queries Sales CRM - Pipeline for active leads, follow-ups, won/lost
// Environment variables: NOTION_API_KEY, NOTION_DATABASE_ID

const DATABASE_ID = process.env.NOTION_DATABASE_ID || '3188b289e31a81da8939cb08d15be667';

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

    let allResults = [];
    let hasMore = true;
    let startCursor;

    while (hasMore) {
      const body = { page_size: 100 };
      if (startCursor) body.start_cursor = startCursor;

      const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.text();
        return res.status(response.status).json({ error: err });
      }

      const data = await response.json();
      allResults = allResults.concat(data.results);
      hasMore = data.has_more;
      startCursor = data.next_cursor;
    }

    const deals = allResults;
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const getStatus = p => p?.type === 'status' ? p.status?.name : null;
    const getTitle  = p => p?.type === 'title' ? (p.title || []).map(t => t.plain_text).join('') : '';
    const getText   = p => p?.type === 'rich_text' ? (p.rich_text || []).map(t => t.plain_text).join('') : '';
    const getDate   = p => p?.type === 'date' ? p.date?.start : null;
    const getSelect = p => p?.type === 'select' ? p.select?.name : null;

    const activeLeads = [];
    const followUpsDue = [];
    const wonThisMonth = [];
    const lostThisMonth = [];

    for (const page of deals) {
      const props = page.properties;
      const funnel   = getStatus(props['Funnel']);
      const name     = getTitle(props['Name']);
      const company  = getText(props['PIC Name']) || '';
      const followUp = getDate(props['Next Follow-up']);

      if (!funnel) continue;

      // Active leads (not closed)
      if (funnel !== 'Closed-Won' && funnel !== 'Closed-Lost') {
        activeLeads.push({ name, company, funnel });

        // Follow-ups due today or overdue
        if (followUp && followUp <= todayStr) {
          followUpsDue.push({ name, company, nextFollowUp: followUp });
        }
      }

      // Won this month
      if (funnel === 'Closed-Won') {
        const created = new Date(page.created_time);
        if (created.getMonth() === currentMonth && created.getFullYear() === currentYear) {
          wonThisMonth.push({ name, company });
        }
      }

      // Lost this month
      if (funnel === 'Closed-Lost') {
        const created = new Date(page.created_time);
        if (created.getMonth() === currentMonth && created.getFullYear() === currentYear) {
          lostThisMonth.push({ name, company });
        }
      }
    }

    // Sort follow-ups by date ascending (most overdue first)
    followUpsDue.sort((a, b) => a.nextFollowUp.localeCompare(b.nextFollowUp));

    return res.status(200).json({
      activeLeads: { count: activeLeads.length, leads: activeLeads },
      followUpsDue: { count: followUpsDue.length, leads: followUpsDue },
      wonThisMonth: { count: wonThisMonth.length, deals: wonThisMonth },
      lostThisMonth: { count: lostThisMonth.length, deals: lostThisMonth },
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
