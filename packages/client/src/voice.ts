/**
 * Voices. People's lines can be read aloud, and the player can speak instead of typing. Both go through small
 * interfaces so a server voice model (text-to-speech, speech-to-text) can replace the browser's built-in ones
 * later without touching the game screens.
 */

export interface Speaker {
  /** Stable per person, so each keeps one voice. */
  id: string;
  pronouns?: string;
}

export interface VoiceOut {
  available(): boolean;
  /** Say a line; resolves when it has been said (or was cut off). */
  speak(text: string, who: Speaker): Promise<void>;
  stop(): void;
  /** Characters per second it speaks at, for pacing subtitles. */
  pace: number;
}

export interface VoiceIn {
  available(): boolean;
  /** Listen for one utterance; resolves with what was said ('' when nothing was understood). */
  listen(onPartial?: (text: string) => void): Promise<string>;
  stop(): void;
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** The browser's own speech voices: free, offline, and different on every system. */
class BrowserVoiceOut implements VoiceOut {
  pace = 14;
  private voices: SpeechSynthesisVoice[] = [];
  constructor() {
    if (!this.available()) return;
    const load = () => (this.voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith((navigator.language || 'en').slice(0, 2).toLowerCase())));
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
  }
  available() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }
  /** A voice for this person: matched to their pronouns where the voice names tell, then picked by a stable hash. */
  private voiceFor(who: Speaker): SpeechSynthesisVoice | undefined {
    const all = this.voices.length ? this.voices : speechSynthesis.getVoices();
    if (!all.length) return undefined;
    const fem = /female|woman|zira|aria|jenny|samantha|victoria|karen|moira|tessa|susan|hazel|libby|sonia|emma|ava|allison/i;
    const masc = /male|man|david|mark|guy|daniel|alex|fred|george|ryan|thomas|christopher|eric|brian|james/i;
    const p = (who.pronouns ?? '').toLowerCase();
    const want = p.startsWith('she') ? all.filter((v) => fem.test(v.name) && !/\bmale\b/i.test(v.name)) : p.startsWith('he') ? all.filter((v) => masc.test(v.name) && !fem.test(v.name)) : all;
    const pool = want.length ? want : all;
    return pool[hash(who.id) % pool.length];
  }
  speak(text: string, who: Speaker): Promise<void> {
    if (!this.available() || !text.trim()) return Promise.resolve();
    speechSynthesis.cancel();
    return new Promise((done) => {
      const u = new SpeechSynthesisUtterance(text);
      const v = this.voiceFor(who);
      if (v) u.voice = v;
      // A little variety between people of the same voice.
      const h = hash(who.id);
      u.pitch = 0.85 + ((h >> 3) % 30) / 100;
      u.rate = 0.95 + ((h >> 7) % 15) / 100;
      u.onend = () => done();
      u.onerror = () => done();
      speechSynthesis.speak(u);
    });
  }
  stop() {
    if (this.available()) speechSynthesis.cancel();
  }
}

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };

/** The browser's speech recognition (Chrome and Edge; it may send audio to the browser maker's service). */
class BrowserVoiceIn implements VoiceIn {
  private rec: Recognition | null = null;
  private ctor(): (new () => Recognition) | undefined {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition;
  }
  available() {
    return typeof window !== 'undefined' && !!this.ctor();
  }
  listen(onPartial?: (text: string) => void): Promise<string> {
    const C = this.ctor();
    if (!C) return Promise.resolve('');
    this.stop();
    return new Promise((done) => {
      const rec = new C();
      this.rec = rec;
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = false;
      let text = '';
      rec.onresult = (e) => {
        text = Array.from(e.results).map((r) => r[0]!.transcript).join(' ').trim();
        onPartial?.(text);
      };
      rec.onend = () => {
        this.rec = null;
        done(text);
      };
      rec.onerror = () => {
        this.rec = null;
        done(text);
      };
      rec.start();
    });
  }
  stop() {
    this.rec?.stop();
    this.rec = null;
  }
}

/**
 * Speech to text on the server (a transcription model): records one utterance with the microphone, stops after
 * a second of silence (or when stopped), and sends it to be transcribed. Works in any browser with a microphone.
 */
class ServerVoiceIn implements VoiceIn {
  private stopNow: (() => void) | null = null;
  /** Whether the server has a speech model (null until asked). */
  enabled: boolean | null = null;
  async probe(): Promise<boolean> {
    if (this.enabled === null) {
      const v = await fetch('/api/voice', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (v) this.enabled = !!(v as { speechInput?: boolean }).speechInput;
    }
    return !!this.enabled;
  }
  available() {
    return this.enabled !== false && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  }
  async listen(onPartial?: (text: string) => void): Promise<string> {
    this.stop();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      onPartial?.('');
      throw new Error('The microphone is blocked. Allow it in the browser to speak.');
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    // Silence detection: stop once speech has started and the room has been quiet for a moment.
    const ac = new AudioContext();
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    // Speech is judged against this microphone's own background level (measured over the first moments), since
    // levels differ a lot between microphones and noise suppression.
    let spoke = false, quietSince = performance.now(), floor = 0, samples = 0, peak = 0;
    const started = performance.now();
    const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
    const finish = () => {
      if (rec.state === 'recording') rec.stop();
    };
    this.stopNow = finish;
    const watch = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.sqrt(sum / buf.length);
      const now = performance.now();
      peak = Math.max(peak, level);
      if (now - started < 350) {
        floor = (floor * samples + level) / ++samples;
        return;
      }
      if (level > Math.max(0.004, floor * 2.5)) {
        spoke = true;
        quietSince = now;
      }
      if ((spoke && now - quietSince > 1200) || (!spoke && now - started > 7000) || now - started > 20000) finish();
    }, 60);
    rec.start(250);
    await done;
    clearInterval(watch);
    stream.getTracks().forEach((t) => t.stop());
    void ac.close();
    this.stopNow = null;
    // Send whatever was recorded unless it was only a blip; the transcription model knows silence when it hears it.
    if (!chunks.length || performance.now() - started < 600) return '';
    if (peak < 0.0015) throw new Error('No sound reached the microphone. Check that the right microphone is selected.');
    onPartial?.('…');
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    const res = await fetch(`/api/voice/transcribe?lang=${encodeURIComponent((navigator.language || 'en').slice(0, 2))}`, { method: 'POST', headers: { 'content-type': blob.type.split(';')[0]! }, body: blob, credentials: 'include' });
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok) throw new Error(data.error ?? 'Could not understand that.');
    return data.text ?? '';
  }
  stop() {
    this.stopNow?.();
  }
}

export const voiceOut: VoiceOut = new BrowserVoiceOut();
const serverIn = new ServerVoiceIn();
const browserIn = new BrowserVoiceIn();
/** The server's transcription when it has a speech model (reliable everywhere), else the browser's own. */
export const voiceIn: VoiceIn = {
  available: () => serverIn.available() || browserIn.available(),
  listen: async (onPartial) => ((await serverIn.probe()) && serverIn.available() ? serverIn.listen(onPartial) : browserIn.listen(onPartial)),
  stop: () => (serverIn.stop(), browserIn.stop()),
};

/** Read people's lines aloud (a per-player preference kept in this browser). */
export function readAloud(): boolean {
  try {
    return localStorage.getItem('gd.readAloud') === '1';
  } catch {
    return false;
  }
}

export function setReadAloud(on: boolean) {
  try {
    localStorage.setItem('gd.readAloud', on ? '1' : '0');
  } catch {
    /* private mode */
  }
  if (!on) voiceOut.stop();
}
