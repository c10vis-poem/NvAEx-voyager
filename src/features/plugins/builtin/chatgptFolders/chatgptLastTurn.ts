/**
 * When the user last sent a message in a ChatGPT conversation, for the folder
 * section's Activity view. Only a send counts: opening a chat, ChatGPT
 * re-rendering its transcript or loading older messages never stamps a time.
 *
 * A send is a submit from ChatGPT's composer (Enter, its send button or the
 * form) with a prompt or a file in it. It is stamped once the message it
 * produced shows up as the newest user turn, holding the prompt that was
 * submitted, under the conversation's stored id. A new chat has no id until
 * ChatGPT gives it a `/c/<id>` route, so its first message waits for that
 * route and is stamped only if its turn is still on the page once the route
 * settles. Leaving the chat forgets the send. Temporary chats record nothing.
 */
import type { PluginScope } from '@/features/plugins/runtime/pluginScope';
import { isSendActionButton } from '@/pages/content/sendBehavior/sendButton';
import { type RouteChange, watchRouteChanges } from '@/pages/content/utils/routeWatcher';

import {
  hasComposerAttachments,
  readComposerText,
} from '../chatgptTemporaryHandoff/composerDelivery';
import { isTemporaryChat } from '../chatgptTemporaryHandoff/handoff';
import { readChatGptConversation } from './chatgptIdentity';

/** The site adapter's selectors for a user message and the prompt field. */
export type ChatGptTurnSelectors = { readonly userTurn: string; readonly composer: string };

/** A send whose message never showed up (ChatGPT was still answering, say) is forgotten after this. */
const PENDING_SEND_MS = 30_000;
/**
 * How long a new chat's first message must stay on the page after a `/c/<id>`
 * route appears. ChatGPT keeps that message when it names the chat; opening
 * another chat replaces the transcript.
 */
export const NEW_CHAT_SETTLE_MS = 500;
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
  /** The prompt it submitted, without whitespace; empty for a file sent alone. */
  readonly prompt: string;
  /** The message it produced, once it showed up. */
  turn: Element | null;
  /** Whether a new chat's first message is waiting out {@link NEW_CHAT_SETTLE_MS}. */
  settling: boolean;
  readonly disposers: Array<() => void | Promise<void>>;
};

/** Text compared without whitespace, which the composer and the rendered message lay out differently. */
const compact = (text: string): string => text.replace(/[\s\u200b]+/g, '');

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
  /** Set while one submission's events arrive: its Enter or click, then its form's submit. */
  let submitting = false;

  const keyedTurns = (): Array<{ turn: Element; key: string }> =>
    Array.from(doc.querySelectorAll(selectors.userTurn), (turn) => ({
      turn,
      key: turnKeyOf(turn),
    })).filter((entry): entry is { turn: Element; key: string } => entry.key !== null);
  const routeConversation = (): string | null =>
    readChatGptConversation(location.href)?.conversationId ?? null;

  const forget = (): void => {
    pending?.disposers.forEach((dispose) => void dispose());
    pending = null;
  };

  const finish = (conversationId: string): void => {
    if (!pending) return;
    const { sentAt } = pending;
    forget();
    record(conversationId, sentAt);
  };

  const check = (): void => {
    if (!pending) return;
    if (pending.turn === null) {
      // A send adds the newest turn; older ones mounting while it settles are not it.
      const newest = keyedTurns().at(-1);
      if (!newest || pending.known.has(newest.key)) return;
      // A prompt ChatGPT refused stays unsent, and the chat's own last message
      // hydrating next would otherwise pass for it.
      if (!compact(newest.turn.textContent ?? '').includes(pending.prompt)) return;
      pending.turn = newest.turn;
    }
    const conversationId = routeConversation();
    if (!conversationId) return;
    if (pending.conversationId !== null) {
      if (pending.conversationId === conversationId) finish(conversationId);
      else forget();
      return;
    }
    if (pending.settling) return;
    // Any route change can bring a `/c/<id>` (a search result, a shortcut, a
    // link), so only the message surviving it shows ChatGPT named this chat.
    pending.settling = true;
    const turn = pending.turn;
    pending.disposers.push(
      scope.timer(() => {
        if (turn.isConnected && routeConversation() === conversationId) finish(conversationId);
        else forget();
      }, NEW_CHAT_SETTLE_MS),
    );
  };

  const onRoute = ({ trigger }: RouteChange): void => {
    if (!pending) return;
    // Leaving the chat: its old turns would take the send's place. ChatGPT names
    // a new chat without history traversal, so a `popstate` leaves it too.
    const left =
      pending.conversationId === null
        ? trigger === 'popstate'
        : routeConversation() !== pending.conversationId;
    if (left) forget();
    else check();
  };

  /** Whether a submit carries a prompt or a file; ChatGPT sends nothing from an empty composer. */
  const hasDraft = (fields: readonly Element[], form: Element | null): boolean =>
    fields.some((field) => field instanceof HTMLElement && readComposerText(field).trim() !== '') ||
    (form !== null && hasComposerAttachments(form));

  const onSend = (fields: readonly Element[], form: Element | null): void => {
    if (scope.isDisposed || submitting || isTemporaryChat()) return;
    // An empty submit sends nothing; armed, it would claim whichever chat's turn mounted next.
    if (!hasDraft(fields, form)) return;
    const prompt = compact(
      fields.map((field) => (field instanceof HTMLElement ? readComposerText(field) : '')).join(''),
    );
    // One submission dispatches its events in one task; a later send is its own, with its own time.
    submitting = true;
    scope.timer(() => (submitting = false), 0);
    forget();
    pending = {
      sentAt: Date.now(),
      conversationId: routeConversation(),
      known: new Set(keyedTurns().map(({ key }) => key)),
      prompt,
      turn: null,
      settling: false,
      disposers: [
        scope.observe(doc.body, { childList: true, subtree: true }, check),
        scope.effect(() => watchRouteChanges(onRoute), 'chatgpt-folders:last-turn-route'),
        scope.timer(forget, PENDING_SEND_MS),
      ],
    };
  };

  const composerForm = (target: Element): HTMLFormElement | null => {
    const form = target.closest('form');
    return form?.querySelector(selectors.composer) ? form : null;
  };
  const sendFrom = (form: HTMLFormElement): void =>
    onSend(Array.from(form.querySelectorAll(selectors.composer)), form);

  // Capture phase: these run before ChatGPT handles the send and renders its message.
  scope.on(
    doc,
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      const field =
        event.target instanceof Element ? event.target.closest(selectors.composer) : null;
      if (field) onSend([field], field.closest('form'));
    },
    { capture: true },
  );
  scope.on(
    doc,
    'click',
    (event) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button || button.disabled || !isSendActionButton(button)) return;
      const form = composerForm(button);
      if (form) sendFrom(form);
    },
    { capture: true },
  );
  scope.on(
    doc,
    'submit',
    (event) => {
      const form = event.target instanceof Element ? composerForm(event.target) : null;
      if (form) sendFrom(form);
    },
    { capture: true },
  );
}
