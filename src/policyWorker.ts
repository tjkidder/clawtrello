import { appendEvent, hasEvent, hasRecentEvent, listPolicyCandidates, moveCard } from './store.js';

const STALE_REVIEW_MINUTES = Number(process.env.STALE_REVIEW_MINUTES ?? 60);
const DUE_SOON_HOURS = Number(process.env.DUE_SOON_HOURS ?? 24);
const NO_PROGRESS_MINUTES = Number(process.env.NO_PROGRESS_MINUTES ?? 30);
const POLICY_TICK_MS = Number(process.env.POLICY_TICK_MS ?? 60_000);

function minutesSince(dateIso: string): number {
  return (Date.now() - new Date(dateIso).getTime()) / 60_000;
}

export function startPolicyWorker() {
  const timer = setInterval(async () => {
    try {
      const cards = await listPolicyCandidates();
      const now = Date.now();

      for (const card of cards) {
        const ageMinutes = minutesSince(card.updatedAt);

        if (card.stage === 'review' && ageMinutes >= STALE_REVIEW_MINUTES) {
          const alreadyNotified = await hasRecentEvent(card.id, 'card.review_stale', STALE_REVIEW_MINUTES);
          if (!alreadyNotified) {
            await appendEvent({
              cardId: card.id,
              eventType: 'policy.stale_review',
              eventKey: 'card.review_stale',
              source: 'policy',
              payload: { minutesInReview: ageMinutes }
            });
          }
        }

        if (card.stage === 'in_progress' && ageMinutes >= NO_PROGRESS_MINUTES) {
          const moved = await moveCard(card.id, 'blocked');
          if (moved) {
            await appendEvent({
              cardId: card.id,
              eventType: 'policy.no_progress',
              eventKey: 'card.blocked',
              source: 'policy',
              payload: { inactiveMinutes: ageMinutes, reason: 'auto-blocked for no progress' }
            });
          }
        }

        if (card.dueAt) {
          const dueMs = new Date(card.dueAt).getTime();
          const dueSoonThresholdMs = DUE_SOON_HOURS * 60 * 60 * 1000;
          const timeUntilDueMs = dueMs - now;

          if (timeUntilDueMs > 0 && timeUntilDueMs <= dueSoonThresholdMs) {
            const alreadyDueSoon = await hasEvent(card.id, 'card.due_soon');
            if (!alreadyDueSoon) {
              await appendEvent({
                cardId: card.id,
                eventType: 'policy.due_soon',
                eventKey: 'card.due_soon',
                source: 'policy',
                payload: { dueAt: card.dueAt }
              });
            }
          }

          if (timeUntilDueMs <= 0) {
            const alreadyOverdue = await hasEvent(card.id, 'card.overdue');
            if (!alreadyOverdue) {
              await appendEvent({
                cardId: card.id,
                eventType: 'policy.overdue',
                eventKey: 'card.overdue',
                source: 'policy',
                payload: { dueAt: card.dueAt }
              });
            }
          }
        }
      }
    } catch (error) {
      console.warn('[policy] worker iteration failed', error);
    }
  }, POLICY_TICK_MS);

  return () => clearInterval(timer);
}
