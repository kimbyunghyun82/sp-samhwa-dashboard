const { list } = require('@vercel/blob');

module.exports = async (req, res) => {
  try {
    const { blobs } = await list({ prefix: 'dashboard-data.json', limit: 1 });
    if (!blobs || blobs.length === 0) {
      res.status(404).json({ error: 'not_ready' });
      return;
    }
    const fileRes = await fetch(blobs[0].url);
    const json = await fileRes.text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).send(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
