import { useEffect, useState } from 'react';

// Whimsical loading messages shown while waiting for the model's first
// streamed token. Sequential — no random start — so the "nearly done"
// messages only surface when the user has actually been waiting a while.
// Once we hit the last message, hold there rather than looping.
const MESSAGES = [
  // Stage 1 — warming up
  'Tickling the brain…',
  'Poking the data…',
  'Consulting the hamsters…',
  'Shuffling the neurons…',
  'Brewing a strong opinion…',
  'Asking the wise toaster…',
  'Counting all the bytes…',
  // Stage 2 — actively working
  'Herding rogue facts…',
  'Untangling knowledge noodles…',
  'Waking sleepy electrons…',
  'Polishing tiny thoughts…',
  'Summoning smart vibes…',
  'Juggling important bits…',
  'Reading between the pixels…',
  'Persuading reluctant facts…',
  'Compressing brain juice…',
  'Negotiating with logic…',
  // Stage 3 — almost there
  'Almost looking clever…',
  'Final brain stretch…',
  'Packaging shiny answer…',
  'Tying answer in a bow…',
  'Wrapping it up nicely…',
  // Stage 4 — releasing
  'Releasing the response…',
];

const ROTATION_MS = 2200;

/**
 * Hook returning the current whimsical loading message while `active` is
 * true. Resets to the first message whenever `active` toggles from false to
 * true so each new query starts fresh from "Tickling the brain…".
 */
export function useRotatingMessage(active: boolean): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active) {
      setIndex(0);
      return;
    }
    const id = setInterval(() => {
      setIndex((i) => Math.min(i + 1, MESSAGES.length - 1));
    }, ROTATION_MS);
    return () => clearInterval(id);
  }, [active]);

  return MESSAGES[index] ?? MESSAGES[0]!;
}
