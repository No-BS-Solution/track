import { useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase, type Workspace } from './supabase'
import { Avatar, Icon } from './Icon'

// Public STUN only. shortcut: no TURN relay, so a few strict networks (some mobile carriers, office
// firewalls) cannot connect; add TURN credentials here if that happens.
const ICE: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]
const NO_ANSWER_MS = 60_000

export type Call = { id: string; workspace_id: string; started_by: string; created_at: string; ended_at: string | null }
type MediaState = { mic: boolean; cam: boolean; screen: boolean }
type Signal =
  | { kind: 'offer' | 'answer'; sdp: RTCSessionDescriptionInit }
  | { kind: 'ice'; candidate: RTCIceCandidateInit }
  | ({ kind: 'state' } & MediaState)
// `to` is a user id, or '*' for everyone in the call.
type Envelope = Signal & { from: string; to: string }

export async function startCall(workspaceId: string): Promise<void> {
  const { data, error } = await supabase.from('calls').insert({ workspace_id: workspaceId }).select().single()
  if (error) throw error
  location.hash = `#/w/${workspaceId}/call/${(data as Call).id}`
}

/** The call currently running in a workspace, kept live. */
export function useActiveCall(workspaceId: string): Call | null {
  const [call, setCall] = useState<Call | null>(null)
  useEffect(() => {
    // Calls whose last person crashed never get ended_at, so ignore old ones.
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
    const stop = ring()
    const timeout = setTimeout(() => setRinging(null), NO_ANSWER_MS)
    return () => {
      stop()
      clearTimeout(timeout)
    }
  }, [ringing])

  if (!ringing) return null
  const answer = () => {
    location.hash = `#/w/${ringing.call.workspace_id}/call/${ringing.call.id}`
    setRinging(null)
  }
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
      <button className="btn call-btn answer" onClick={answer} title="Answer">
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
      {!showVideo && <Avatar name={name} id={id} size={72} />}
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
  const [remote, setRemote] = useState<Record<string, MediaStream>>({})
  const [states, setStates] = useState<Record<string, MediaState>>({})
  const [others, setOthers] = useState<string[]>([])
  const [mine, setMine] = useState<MediaState>({ mic: true, cam: false, screen: false })
  const [selfStream, setSelfStream] = useState<MediaStream | null>(null)
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
  const namesRef = useRef(names)
  namesRef.current = names

  const send = (to: string, s: Signal) =>
    void channel.current?.send({ type: 'broadcast', event: 'signal', payload: { ...s, from: me, to } satisfies Envelope })
  const currentVideo = () => tracks.current.screen ?? tracks.current.camera
  const videoSenders = () =>
    [...pcs.current.values()].flatMap((pc) => pc.getTransceivers().filter((t) => t.receiver.track.kind === 'video').map((t) => t.sender))

  const leave = async (reason?: string) => {
    const left = Object.keys(channel.current?.presenceState() ?? {}).filter((k) => k !== me)
    if (left.length === 0) await supabase.rpc('end_call', { call: callId })
    if (reason) setEnded(reason)
    else onLeave()
  }

  useEffect(() => {
    let closed = false
    let noAnswer: number | undefined
    const ch = supabase.channel(`call:${ws.id}:${callId}`, { config: { private: true, presence: { key: me }, broadcast: { self: false } } })
    channel.current = ch

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
          setError(`Couldn't connect to ${namesRef.current.get(peer) ?? 'someone'}. One of your networks may block direct calls.`)
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

    ch.on('broadcast', { event: 'signal' }, async ({ payload }) => {
      const m = payload as Envelope
      if (m.to !== me && m.to !== '*') return
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
    })

    ch.on('presence', { event: 'sync' }, () => {
      const now = Object.keys(ch.presenceState()).filter((k) => k !== me)
      setOthers(now)
      if (now.length) anyoneJoined.current = true
      for (const peer of now) {
        if (greeted.current.has(peer)) continue
        greeted.current.add(peer)
        // The lower id makes the offer, so two people never offer to each other at once.
        if (me < peer) void offer(peer)
        send(peer, { kind: 'state', ...mineRef.current })
      }
      for (const peer of [...greeted.current]) {
        if (now.includes(peer)) continue
        greeted.current.delete(peer)
        pcs.current.get(peer)?.close()
        pcs.current.delete(peer)
        setRemote(({ [peer]: _, ...rest }) => rest)
      }
    })

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
      if (closed) return tracks.current.audio?.stop()
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') void ch.track({ joined: Date.now() })
        else if (status === 'CHANNEL_ERROR') setError('Could not join the call. Check your connection and try again.')
      })
      if ((call as Call).started_by === me)
        noAnswer = window.setTimeout(() => !anyoneJoined.current && void leave('No answer.'), NO_ANSWER_MS)
    })()

    return () => {
      closed = true
      clearTimeout(noAnswer)
      for (const pc of pcs.current.values()) pc.close()
      pcs.current.clear()
      greeted.current.clear()
      for (const t of Object.values(tracks.current)) t?.stop()
      tracks.current = { audio: null, camera: null, screen: null }
      channel.current = null
      void supabase.removeChannel(ch)
    }
    // Runs once per call; handlers read the latest values through refs.
  }, [ws.id, callId, me])

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

  const toggleCam = async () => {
    if (tracks.current.camera) {
      tracks.current.camera.stop()
      tracks.current.camera = null
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } })
        tracks.current.camera = s.getVideoTracks()[0]
      } catch {
        return setError('Track could not use your camera. Allow it in your browser settings.')
      }
    }
    for (const s of videoSenders()) void s.replaceTrack(currentVideo())
    update({ ...mine, cam: !!tracks.current.camera })
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
    <div className="call" role="dialog" aria-label={`Call in ${ws.name}`}>
      <header className="call-head">
        <strong>{ws.name}</strong>
        <span className="muted small">
          {others.length === 0 ? 'Waiting for others to join...' : `${others.length + 1} in call`}
        </span>
      </header>
      {error && <p role="alert" className="notice toast" onClick={() => setError('')}>{error}</p>}
      {blocked && (
        <button className="btn primary unblock" onClick={unblock}>Tap to hear the call</button>
      )}
      <div className={`tiles count-${Math.min(others.length + 1, 5)}`}>
        <Tile stream={selfStream} name={names.get(me) ?? 'You'} id={me} state={mine} self onBlocked={() => {}} />
        {others.map((peer) => (
          <Tile key={peer} stream={remote[peer] ?? null} name={names.get(peer) ?? 'Someone'} id={peer}
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
