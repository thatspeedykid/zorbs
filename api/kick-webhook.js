// Kick posts chat events here
// We queue !play and !boost commands for the game to poll

// In-memory queue (use Vercel KV in prod for persistence)
// For now: simple in-memory store, resets on cold start
const queue = [];
const MAX_QUEUE = 200;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    // Game polls this to get pending commands
    const pending = [...queue];
    queue.length = 0; // clear after reading
    return res.json({ commands: pending });
  }

  if (req.method === 'POST') {
    // Kick is sending us a webhook event
    const body = req.body;
    
    // Kick webhook verification - they send a signature header
    // For now accept all (add signature check in prod)
    
    const eventType = req.headers['kick-event-type'] || body?.type || '';
    
    // Handle chat message
    if (eventType === 'chat.message.sent' || body?.event === 'chat.message.sent') {
      const data = body?.data || body;
      const username = data?.sender?.username || data?.chatter?.username || data?.user?.username || '';
      const message = (data?.content || data?.message || '').trim().toLowerCase();
      const isSub = !!(data?.sender?.identity?.badges?.some(b => 
        b.type === 'subscriber' || b.type === 'sub'
      ));

      if (username && (message === '!play' || message === '!boost')) {
        if (queue.length < MAX_QUEUE) {
          queue.push({ username, command: message, isSub, ts: Date.now() });
        }
      }
    }

    return res.status(200).json({ ok: true });
  }

  res.status(405).end();
}
