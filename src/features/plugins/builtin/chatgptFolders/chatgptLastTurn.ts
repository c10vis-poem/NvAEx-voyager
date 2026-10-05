/**
 * When the user last sent a message in a ChatGPT conversation, for the folder
 * section's Activity view. Only a send counts: opening a chat, ChatGPT
 * re-rendering its transcript or loading older messages never stamps a time.
 *
 * A send is a submit from ChatGPT's composer (Enter, its send button or the
 * form). It is stamped once the message it produced shows up as the newest
 * user turn, under the conversation's stored id: a new chat has no id until
 * ChatGPT gives it a `/c/<id>` route, so its first message waits for that
 * route. Temporary chats record nothing.
 */
import type { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { isSendActionButton } from '@/pages/content/sendBehavior/sendButton';
import { watchRouteChanges } from '@/pages/content/utils/routeWatcher';

import { isTemporaryChat } from '../chatgptTemporaryHandoff/handoff';
import { readChatGptConversation } from './chatgptIdentity';

/** The site adapter's selectors for a user message and the prompt field. */
export type ChatGptTurnSelectors = { readonly userTurn: string; readonly composer: string };

/** A send whose message never showed up (an empty prompt, say) is forgotten after this. */
const PENDING_SEND_MS = 30_000;
/**
 * What keeps one user message's identity across re-renders and remounts: its
 * exchange item's key, or the message id of ChatGPT's older layout.
 */
const TURN_KEY_SELECTOR = '[data-turn-key], [data-message-id]';

type PendingSend = {
  readonly sentAt: number;
  /** The chat it was sent in; `null` for a new chat without a route yet. */
  readonly conversationId: string | null;
  /** User turns on the page when it was sent. */
  readonly known: ReadonlySet<string>;
  /** The message it produced, once it showed up. */
  turn: string | null;
  stop: () => void;
};

function turnKeyOf(turn: Element): string | null {
  const holder = turn.closest(TURN_KEY_SELECTOR);
  return holder?.getAttribute('data-turn-key') ?? holder?.getAttribute('data-message-id') ?? null;
}

/**
 * Calls `record` with a conversation's stored id and the time of each send in
 * it, once per send. Everything it starts is paid back with `scope`.
 */
export function trackChatGptLastTurn(
  scope: PluginScope,
  selectors: ChatGptTurnSelectors,
  record: (conversationId: string, at: number) => void,
  doc: Document = document,
): void {
  let pending: PendingSend | null = null;

  const turnKeys = (): string[] =>
    Array.from(doc.querySelectorAll(selectors.userTurn), turnKeyOf).filter(
      (key): key is string => key !== null,
    );

  const forget = (): void => {
    pending?.stop();
    pending = null;
  };

  const check = (): void => {
    if (!pending) return;
    const keys = turnKeys();
    if (pending.turn === null) {
      // A send adds the newest turn; older ones mounting while it settles are not it.
      const newest = keys.at(-1);
      if (newest === undefined || pending.known.has(newest)) return;
      pending.turn = newest;
    } else if (!keys.includes(pending.turn)) {
      // The page moved on to another chat before the route bound this one.
      return;
    }
    const conversationId = readChatGptConversation(location.href)?.conversationId ?? null;
    if (!conversationId) return;
    if (pending.conversationId !== null && pending.conversationId !== conversationId) {
      forget();
      return;
    }
    const { sentAt } = pending;
    forget();
    record(conversationId, sentAt);
  };

  const onSend = (): void => {
    // The button's click and its form's submit are one send.
    if (scope.isDisposed || pending?.turn === null || isTemporaryChat()) return;
    forget();
    const disposers = [
      scope.observe(doc.body, { childList: true, subtree: true }, check),
      scope.effect(() => watchRouteChanges(check), 'chatgpt-folders:last-turn-route'),
      scope.timer(forget, PENDING_SEND_MS),
    ];
    pending = {
      sentAt: Date.now(),
      conversationId: readChatGptConversation(location.href)?.conversationId ?? null,
      known: new Set(turnKeys()),
      turn: null,
      stop: () => disposers.forEach((dispose) => void dispose()),
    };
  };

  const fromComposer = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest(selectors.composer) !== null;
  const composerForm = (target: Element): HTMLFormElement | null => {
    const form = target.closest('form');
    return form?.querySelector(selectors.composer) ? form : null;
  };

  // Capture phase: these run before ChatGPT handles the send and renders its message.
  scope.on(
    doc,
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      if (fromComposer(event.target)) onSend();
    },
    { capture: true },
  );
  scope.on(
    doc,
    'click',
    (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button || button.disabled || !composerForm(button)) return;
      if (isSendActionButton(button)) onSend();
    },
    { capture: true },
  );
  scope.on(
    doc,
    'submit',
    (event) => {
      if (event.target instanceof Element && composerForm(event.target)) onSend();
    },
    { capture: true },
  );
}
