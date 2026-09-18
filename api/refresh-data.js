const { put } = require('@vercel/blob');

const COMPETITORS = [
  { brand: '노루페인트', newsQuery: '노루페인트', launchQuery: '노루페인트 신제품', ytQuery: '노루페인트 페인트' },
  { brand: 'KCC', newsQuery: 'KCC 페인트', launchQuery: 'KCC 페인트 신제품', ytQuery: 'KCC 페인트' },
];

const OWN_FEED_URL = 'https://spsamhwa.com/paints/guide/report/feed';
const MAX_NEWS_PER_BRAND = 6;
const MAX_YT_PER_BRAND = 4;

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/<[^>]+>/g, '')
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? decodeEntities(m[1]) : '';
}

function parseRssItems(xml) {
  const items = [];
  const blocks = xml.split(/<item>/i).slice(1);
  for (const raw of blocks) {
    const block = raw.split(/<\/item>/i)[0];
    items.push({
      title: extractTag(block, 'title'),
      link: extractTag(block, 'link'),
      pubDate: extractTag(block, 'pubDate'),
      source: extractTag(block, 'source'),
    });
  }
  return items;
}

async function fetchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (SP-SAMHWA-Dashboard-Bot)' } });
  if (!res.ok) throw new Error(`Google News fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).map((item) => ({
    title: item.title.replace(/\s+-\s+[^-]+$/, (m) => m), // keep as-is; source often trails title
    link: item.link,
    pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : null,
  }));
}

async function fetchOwnSiteFeed() {
  const res = await fetch(OWN_FEED_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (SP-SAMHWA-Dashboard-Bot)' } });
  if (!res.ok) throw new Error(`spsamhwa.com feed fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml).map((item) => ({
    title: item.title,
    link: item.link,
    pubDate: item.pubDate ? new Date(item.pubDate).toISOString() : null,
  }));
}

async function fetchYouTube(query, apiKey) {
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=date&maxResults=${MAX_YT_PER_BRAND}&q=${encodeURIComponent(query)}&key=${apiKey}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error(`YouTube search failed: ${searchRes.status}`);
  const searchJson = await searchRes.json();
  const items = (searchJson.items || []).filter((it) => it.id && it.id.videoId);
  if (items.length === 0) return [];

  const ids = items.map((it) => it.id.videoId).join(',');
  const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids}&key=${apiKey}`;
  const statsRes = await fetch(statsUrl);
  const statsJson = statsRes.ok ? await statsRes.json() : { items: [] };
  const viewsById = {};
  for (const v of statsJson.items || []) {
    viewsById[v.id] = Number(v.statistics && v.statistics.viewCount) || 0;
  }

  return items.map((it) => ({
    title: it.snippet.title,
    link: `https://www.youtube.com/watch?v=${it.id.videoId}`,
    channel: it.snippet.channelTitle,
    publishedAt: it.snippet.publishedAt,
    viewCount: viewsById[it.id.videoId] || 0,
  }));
}

const LAUNCH_KEYWORDS = ['신제품', '출시', '런칭', '리뉴얼'];

module.exports = async (req, res) => {
  const secret = req.query && req.query.secret;
  const isVercelCron = req.headers['x-vercel-cron'] !== undefined;
  if (!isVercelCron && secret !== process.env.CRON_SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const errors = [];
  let competitorNews = [];
  let competitorVideos = [];
  let ownNews = [];

  for (const c of COMPETITORS) {
    try {
      const [general, launch] = await Promise.all([
        fetchGoogleNews(c.newsQuery),
        fetchGoogleNews(c.launchQuery),
      ]);
      const launchLinks = new Set(launch.map((i) => i.link));
      const merged = [...general, ...launch.filter((i) => !general.some((g) => g.link === i.link))];
      merged.slice(0, MAX_NEWS_PER_BRAND).forEach((item) => {
        competitorNews.push({
          ...item,
          brand: c.brand,
          isLaunch: launchLinks.has(item.link) || LAUNCH_KEYWORDS.some((k) => item.title.includes(k)),
        });
      });
    } catch (e) {
      errors.push(`news:${c.brand}: ${e.message}`);
    }
  }
  competitorNews = competitorNews
    .filter((n) => n.pubDate)
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  if (process.env.YOUTUBE_API_KEY) {
    for (const c of COMPETITORS) {
      try {
        const vids = await fetchYouTube(c.ytQuery, process.env.YOUTUBE_API_KEY);
        vids.forEach((v) => competitorVideos.push({ ...v, brand: c.brand }));
      } catch (e) {
        errors.push(`youtube:${c.brand}: ${e.message}`);
      }
    }
    competitorVideos.sort((a, b) => b.viewCount - a.viewCount);
  }

  try {
    ownNews = (await fetchOwnSiteFeed()).slice(0, 5);
  } catch (e) {
    errors.push(`ownSite: ${e.message}`);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sources: {
      googleNews: competitorNews.length > 0,
      youtube: competitorVideos.length > 0,
      ownSite: ownNews.length > 0,
    },
    competitorNews,
    competitorVideos,
    ownNews,
    errors,
  };

  try {
    const blob = await put('dashboard-data.json', JSON.stringify(payload), {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true,
      addRandomSuffix: false,
    });
    res.status(200).json({ ok: true, url: blob.url, counts: {
      competitorNews: competitorNews.length,
      competitorVideos: competitorVideos.length,
      ownNews: ownNews.length,
    }, errors });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, errors });
  }
};
