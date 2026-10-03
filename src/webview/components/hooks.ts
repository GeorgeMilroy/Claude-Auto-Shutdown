import { useEffect, useRef, useState } from 'preact/hooks';
import { announcementDue, remainingSeconds } from '../clock';
import type { CountdownAnchor } from '../clock';
import { countdownAnnouncement, heroSpeech } from '../hero';
import type { HeroModel, Speech } from '../hero';
import { hero as copy } from '../strings';

/** Re-renders the caller every `intervalMs`; the caller reads the clock itself when it renders. */
export function useTick(intervalMs: number): void {
  const [, setTicks] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTicks((ticks) => ticks + 1), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = (): void => setMatches(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

interface CountdownSpeech {
  id: string | null;
  start: string;
  mark: string;
  lastSeconds: number | null;
}

const SILENT: CountdownSpeech = { id: null, start: '', mark: '', lastSeconds: null };

/**
 * What the live regions say. Outside a countdown see hero.heroSpeech. During a countdown: one
 * alert when it appears, then a polite line at 60, 30, 10 and 5 s - never the ticking digits.
 */
export function useSpeech(model: HeroModel, anchor: CountdownAnchor | null, now: number, waitingFor: string): Speech {
  const memory = useRef<CountdownSpeech>(SILENT);
  const countdown = model.countdown;
  if (countdown === null) {
    memory.current = SILENT;
    return heroSpeech(model, waitingFor);
  }
  const id = anchor?.id ?? '';
  const seconds = anchor === null ? 0 : remainingSeconds(anchor, now);
  const previous = memory.current;
  if (previous.id !== id) {
    memory.current = { id, start: countdownAnnouncement(countdown, seconds), mark: '', lastSeconds: seconds };
  } else {
    const due = announcementDue(previous.lastSeconds, seconds);
    memory.current = { ...previous, mark: due === null ? previous.mark : copy.timeLeft(due), lastSeconds: seconds };
  }
  return { polite: memory.current.mark, assertive: memory.current.start };
}
