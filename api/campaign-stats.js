// Vercel Serverless Function — Campaign Stats
// Queries Monthly Campaigns DB for active campaign metrics
// Environment variables: NOTION_API_KEY

const CAMPAIGNS_DB_ID = '3188b289e31a806bac9de1ee09aff2ad';

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
        if (!r.ok) throw new Error(`DB query error (${r.status}): ${await r.text()}`);
        const d = await r.json();
        all = all.concat(d.results);
        hasMore = d.has_more;
        cursor = d.next_cursor;
      }
      return all;
    }

    const getTitle     = p => p?.type === 'title' ? (p.title || []).map(t => t.plain_text).join('') : '';
    const getStatus    = p => p?.type === 'status' ? p.status?.name : null;
    const getNumber    = p => p?.type === 'number' ? (p.number || 0) : 0;
    const getSelect    = p => p?.type === 'select' ? p.select?.name : null;
    const getDate      = p => p?.type === 'date' ? (p.date?.start || null) : null;

    const getRollupText = p => {
      if (!p || p.type !== 'rollup') return '';
      const r = p.rollup;
      if (r.type === 'array') {
        return (r.array || []).map(item => {
          if (item.type === 'title') return (item.title || []).map(t => t.plain_text).join('');
          if (item.type === 'rich_text') return (item.rich_text || []).map(t => t.plain_text).join('');
          return '';
        }).filter(Boolean).join(', ');
      }
      return '';
    };

    const getRollupNumber = p => {
      if (!p || p.type !== 'rollup') return 0;
      const r = p.rollup;
      if (r.type === 'number') return r.number || 0;
      if (r.type === 'array') {
        return (r.array || []).reduce((sum, item) => {
          if (item.type === 'number') return sum + (item.number || 0);
          if (item.type === 'formula') {
            const f = item.formula;
            if (f.type === 'number') return sum + (f.number || 0);
            if (f.type === 'boolean') return sum + (f.boolean ? 1 : 0);
            if (f.type === 'string') return sum + (parseFloat(f.string) || 0);
          }
          return sum;
        }, 0);
      }
      return 0;
    };

    const campaigns = await queryAll(CAMPAIGNS_DB_ID);

    let activeCampaigns = 0;
    let totalDeliverables = 0;
    let completedDeliverables = 0;
    const typeCounts = {};
    const completionRates = [];

    let videosPlanned = 0, videosCompleted = 0;
    let postersPlanned = 0, postersCompleted = 0;
    let livePlanned = 0, liveCompleted = 0;
    let kolPlanned = 0, kolCompleted = 0;

    let totalLiveGMV = 0, totalLiveHours = 0, totalLiveOrders = 0;
    let totalLiveSessions = 0;
    let totalTikTokSales = 0, totalShopeeSales = 0;

    const campaignDetails = [];

    for (const page of campaigns) {
      const props = page.properties;
      const status = getStatus(props['Campaign Status']);
      const type   = getSelect(props['Campaign Type']);
      const name   = getTitle(props['Campaign Name']);

      if (status !== 'Active') continue;

      activeCampaigns++;
      if (type) typeCounts[type] = (typeCounts[type] || 0) + 1;

      // Client name from rollup
      const client = getRollupText(props['Client']) || null;

      // Dates
      const startDate = getDate(props['Start Date']);
      const endDate   = getDate(props['End Date']);

      // Planned
      const videos   = getNumber(props['Videos']);
      const posters  = getNumber(props['Posters']);
      const live     = getNumber(props['Live Session']);
      const kolPosts = getNumber(props['KOL Posts']);
      const planned  = videos + posters + live + kolPosts;

      // Completed
      const videosDone  = getRollupNumber(props['Videos Completed']);
      const postersDone = getRollupNumber(props['Posters Completed']);
      const liveDone    = getRollupNumber(props['Livestreams Completed']);
      const kolDone     = getRollupNumber(props['KOL Postings Completed']);
      const done        = videosDone + postersDone + liveDone + kolDone;

      totalDeliverables += planned;
      completedDeliverables += done;

      videosPlanned += videos;   videosCompleted += videosDone;
      postersPlanned += posters; postersCompleted += postersDone;
      livePlanned += live;       liveCompleted += liveDone;
      kolPlanned += kolPosts;    kolCompleted += kolDone;

      totalLiveGMV      += getRollupNumber(props['Overall Live GMV']);
      totalLiveHours    += getRollupNumber(props['Overall Live Hours']);
      totalLiveOrders   += getRollupNumber(props['Overall Live Orders']);
      totalLiveSessions += getRollupNumber(props['Overall Live Sessions']);

      if (planned > 0) completionRates.push(Math.round((done / planned) * 100));

      campaignDetails.push({
        name,
        type: type || 'N/A',
        client,
        startDate,
        endDate,
        planned,
        done,
        pct: planned > 0 ? Math.round((done / planned) * 100) : 0,
        contentBreakdown: {
          videos:  { planned: videos,   completed: videosDone },
          posters: { planned: posters,  completed: postersDone },
          live:    { planned: live,     completed: liveDone },
          kol:     { planned: kolPosts, completed: kolDone },
        },
      });
    }

    const avgCompletion = completionRates.length > 0
      ? Math.round(completionRates.reduce((a, b) => a + b, 0) / completionRates.length)
      : 0;

    campaignDetails.sort((a, b) => a.pct - b.pct);

    return res.status(200).json({
      activeCampaigns,
      totalDeliverables,
      completedDeliverables,
      remainingDeliverables: totalDeliverables - completedDeliverables,
      avgCompletion,
      contentBreakdown: {
        videos:  { planned: videosPlanned, completed: videosCompleted },
        posters: { planned: postersPlanned, completed: postersCompleted },
        live:    { planned: livePlanned, completed: liveCompleted },
        kol:     { planned: kolPlanned, completed: kolCompleted },
      },
      liveSessionMetrics: {
        totalGMV: totalLiveGMV,
        totalHours: totalLiveHours,
        totalOrders: totalLiveOrders,
        totalSessions: totalLiveSessions,
      },
      campaignDetails,
      typeBreakdown: Object.entries(typeCounts).map(([name, count]) => ({ name, count })),
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
};
