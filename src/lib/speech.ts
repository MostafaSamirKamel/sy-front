import api from './api';
import { prepareAudioElement, unlockMobileAudio } from './mobileAudio';
import { wrapPcm16AsWav } from './pcmAudio';

const EGYPTIAN_VOICE_HINT =
  /egypt|egyptian|ar-eg|cairo|مصر|google.*arabic|microsoft.*arabic|natural.*arabic/i;

const IS_MOBILE =
  typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

const SPEECH_TIMEOUT_MS = 25_000;

let activeAudio: HTMLAudioElement | null = null;
let activeObjectUrl: string | null = null;

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  if (typeof window === 'undefined') return undefined;
  const voices = window.speechSynthesis.getVoices();
  if (lang.startsWith('ar')) {
    return (
      voices.find((v) => EGYPTIAN_VOICE_HINT.test(`${v.lang} ${v.name}`)) ||
      voices.find((v) => v.lang.toLowerCase() === 'ar-eg') ||
      voices.find((v) => v.lang.toLowerCase().startsWith('ar')) ||
      undefined
    );
  }
  return (
    voices.find((v) => v.lang.startsWith('en') && /US|Google US|Microsoft.*English/i.test(v.name)) ||
    voices.find((v) => v.lang.startsWith('en')) ||
    undefined
  );
}

function applyVoice(utterance: SpeechSynthesisUtterance, lang: string) {
  const voice = pickVoice(lang);
  if (voice) utterance.voice = voice;
  utterance.lang = lang.startsWith('ar') ? 'ar-EG' : 'en-US';
  utterance.rate = lang.startsWith('ar') ? 1.08 : 1.05;
  utterance.pitch = lang.startsWith('ar') ? 1.02 : 1;
}

function primeSpeechSynthesis() {
  const synth = window.speechSynthesis;
  synth.cancel();
  if (typeof synth.resume === 'function') synth.resume();
}

function clearActiveAudio() {
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.src = '';
    activeAudio = null;
  }
  if (activeObjectUrl) {
    URL.revokeObjectURL(activeObjectUrl);
    activeObjectUrl = null;
  }
}

async function speakViaServer(text: string, lang: string): Promise<void> {
  const res = await api.post<ArrayBuffer>(
    '/speech/speak',
    { text: text.trim(), lang: lang.startsWith('ar') ? 'ar-EG' : 'en-US' },
    { responseType: 'arraybuffer', timeout: SPEECH_TIMEOUT_MS },
  );

  clearActiveAudio();
  const blob = new Blob([res.data], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  activeObjectUrl = url;

  const audio = new Audio(url);
  prepareAudioElement(audio);
  activeAudio = audio;

  await new Promise<void>((resolve, reject) => {
    const done = () => {
      clearActiveAudio();
      resolve();
    };
    audio.onended = done;
    audio.onerror = () => {
      clearActiveAudio();
      reject(new Error('play-failed'));
    };
    void audio.play().catch(reject);
  });
}

function speakViaBrowser(text: string, lang: string): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) {
      resolve();
      return;
    }

    primeSpeechSynthesis();
    const utterance = new SpeechSynthesisUtterance(text.trim());
    let finished = false;

    const cleanupAndResolve = () => {
      if (!finished) {
        finished = true;
        resolve();
      }
    };

    // Safety timeout in case browser TTS hangs without triggering onend/onerror
    const safetyTimer = setTimeout(cleanupAndResolve, 12000);

    const start = () => {
      applyVoice(utterance, lang);
      utterance.onend = () => {
        clearTimeout(safetyTimer);
        cleanupAndResolve();
      };
      utterance.onerror = () => {
        clearTimeout(safetyTimer);
        cleanupAndResolve();
      };
      try {
        window.speechSynthesis.speak(utterance);
      } catch {
        clearTimeout(safetyTimer);
        cleanupAndResolve();
      }
    };

    if (window.speechSynthesis.getVoices().length) {
      start();
    } else {
      let fired = false;
      const onVoices = () => {
        if (!fired) {
          fired = true;
          start();
        }
      };
      window.speechSynthesis.addEventListener('voiceschanged', onVoices, { once: true });
      // If voiceschanged doesn't fire within 250ms, start anyway
      setTimeout(onVoices, 250);
    }
  });
}

/**
 * Speak the exact reply text. Prefer server TTS for natural quality; fall back to browser.
 * Resolves when playback finishes (or fails gracefully). Does not throw for soft failures.
 */
export async function speakText(
  text: string,
  lang: string,
): Promise<{ ok: boolean; error?: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true };

  try {
    // 1. Try server TTS (high quality natural Egyptian Arabic / English)
    try {
      await speakViaServer(trimmed, lang);
      return { ok: true };
    } catch (serverErr) {
      console.warn('[speech] Server TTS failed, falling back to browser synthesis:', serverErr);
    }

    // 2. Fallback to browser synthesis
    await speakViaBrowser(trimmed, lang);
    return { ok: true };
  } catch (err) {
    console.warn('[speech] speakText error:', err);
    return { ok: false, error: err instanceof Error ? err.message : 'tts-failed' };
  }
}

export function playSpeechBase64(base64: string, mimeType = 'audio/mpeg'): Promise<void> {
  if (!base64) return Promise.resolve();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return playSpeechBytes(bytes, mimeType);
}

/** Raw PCM16 is not browser-playable until it has a WAV container/header. */
export function playPcm16Base64(base64: string): Promise<void> {
  if (!base64) return Promise.resolve();
  const binary = atob(base64);
  const pcm = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) pcm[i] = binary.charCodeAt(i);
  return playSpeechBytes(wrapPcm16AsWav(pcm), 'audio/wav');
}

function playSpeechBytes(bytes: Uint8Array, mimeType: string): Promise<void> {
  clearActiveAudio();

  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  activeObjectUrl = url;

  const audio = new Audio(url);
  prepareAudioElement(audio);
  activeAudio = audio;

  return new Promise<void>((resolve, reject) => {
    const done = () => {
      clearActiveAudio();
      resolve();
    };
    audio.onended = done;
    audio.onerror = () => {
      clearActiveAudio();
      reject(new Error('play-failed'));
    };
    void audio.play().catch(reject);
  });
}

export function stopSpeaking() {
  window.speechSynthesis?.cancel();
  clearActiveAudio();
}

/** Call on user gesture before live call — helps iOS unlock audio output. */
export function primeSpeechOutput(): void {
  if (typeof window === 'undefined') return;
  primeSpeechSynthesis();
  window.speechSynthesis?.getVoices();
  void unlockMobileAudio();
}
