// Serves public config to the client (keeps API keys off client bundle)
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ablyKey: process.env.ABLY_API_KEY || '',
  });
}
