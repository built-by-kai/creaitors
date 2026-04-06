// Vercel Serverless Function — Project Manager Stats
// Queries Content Production DB only
// Environment variables: NOTION_API_KEY

const CONTENT_DB_ID = '3188b289e31a80e39bbbf1c01ffdd56b';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  try {
    const NOTION_KEY = process.env.NOTION_API_KEY;
    if (!NOTION_KEY) {
      return res.status(500).json({ error: 'NOTION_API_KEY not set' });
    }

    const headers = {
      'Authorization': `Bearer ${NOTION_KEY}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };

    // Query all pages from a Notion database
    async function queryAll(dbId, filter) {
      let allResults = [];
      let hasMore = true;
      let startCursor = undefined;

      while (hasMore) {
        const body = { page_size: 100 };
        if (startCursor) body.start_cursor = startCursor;
        if (filter) body.filter = filter;

        const response = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`Notion API error (${response.status}): ${err}`);
        }

        const data = await response.json();
        allResults = allResults.concat(data.results);
        hasMore = data.has_more;
        startCursor = data.next_cursor;
      }
      return allResults;
    }

    // Property helpers
    const getStatus = (prop) => {
      if (!prop || prop.type !== 'status' || !prop.status) return null;
      return prop.status.name;
    };
    const getTitle = (prop) => {
      if (!prop || prop.type !== 'title' || !prop.title || !prop.title.length) return '';
      return prop.title.map(t => t.plain_text).join('');
    };
    const getDate = (prop) => {
      if (!prop || prop.type !== 'date' || !prop.date) return null;
      return prop.date.start;
    };

    const contentPages = await queryAll(CONTENT_DB_ID);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekFromNow = new Date(today);
    weekFromNow.setDate(weekFromNow.getDate() + 7);

    const overdue = [];
    const inProduction = [];
    const pendingReview = [];
    const dueThisWeek = [];

    const DONE_STATUS = 'Done';

    for (const page of contentPages) {
      const props = page.properties;
      const status = getStatus(props['Content Status']);
      const name = getTitle(props['Content Title']) || getTitle(props['Name']) || '';
      const deadline = getDate(props['Content Due']);

      // Overdue: deadline has passed, not Done
      if (deadline && status !== DONE_STATUS) {
        const d = new Date(deadline);
        if (d < today) {
          overdue.push({ name, status, deadline });
        }
      }

      // In Production: currently being worked on
      if (status === 'In-Production' || status === 'Revision Needed') {
        inProduction.push({ name, status });
      }

      // Pending Review: waiting on QC
      if (status === 'Final QC Review' || status === 'Scheduled Distribution') {
        pendingReview.push({ name, status });
      }

      // Due This Week: deadline within next 7 days, not Done
      if (deadline && status !== DONE_STATUS) {
        const d = new Date(deadline);
        if (d >= today && d <= weekFromNow) {
          dueThisWeek.push({ name, status, deadline });
        }
      }
    }

    const stats = {
      overdue: {
        count: overdue.length,
        tasks: overdue.slice(0, 10),
      },
      inProduction: {
        count: inProduction.length,
        tasks: inProduction.slice(0, 10),
      },
      pendingReview: {
        count: pendingReview.length,
        tasks: pendingReview.slice(0, 10),
      },
      dueThisWeek: {
        count: dueThisWeek.length,
        tasks: dueThisWeek.slice(0, 10),
      },
    };

    return res.status(200).json(stats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
