import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { RealtimeChannel, RealtimeChannelOptions } from '@supabase/supabase-js'
import { supabase, type Workspace } from './supabase'
import { Avatar, Icon } from './Icon'
import { blurSupported, blurTrack, type Blurred } from './blur'

const BLUR_KEY = 'track-blur'
const readBlur = () => {
  try {
    return localStorage.getItem(BLUR_KEY) === '1'
  } catch {
    return false
  }
}

// Public STUN only. shortcut: no TURN relay, so a few strict networks (some mobile carriers, office
// firewalls) cannot connect; add TURN credentials here if that happens.
const ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]
// Ring this long; a call where you've been alone this long ends.
const TIMEOUT_MS = 60_000

export type Call = { id: string; workspace_id: string; started_by: string; created_at: string; ended_at: string | null }
type MediaState = { mic: boolean; cam: boolean; screen: boolean }
type Signal =
  | { kind: 'offer' | 'answer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }
  | ({ kind: 'state' } & MediaState)
// Peers are device sessions ("<user id>:<random>") so one person can be on two devices. `to` may be '*'.
type Envelope = Signal & { from: string; to: string }
const userOf = (session: string) => session.split(':')[0]

/**
 * supabase-js hands back the existing channel when a topic is reused, and drops channels by topic.
 * So wait for any old channel on the topic (e.g. one still closing after leaving a call) to go first.
 */
async function freshChannel(topic: string, params: RealtimeChannelOptions): Promise<RealtimeChannel> {
  for (const c of supabase.getChannels()) if (c.topic === `realtime:${topic}`) await supabase.removeChannel(c)
  return supabase.channel(topic, params)
}

export async function startCall(workspaceId: string): Promise<void> {
  const { data, error } = await supabase.from('calls').insert({ workspace_id: workspaceId }).select().single()
  if (error) throw error
  location.hash = `#/w/${workspaceId}/call/${(data as Call).id}`
}

/** The call currently running in a workspace, kept live. */
export function useActiveCall(workspaceId: string): Call | null {
  const [call, setCall] = useState<Call | null>(null)
  useEffect(() => {
    // A call whose last person crashed never gets ended_at, so ignore old ones.
    const recent = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    supabase.from('calls').select('*').eq('workspace_id', workspaceId).is('ended_at', null).gt('created_at', recent)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => setCall(data as Call | null))
    const ch = supabase
      .channel(`calls:${workspaceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calls', filter: `workspace_id=eq.${workspaceId}` }, ({ new: c }) => {
        const x = c as Call
        setCall((prev) => (x.ended_at ? (prev?.id === x.id ? null : prev) : x))
      })
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [workspaceId])
  return call
}

/** Two-tone ring through Web Audio (no sound file needed). Returns a stop function. */
function ring(): () => void {
  let ctx: AudioContext
  try {
    ctx = new AudioContext()
  } catch {
    return () => {}
  }
  const beep = () => {
    for (const offset of [0, 0.45]) {
      for (const freq of [440, 480]) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.frequency.value = freq
        gain.gain.value = 0.08
        osc.connect(gain).connect(ctx.destination)
        osc.start(ctx.currentTime + offset)
        osc.stop(ctx.currentTime + offset + 0.35)
      }
    }
    navigator.vibrate?.([300, 150, 300])
  }
  beep()
  const timer = setInterval(beep, 2500)
  return () => {
    clearInterval(timer)
    navigator.vibrate?.(0)
    void ctx.close()
  }
}

// When one of my devices answers, it tells my other devices to stop ringing on this topic.
const ringTopic = (call: Pick<Call, 'id' | 'workspace_id'>) => `ring:${call.workspace_id}:${call.id}`

async function announceAnswered(call: Pick<Call, 'id' | 'workspace_id'>, me: string) {
  const ch = await freshChannel(ringTopic(call), { config: { private: true } })
  ch.subscribe((status) => {
    if (status !== 'SUBSCRIBED') return
    void ch.send({ type: 'broadcast', event: 'answered', payload: { user: me } }).finally(() => supabase.removeChannel(ch))
  })
}

/** Rings inside the app when a call starts in any of the user's workspaces. */
export function IncomingCall({ me }: { me: string }) {
  const [ringing, setRinging] = useState<{ call: Call; caller: string; workspace: string } | null>(null)

  useEffect(() => {
    const ch = supabase
      .channel('calls:incoming')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calls' }, async ({ eventType, new: c }) => {
        const call = c as Call
        if (call.ended_at) return setRinging((r) => (r?.call.id === call.id ? null : r))
        if (eventType !== 'INSERT' || call.started_by === me || location.hash.includes('/call/')) return
        const [p, w, m] = await Promise.all([
          supabase.from('profiles').select('display_name').eq('id', call.started_by).maybeSingle(),
          supabase.from('workspaces').select('name').eq('id', call.workspace_id).maybeSingle(),
          supabase.from('workspace_members').select('notify').eq('workspace_id', call.workspace_id).eq('user_id', me).maybeSingle(),
        ])
        if (m.data?.notify === 'none') return
        setRinging({ call, caller: p.data?.display_name ?? 'Someone', workspace: w.data?.name ?? 'a workspace' })
      })
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [me])

  useEffect(() => {
    if (!ringing) return
    const { call } = ringing
    const stop = ring()
    const timeout = setTimeout(() => setRinging(null), TIMEOUT_MS)
    // Stop when this device opens the call (any way, not just the Answer button)...
    const onHash = () => location.hash.includes(call.id) && setRinging(null)
    addEventListener('hashchange', onHash)
    // ...or when another of my devices answers.
    let answered: RealtimeChannel | null = null
    let cancelled = false
    void freshChannel(ringTopic(call), { config: { private: true } }).then((c) => {
      if (cancelled) return
      answered = c
      c.on('broadcast', { event: 'answered' }, ({ payload }) => payload?.user === me && setRinging(null)).subscribe()
    })
    return () => {
      cancelled = true
      stop()
      clearTimeout(timeout)
      removeEventListener('hashchange', onHash)
      if (answered) void supabase.removeChannel(answered)
    }
  }, [ringing, me])

  if (!ringing) return null
  return (
    <div className="incoming-call" role="alertdialog" aria-label={`${ringing.caller} is calling`}>
      <Avatar name={ringing.caller} id={ringing.call.started_by} size={48} />
      <div className="grow">
        <strong>{ringing.caller} is calling</strong>
        <div className="muted small">{ringing.workspace}</div>
      </div>
      <button className="btn call-btn decline" onClick={() => setRinging(null)} title="Decline">
        <Icon name="phoneOff" /><span className="visually-hidden">Decline</span>
      </button>
      <button className="btn call-btn answer" onClick={() => (location.hash = `#/w/${ringing.call.workspace_id}/call/${ringing.call.id}`)} title="Answer">
        <Icon name="phone" /><span className="visually-hidden">Answer</span>
      </button>
    </div>
  )
}

function Tile({ stream, name, id, state, self, onBlocked }: {
  stream: MediaStream | null
  name: string
  id: string
  state: MediaState
  self?: boolean
  onBlocked: () => void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !stream) return
    if (el.srcObject !== stream) el.srcObject = stream
    // Browsers may refuse to autoplay sound until the user taps somewhere.
    el.play().catch(() => !self && onBlocked())
  }, [stream, self, onBlocked])
  const showVideo = state.cam || state.screen
  return (
    <div className={`tile ${state.screen ? 'sharing' : ''}`}>
      {/* The element stays in the page while hidden so the remote audio keeps playing. */}
      <video ref={ref} autoPlay playsInline muted={self} className={showVideo ? '' : 'video-off'} />
      {!showVideo && <Avatar name={name} id={id} size={64} />}
      <span className="tile-name">
        {!state.mic && <Icon name="micOff" />}
        {name}{self ? ' (you)' : ''}{state.screen ? ' is sharing' : ''}
      </span>
    </div>
  )
}

export function CallView({ ws, callId, me, names, onLeave }: {
  ws: Workspace
  callId: string
  me: string
  names: Map<string, string>
  onLeave: () => void
}) {
  const [session] = useState(() => `${me}:${crypto.randomUUID().slice(0, 8)}`)
  const [remote, setRemote] = useState<Record<string, MediaStream>>({})
  const [states, setStates] = useState<Record<string, MediaState>>({})
  const [others, setOthers] = useState<string[]>([])
  const [mine, setMine] = useState<MediaState>({ mic: true, cam: false, screen: false })
  const [selfStream, setSelfStream] = useState<MediaStream | null>(null)
  // Desktop: a floating window over the app, like Teams. Phones: full screen, with a minimise button.
  const [mini, setMini] = useState(() => matchMedia('(min-width: 801px)').matches)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  const [blur, setBlur] = useState(() => blurSupported && readBlur())
  const [blurBusy, setBlurBusy] = useState(false)
  const blurred = useRef<Blurred | null>(null)
  const [ended, setEnded] = useState('')
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState(false)
  const tracks = useRef<{ audio: MediaStreamTrack | null; camera: MediaStreamTrack | null; screen: MediaStreamTrack | null }>({
    audio: null,
    camera: null,
    screen: null,
  })
  const pcs = useRef(new Map<string, RTCPeerConnection>())
  const queued = useRef(new Map<string, RTCIceCandidateInit[]>())
  const greeted = useRef(new Set<string>())
  const channel = useRef<RealtimeChannel | null>(null)
  const mineRef = useRef(mine)
  mineRef.current = mine
  const anyoneJoined = useRef(false)
  const lastCompany = useRef(Date.now())
  const namesRef = useRef(names)
  namesRef.current = names

  const send = (to: string, s: Signal) =>
    void channel.current?.send({ type: 'broadcast', event: 'signal', payload: { ...s, from: session, to } satisfies Envelope })
  const currentVideo = () => tracks.current.screen ?? blurred.current?.track ?? tracks.current.camera
  const videoSenders = () =>
    [...pcs.current.values()].flatMap((pc) => pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video').map((t) => t.sender))
  const othersNow = () => Object.keys(channel.current?.presenceState() ?? {}).filter((k) => k !== session)

  const leave = async (reason?: string) => {
    if (othersNow().length === 0) await supabase.rpc('end_call', { call: callId })
    if (reason) setEnded(reason)
    else onLeave()
  }
  const leaveRef = useRef(leave)
  leaveRef.current = leave

  useEffect(() => {
    let closed = false
    let ch: RealtimeChannel | null = null

    const connection = (peer: string) => {
      pcs.current.get(peer)?.close()
      const pc = new RTCPeerConnection({ iceServers: ICE })
      const stream = new MediaStream()
      pc.onicecandidate = (e) => e.candidate && send(peer, { kind: 'ice', candidate: e.candidate.toJSON() })
      pc.ontrack = (e) => {
        stream.addTrack(e.track)
        setRemote((r) => ({ ...r, [peer]: stream }))
      }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed')
          setError(`Couldn't connect to ${namesRef.current.get(userOf(peer)) ?? 'someone'}. One of your networks may block direct calls.`)
      }
      pcs.current.set(peer, pc)
      return pc
    }
    // Every connection has one audio and one video slot; camera, screen and mute just swap what's in them.
    const fillSenders = (pc: RTCPeerConnection) => {
      for (const t of pc.getTransceivers()) {
        void t.sender.replaceTrack(t.receiver.track.kind === 'audio' ? tracks.current.audio : currentVideo())
        t.direction = 'sendrecv'
      }
    }
    const flush = async (peer: string, pc: RTCPeerConnection) => {
      for (const c of queued.current.get(peer) ?? []) await pc.addIceCandidate(c).catch(() => {})
      queued.current.delete(peer)
    }
    const offer = async (peer: string) => {
      const pc = connection(peer)
      pc.addTransceiver('audio')
      pc.addTransceiver('video')
      fillSenders(pc)
      await pc.setLocalDescription(await pc.createOffer())
      send(peer, { kind: 'offer', sdp: pc.localDescription!.toJSON() })
    }

    const onSignal = async (m: Envelope) => {
      if (m.to !== session && m.to !== '*') return
      const peer = m.from
      try {
        if (m.kind === 'offer') {
          const pc = connection(peer)
          await pc.setRemoteDescription(m.sdp)
          fillSenders(pc)
          await pc.setLocalDescription(await pc.createAnswer())
          send(peer, { kind: 'answer', sdp: pc.localDescription!.toJSON() })
          await flush(peer, pc)
        } else if (m.kind === 'answer') {
          const pc = pcs.current.get(peer)
          if (pc) {
            await pc.setRemoteDescription(m.sdp)
            await flush(peer, pc)
          }
        } else if (m.kind === 'ice') {
          const pc = pcs.current.get(peer)
          if (pc?.remoteDescription) await pc.addIceCandidate(m.candidate)
          else queued.current.set(peer, [...(queued.current.get(peer) ?? []), m.candidate])
        } else if (m.kind === 'state') {
          setStates((s) => ({ ...s, [peer]: { mic: m.mic, cam: m.cam, screen: m.screen } }))
        }
      } catch (e) {
        console.warn('call signaling', e)
      }
    }

    const onSync = () => {
      if (!ch) return
      const now = Object.keys(ch.presenceState()).filter((k) => k !== session)
      setOthers(now)
      if (now.length) {
        anyoneJoined.current = true
        lastCompany.current = Date.now()
      }
      for (const peer of now) {
        if (greeted.current.has(peer)) continue
        greeted.current.add(peer)
        // The lower session id makes the offer, so two devices never offer to each other at once.
        if (session < peer) void offer(peer)
        send(peer, { kind: 'state', ...mineRef.current })
      }
      for (const peer of [...greeted.current]) {
        if (now.includes(peer)) continue
        greeted.current.delete(peer)
        pcs.current.get(peer)?.close()
        pcs.current.delete(peer)
        setRemote(({ [peer]: _, ...rest }) => rest)
      }
    }

    // Leave once nobody else has been here for a minute: "No answer" for a fresh call, otherwise everyone left.
    const aloneCheck = window.setInterval(() => {
      if (ch && othersNow().length === 0 && Date.now() - lastCompany.current > TIMEOUT_MS)
        void leaveRef.current(anyoneJoined.current ? 'Everyone else left the call.' : 'No answer.')
    }, 5000)

    void (async () => {
      const { data: call } = await supabase.from('calls').select('*').eq('id', callId).maybeSingle()
      if (closed) return
      if (!call || (call as Call).ended_at) return setEnded('This call has ended.')
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
        tracks.current.audio = s.getAudioTracks()[0]
      } catch {
        setError('Track could not use your microphone, so others cannot hear you. Allow it in your browser settings.')
        setMine((m) => ({ ...m, mic: false }))
      }
      const fresh = await freshChannel(`call:${ws.id}:${callId}`, {
        config: { private: true, presence: { key: session }, broadcast: { self: false } },
      })
      if (closed) {
        tracks.current.audio?.stop()
        return void supabase.removeChannel(fresh)
      }
      ch = fresh
      channel.current = fresh
      lastCompany.current = Date.now()
      fresh
        .on('broadcast', { event: 'signal' }, ({ payload }) => void onSignal(payload as Envelope))
        .on('presence', { event: 'sync' }, onSync)
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') void fresh.track({ joined: Date.now() })
          else if (status === 'CHANNEL_ERROR') setError('Could not join the call. Check your connection and try again.')
        })
      void announceAnswered(call as Call, me)
    })()

    return () => {
      closed = true
      clearInterval(aloneCheck)
      for (const pc of pcs.current.values()) pc.close()
      pcs.current.clear()
      greeted.current.clear()
      for (const t of Object.values(tracks.current)) t?.stop()
      tracks.current = { audio: null, camera: null, screen: null }
      blurred.current?.stop()
      blurred.current = null
      channel.current = null
      if (ch) void supabase.removeChannel(ch)
    }
    // Runs once per call; handlers read the latest values through refs.
  }, [ws.id, callId, me, session])

  const update = (next: MediaState) => {
    setMine(next)
    send('*', { kind: 'state', ...next })
    const v = currentVideo()
    setSelfStream(v ? new MediaStream([v]) : null)
  }

  const toggleMic = () => {
    const t = tracks.current.audio
    if (!t) return setError('No microphone available.')
    t.enabled = !t.enabled
    update({ ...mine, mic: t.enabled })
  }

  const swapVideo = () => {
    for (const s of videoSenders()) void s.replaceTrack(currentVideo())
  }

  // Starts or stops the blur pipeline on the current camera. Falls back to the plain camera on failure.
  const applyBlur = async (on: boolean) => {
    blurred.current?.stop()
    blurred.current = null
    const camera = tracks.current.camera
    if (on && camera) {
      setBlurBusy(true)
      try {
        blurred.current = await blurTrack(camera)
      } catch (e) {
        console.warn('blur', e)
        setError('Background blur could not start on this device.')
      }
      setBlurBusy(false)
    }
  }

  const toggleCam = async () => {
    if (tracks.current.camera) {
      await applyBlur(false)
      tracks.current.camera.stop()
      tracks.current.camera = null
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } })
        tracks.current.camera = s.getVideoTracks()[0]
      } catch {
        return setError('Track could not use your camera. Allow it in your browser settings.')
      }
      if (blur) await applyBlur(true)
    }
    swapVideo()
    update({ ...mineRef.current, cam: !!tracks.current.camera })
  }

  const toggleBlur = async () => {
    const on = !blur
    setBlur(on)
    try {
      localStorage.setItem(BLUR_KEY, on ? '1' : '0')
    } catch {
      // Storage blocked: the choice lasts for this call only.
    }
    if (!tracks.current.camera) return
    await applyBlur(on)
    swapVideo()
    update({ ...mineRef.current })
  }

  // Someone else starting to share expands the call so the shared screen is readable.
  const sharingPeers = Object.entries(states).filter(([, s]) => s.screen).map(([p]) => p).join()
  useEffect(() => {
    if (sharingPeers) setMini(false)
  }, [sharingPeers])

  // Drag the floating window by its header.
  const startDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (!mini || (e.target as HTMLElement).closest('button')) return
    const box = e.currentTarget.parentElement!.getBoundingClientRect()
    const dx = e.clientX - box.left
    const dy = e.clientY - box.top
    const move = (ev: PointerEvent) =>
      setPos({
        x: Math.min(Math.max(0, ev.clientX - dx), innerWidth - box.width),
        y: Math.min(Math.max(0, ev.clientY - dy), innerHeight - box.height),
      })
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  // Resize the floating window from its top-left corner, since it starts docked bottom-right.
  const startResize = (e: ReactPointerEvent<HTMLElement>) => {
    e.preventDefault()
    const box = e.currentTarget.parentElement!.getBoundingClientRect()
    const move = (ev: PointerEvent) => {
      const x = Math.min(Math.max(0, ev.clientX), box.right - 240)
      const y = Math.min(Math.max(0, ev.clientY), box.bottom - 200)
      setPos({ x, y })
      setSize({ w: box.right - x, h: box.bottom - y })
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  const stopScreen = () => {
    tracks.current.screen?.stop()
    tracks.current.screen = null
    for (const s of videoSenders()) void s.replaceTrack(currentVideo())
    update({ ...mineRef.current, screen: false })
  }

  const toggleScreen = async () => {
    if (tracks.current.screen) return stopScreen()
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true })
      const t = s.getVideoTracks()[0]
      t.onended = stopScreen // the browser's own "Stop sharing" button
      tracks.current.screen = t
    } catch {
      return // picker cancelled
    }
    for (const s of videoSenders()) void s.replaceTrack(currentVideo())
    update({ ...mine, screen: true })
  }

  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  const unblock = () => {
    document.querySelectorAll<HTMLVideoElement>('.call video').forEach((v) => void v.play().catch(() => {}))
    setBlocked(false)
  }

  if (ended)
    return (
      <div className="call">
        <div className="call-ended stack">
          <Icon name="phoneOff" />
          <p>{ended}</p>
          <button className="btn primary" onClick={onLeave}>Back to {ws.name}</button>
        </div>
      </div>
    )

  return (
    <div className={`call ${mini ? 'mini' : ''}`} role="dialog" aria-label={`Call in ${ws.name}`}
      style={mini ? { ...(pos && { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }), ...(size && { width: size.w, height: size.h, maxHeight: 'none' }) } : undefined}>
      {mini && <span className="call-resize" onPointerDown={startResize} title="Drag to resize" aria-hidden="true" />}
      <header className="call-head" onPointerDown={startDrag} title={mini ? 'Drag to move' : undefined}>
        <span className="grow">
          <strong>{ws.name}</strong>
          <span className="muted small"> {others.length === 0 ? 'Waiting for others...' : `${others.length + 1} in call`}</span>
        </span>
        <button className="btn call-btn small-btn" onClick={() => setMini(!mini)} title={mini ? 'Full screen' : 'Small window, to use the board and chat'}>
          <Icon name={mini ? 'expand' : 'shrink'} /><span className="visually-hidden">{mini ? 'Full screen' : 'Small window'}</span>
        </button>
      </header>
      {error && <p role="alert" className="notice toast" onClick={() => setError('')}>{error}</p>}
      {blocked && (
        <button className="btn primary unblock" onClick={unblock}>Tap to hear the call</button>
      )}
      <div className={`tiles count-${Math.min(others.length + 1, 5)}`}>
        <Tile stream={selfStream} name={names.get(me) ?? 'You'} id={me} state={mine} self onBlocked={() => {}} />
        {others.map((peer) => (
          <Tile key={peer} stream={remote[peer] ?? null} name={names.get(userOf(peer)) ?? 'Someone'} id={userOf(peer)}
            state={states[peer] ?? { mic: true, cam: false, screen: false }} onBlocked={() => setBlocked(true)} />
        ))}
      </div>
      <div className="call-controls">
        <button className={`btn call-btn ${mine.mic ? '' : 'off'}`} onClick={toggleMic} title={mine.mic ? 'Mute' : 'Unmute'}>
          <Icon name={mine.mic ? 'mic' : 'micOff'} /><span className="visually-hidden">{mine.mic ? 'Mute' : 'Unmute'}</span>
        </button>
        <button className={`btn call-btn ${mine.cam ? '' : 'off'}`} onClick={toggleCam} title={mine.cam ? 'Turn camera off' : 'Turn camera on'}>
          <Icon name={mine.cam ? 'video' : 'videoOff'} /><span className="visually-hidden">{mine.cam ? 'Turn camera off' : 'Turn camera on'}</span>
        </button>
        {blurSupported && (
          <button className={`btn call-btn ${blur ? 'active' : ''}`} onClick={() => void toggleBlur()} disabled={blurBusy}
            title={blurBusy ? 'Starting blur...' : blur ? 'Turn background blur off' : 'Blur my background'}>
            <Icon name="blur" /><span className="visually-hidden">{blur ? 'Turn background blur off' : 'Blur my background'}</span>
          </button>
        )}
        {canShare && (
          <button className={`btn call-btn ${mine.screen ? 'active' : ''}`} onClick={toggleScreen} title={mine.screen ? 'Stop sharing' : 'Share screen'}>
            <Icon name="monitor" /><span className="visually-hidden">{mine.screen ? 'Stop sharing' : 'Share screen'}</span>
          </button>
        )}
        <button className="btn call-btn decline" onClick={() => void leave()} title="Leave call">
          <Icon name="phoneOff" /><span className="visually-hidden">Leave call</span>
        </button>
      </div>
    </div>
  )
}
