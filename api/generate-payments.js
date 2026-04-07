// Vercel Serverless Function — Generate Monthly Payment Rows
// Triggered by a Notion Button webhook on a Client Hub page
// Reads Contract Start Date + Contract End Date from the client page
// Creates one payment row per month in Client Payments DB
// Environment variables: NOTION_API_KEY

const CLIENT_PAYMENTS_DB_ID = '8f98368d8f584974b66fcbf95cbd79c9';

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

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

    // Extract client page ID from request body
    // Notion button webhook sends: { data: { id: "page-id", object: "page" } }
    // Direct test call can send: { page_id: "..." }
    const body = req.body || {};
    const clientPageId = (
      body.page_id ||
      (body.data && body.data.id) ||
      (body.source && body.source.page_id)
    );

    if (!clientPageId) {
      return res.status(400).json({
        error: 'Missing page_id. Expected { page_id: "..." } or Notion webhook format.',
      });
    }

    // Fetch the client page from Client Hub
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${clientPageId}`, { headers });
    if (!pageRes.ok) {
      const err = await pageRes.text();
      throw new Error(`Failed to fetch client page (${pageRes.status}): ${err}`);
    }

    const clientPage = await pageRes.json();
    const props = clientPage.properties;

    // Get client name
    // FIX: Changed 'Client Name' to 'Company' to match the Client Hub title property
    const clientName =
      props['Company']?.title?.map(t => t.plain_text).join('') || 'Unknown Client';

    // Get contract dates
    const startDateStr = props['Contract Start Date']?.date?.start;
    const endDateStr   = props['Contract End Date']?.date?.start;

    if (!startDateStr || !endDateStr) {
      return res.status(400).json({
        error: 'Contract Start Date and Contract End Date must both be set on the client page.',
        client: clientName,
      });
    }

    const startDate = new Date(startDateStr);
    const endDate   = new Date(endDateStr);

    if (endDate <= startDate) {
      return res.status(400).json({
        error: 'Contract End Date must be after Contract Start Date.',
        client: clientName,
      });
    }

    // Build list of monthly billing dates (1st of each month)
    const months = [];
    const cursor = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    const last   = new Date(endDate.getFullYear(),   endDate.getMonth(),   1);

    while (cursor <= last) {
      months.push(new Date(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }

    // Create one Client Payments row per month
    const created = [];
    const errors  = [];

    const totalMonths = months.length;

    for (let i = 0; i < months.length; i++) {
      const month   = months[i];
      const payNum  = i + 1;
      const label   = `${MONTH_NAMES[month.getMonth()]} ${month.getFullYear()}`;
      const rowName = `${clientName} – ${label}`;
      const dateStr = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-01`;

      try {
        const createRes = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            parent: { database_id: CLIENT_PAYMENTS_DB_ID },
            icon: { type: 'emoji', emoji: '💰' },
            properties: {
              'Payment Record': {
                title: [{ text: { content: rowName } }],
              },
              'Billing Month': {
                date: { start: dateStr },
              },
              'Client': {
                relation: [{ id: clientPageId }],
              },
              'Payment #': {
                number: payNum,
              },
              'Total Months': {
                number: totalMonths,
              },
              'Status': {
                status: { name: 'Not Paid' },
              },
              'Retainer Payment Status': {
                status: { name: 'Not Paid' },
              },
              'KOL Payment Status': {
                status: { name: 'Not Paid' },
              },
            },
          }),
        });

        if (!createRes.ok) {
          const errBody = await createRes.text();
          errors.push({ month: label, error: errBody });
        } else {
          const createdPage = await createRes.json();
          created.push({ month: label, id: createdPage.id });
        }
      } catch (err) {
        errors.push({ month: label, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      client: clientName,
      totalMonths: months.length,
      created: created.length,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
