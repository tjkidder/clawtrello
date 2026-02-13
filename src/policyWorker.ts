import { appendEvent, listPolicyCandidates, moveCard } from './store.js';

export function startPolicyWorker() {
  const timer = setInterval(async () => {
    try {
      const now = new Date().toISOString();
      const cards = await listPolicyCandidates(now);
      for (const card of cards) {
        if (card.stage === 'review') {
          await appendEvent({
            cardId: card.id,
            eventType: 'policy.stale_review',
            eventKey: 'policy.reminder',
            source: 'policy',
            payload: { message: 'Review is stale; reminder emitted.' }
          });
          continue;
        }

        if (card.dueAt && new Date(card.dueAt).getTime() < Date.now() && card.stage !== 'blocked') {
          const updated = await moveCard(card.id, 'blocked');
          if (updated) {
            await appendEvent({
              cardId: card.id,
              eventType: 'policy.auto_block_overdue',
              eventKey: 'policy.autoblocked',
              source: 'policy',
              payload: { reason: 'Card overdue and auto-blocked due to inactivity.' }
            });
          }
        }
      }
    } catch (error) {
      console.warn('[policy] worker iteration failed', error);
    }
  }, 60_000);

  return () => clearInterval(timer);
}
