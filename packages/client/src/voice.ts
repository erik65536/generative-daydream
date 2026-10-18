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

export const voiceOut: VoiceOut = new BrowserVoiceOut();
export const voiceIn: VoiceIn = new BrowserVoiceIn();

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
