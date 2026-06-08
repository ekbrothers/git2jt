// Vercel serverless proxy — fetches a GIF by ID from Giphy's CDN and pipes it
// back to the browser, bypassing Giphy's cross-origin restrictions.
// Usage: /api/gif?id=GIFID
export default async function handler(req, res) {
  const { id } = req.query;

  if (!id || !/^[A-Za-z0-9]+$/.test(id)) {
    return res.status(400).json({ error: 'Missing or invalid id' });
  }

  const upstream = `https://media.giphy.com/media/${id}/giphy.gif`;

  let gifRes;
  try {
    gifRes = await fetch(upstream, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; gif2jt/1.0)' },
    });
  } catch (err) {
    return res.status(502).json({ error: 'Upstream fetch failed: ' + err.message });
  }

  if (!gifRes.ok) {
    return res.status(gifRes.status).json({ error: `Giphy returned ${gifRes.status}` });
  }

  const contentType = gifRes.headers.get('content-type') || 'image/gif';
  if (!contentType.includes('image/gif')) {
    return res.status(502).json({ error: 'Upstream did not return a GIF' });
  }

  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const buf = await gifRes.arrayBuffer();
  res.send(Buffer.from(buf));
}
