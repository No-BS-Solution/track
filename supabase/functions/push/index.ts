// Sends Web Push notifications for new chat messages. Called only by the `notify_push` database trigger,
// which passes the recipients' subscriptions, so this function needs no database access or service role key.
import webpush from 'npm:web-push@3.6.7'

type Subscription = { endpoint: string; keys: { p256dh: string; auth: string }; title: string }

// Only relay to real push services, so a stored endpoint can't make this function call arbitrary URLs.
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.mozaws\.net$/, /\.notify\.windows\.com$/, /\.push\.apple\.com$/]

webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT')!,
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
)

Deno.serve(async (req) => {
  if (req.method !== 'POST' || req.headers.get('x-push-secret') !== Deno.env.get('PUSH_SECRET')) {
    return new Response('forbidden', { status: 403 })
  }
  const { subscriptions, body, url, tag } = (await req.json()) as {
    subscriptions: Subscription[]
    body: string
    url: string
    tag: string
  }
  const results = await Promise.allSettled(
    subscriptions
      .filter((s) => PUSH_HOSTS.some((h) => h.test(new URL(s.endpoint).hostname)))
      .map((s) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          JSON.stringify({ title: s.title, body, url, tag }),
          { TTL: 60 * 60 * 24 },
        ),
      ),
  )
  // shortcut: expired subscriptions (410) are not deleted, they just fail quietly. Prune them if the list grows.
  return Response.json({ sent: results.filter((r) => r.status === 'fulfilled').length })
})
