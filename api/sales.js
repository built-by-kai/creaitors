// Vercel Serverless Function — Fetches live data from Sales CRM - Pipeline
// Environment variables: NOTION_API_KEY, NOTION_DATABASE_ID

const DATABASE_ID = process.env.NOTION_DATABASE_ID || '3188b289e31a81ff9f04000bdcab600e';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

  try {
    const NOTION_KEY = process.env.NOTION_API_KEY;
    if (!NOTION_KEY) {
      return res.status(500).json({ error: 'NOTION_API_KEY not set' });
    }

    // Query all deals from the database
    let allResults = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const body = { page_size: 100 };
      if (startCursor) body.start_cursor = startCursor;

      const response = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${NOTION_KEY}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
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
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    // Helpers
    const getStatus = (prop) => {
      if (!prop || prop.type !== 'status' || !prop.status) return null;
      return prop.status.name;
    };
    const getNumber = (prop) => {
      if (!prop || prop.type !== 'number') return 0;
      return prop.number || 0;
    };
    const getCheckbox = (prop) => {
      if (!prop || prop.type !== 'checkbox') return false;
      return prop.checkbox;
    };
    const getTitle = (prop) => {
      if (!prop || prop.type !== 'title' || !prop.title || !prop.title.length) return '';
      return prop.title.map(t => t.plain_text).join('');
    };
    const getText = (prop) => {
      if (!prop || prop.type !== 'rich_text' || !prop.rich_text || !prop.rich_text.length) return '';
      return prop.rich_text.map(t => t.plain_text).join('');
    };
    const getSelect = (prop) => {
      if (!prop || prop.type !== 'select' || !prop.select) return null;
      return prop.select.name;
    };
    const getDate = (prop) => {
      if (!prop || prop.type !== 'date' || !prop.date) return null;
      return prop.date.start;
    };

    // Categorise deals
    const activeDeals = [];
    const wonThisMonth = [];
    const retainerUnpaid = [];
    const kolUnpaid = [];
    const lostThisMonth = [];

    let totalPipelineValue = 0;
    let totalWonValue = 0;
    const funnelCounts = {};

    for (const page of deals) {
      const props = page.properties;
      const funnel = getStatus(props['Funnel']);
      const name = getTitle(props['Name']);
      const company = getText(props['Company']);
      const value = getNumber(props['Estimated Value']);
      const retainerPaid = getCheckbox(props['Retainer Paid (100%)']);
      const kolPaid = getCheckbox(props['KOL/Ads Deposit Paid (50%)']);
      const contractDate = getDate(props['Contract Date']);
      const source = getSelect(props['Source']);

      // Count funnel stages
      if (funnel) {
        funnelCounts[funnel] = (funnelCounts[funnel] || 0) + 1;
      }

      // Active deals (not closed)
      if (funnel && funnel !== 'Closed-Won' && funnel !== 'Closed-Lost') {
        activeDeals.push({ name, company, value, funnel, source });
        totalPipelineValue += value;
      }

      // Won this month (Closed-Won with contract date in current month)
      if (funnel === 'Closed-Won') {
        let isThisMonth = false;
        if (contractDate) {
          const d = new Date(contractDate);
          isThisMonth = d.getMonth() === currentMonth && d.getFullYear() === currentYear;
        } else {
          // If no contract date, check page created time
          const created = new Date(page.created_time);
          isThisMonth = created.getMonth() === currentMonth && created.getFullYear() === currentYear;
        }

        if (isThisMonth) {
          wonThisMonth.push({ name, company, value });
          totalWonValue += value;
        }

        // Retainer unpaid (Closed-Won but retainer not paid)
        if (!retainerPaid) {
          retainerUnpaid.push({ name, company, value });
        }

        // KOL/Ads deposit unpaid (Closed-Won but deposit not paid)
        if (!kolPaid) {
          kolUnpaid.push({ name, company, value });
        }
      }

      // Lost this month
      if (funnel === 'Closed-Lost') {
        const created = new Date(page.created_time);
        const isThisMonth = created.getMonth() === currentMonth && created.getFullYear() === currentYear;
        if (isThisMonth) {
          lostThisMonth.push({ name, company, value });
        }
      }
    }

    const stats = {
      activeDeals: {
        count: activeDeals.length,
        totalValue: totalPipelineValue,
        deals: activeDeals.slice(0, 10),
      },
      wonThisMonth: {
        count: wonThisMonth.length,
        totalValue: totalWonValue,
        deals: wonThisMonth,
      },
      retainerUnpaid: {
        count: retainerUnpaid.length,
        deals: retainerUnpaid,
      },
      kolUnpaid: {
        count: kolUnpaid.length,
        deals: kolUnpaid,
      },
      lostThisMonth: {
        count: lostThisMonth.length,
        deals: lostThisMonth,
      },
      funnelCounts,
      totalDeals: deals.length,
      month: now.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    };

    return res.status(200).json(stats);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
