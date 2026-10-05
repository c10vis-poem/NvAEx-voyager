// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://chatgpt.com/" }
/**
 * The ChatGPT folder section's own view, against its real store and storage:
 * search (with `f:`) and collapse, as Gemini's folder sidebar has them, the
 * manual conversation order, and the open time it records.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { StorageKeys } from '@/core/types/common';
import type { FolderData } from '@/core/types/folder';
import { ROOT_CONVERSATIONS_ID } from '@/features/folder/constants';
import { PluginScope } from '@/features/plugins/runtime/pluginScope';
import {
  type TreeDriver,
  label,
  treeDriver,
} from '@/pages/content/folder/floatingTree/__tests__/treeDriver';
import { initI18n } from '@/utils/i18n';

import { activateChatGptFolders } from '../index';
import { type SidebarFixture, makeRows, mountSidebarFixture } from './chatgptSidebarFixture';
import { type MemoryStorage, createMemoryStorage, settle } from './memoryStorage';

vi.mock('webextension-polyfill', () => ({
  default: {
    get storage() {
      return globalThis.chrome.storage;
    },
    runtime: { id: 'test-extension-id' },
    i18n: { getUILanguage: () => 'en' },
  },
}));

const KEY = StorageKeys.FOLDER_DATA_CHATGPT;
const PREFS_KEY = StorageKeys.CHATGPT_FOLDER_SECTION;
const ROOT = ROOT_CONVERSATIONS_ID;
const TITLES = ['Alpha', 'Beta plan', 'Gamma', 'Delta plan', 'Unfiled'];
// The sidebar shows the same titles, so title sync leaves them alone.
const ROWS = makeRows(TITLES.length).map((row, index) => ({ ...row, title: TITLES[index] }));
/** Longer than the search box's typing pause. */
const SEARCH_PAUSE_MS = 250;

function ref(row: number, title: string, sortIndex: number, times: Record<string, number> = {}) {
  const id = ROWS[row].id;
  return {
    conversationId: `chatgpt:conv:${id}`,
    title,
    url: `https://chatgpt.com/c/${id}`,
    addedAt: 1,
    sortIndex,
    ...times,
  };
}

function folder(id: string, name: string, parentId: string | null, sortIndex: number) {
  return { id, name, parentId, isExpanded: true, sortIndex, createdAt: 1, updatedAt: 1 };
}

/**
 * Work (collapsed) holds Alpha, Beta and Gamma in that order; Gamma was opened
 * last and Beta added after Alpha. Personal › Trips holds Delta.
 */
const DATA: FolderData = {
  folders: [
    { ...folder('work', 'Work', null, 0), isExpanded: false },
    folder('personal', 'Personal', null, 1),
    folder('trips', 'Trips', 'personal', 0),
  ],
  folderContents: {
    work: [
      ref(0, 'Alpha', 0),
      ref(1, 'Beta plan', 1, { addedAt: 3 }),
      ref(2, 'Gamma', 2, { addedAt: 2, lastOpenedAt: 5 }),
    ],
    personal: [],
    trips: [ref(3, 'Delta plan', 0)],
    [ROOT]: [],
  },
};

let memory: MemoryStorage;
let originalStorage: typeof chrome.storage;
let scope: PluginScope;
let sidebar: SidebarFixture;

beforeAll(async () => {
  memory = createMemoryStorage();
  originalStorage = globalThis.chrome.storage;
  globalThis.chrome.storage = memory.api;
  await initI18n();
  globalThis.chrome.storage = originalStorage;
});

beforeEach(() => {
  memory = createMemoryStorage();
  originalStorage = globalThis.chrome.storage;
  globalThis.chrome.storage = memory.api;
  memory.values.local.set(KEY, structuredClone(DATA));
  scope = new PluginScope();
  sidebar = mountSidebarFixture(ROWS);
});

afterEach(async () => {
  await scope.dispose();
  sidebar.destroy();
  document.body.replaceChildren();
  globalThis.chrome.storage = originalStorage;
  history.replaceState(null, '', '/');
});

async function nextPass(): Promise<void> {
  await settle(5);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await settle(20);
}

function shadow(): ShadowRoot {
  const host = document.querySelector<HTMLElement>('.gv-chatgpt-folder-section');
  if (!host?.shadowRoot) throw new Error('the folder section is not mounted');
  return host.shadowRoot;
}

async function activate(): Promise<TreeDriver> {
  await activateChatGptFolders(scope);
  await nextPass();
  return treeDriver({ root: shadow(), rootBucketId: ROOT });
}

async function reactivate(): Promise<TreeDriver> {
  await scope.dispose();
  scope = new PluginScope();
  return activate();
}

function stored(): FolderData {
  return memory.values.local.get(KEY) as FolderData;
}

function folderWrites(): number {
  return memory.writes.filter((write) => write.area === 'local' && write.key === KEY).length;
}

function searchBox(): HTMLInputElement {
  return shadow().querySelector<HTMLInputElement>('input[type="search"]')!;
}

async function search(query: string): Promise<void> {
  const input = searchBox();
  input.value = query;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, SEARCH_PAUSE_MS));
}

function collapseToggle(): HTMLButtonElement {
  return shadow().querySelector<HTMLButtonElement>('h2 button')!;
}

describe('ChatGPT folder section: search', () => {
  it('shows matching chats inside collapsed folders, with the folders on the way', async () => {
    const view = await activate();
    expect(view.outline()).toEqual(['Work', 'Personal', '  Trips', '    · Delta plan']);
    const writes = folderWrites();

    await search('plan');

    expect(view.outline()).toEqual([
      'Work',
      '  · Beta plan',
      'Personal',
      '  Trips',
      '    · Delta plan',
    ]);
    expect(folderWrites()).toBe(writes);
  });

  it('searches folder names alone with f:, showing all they hold', async () => {
    const view = await activate();

    await search('f: trip');

    expect(view.outline()).toEqual(['Personal', '  Trips', '    · Delta plan']);
    expect(shadow().querySelector('.gv-folder-search-mode-badge')!.hasAttribute('hidden')).toBe(
      false,
    );
  });

  it('says so when nothing matches, and shows the tree as it was once cleared', async () => {
    const view = await activate();

    await search('nothing like this');
    expect(view.outline()).toEqual([]);
    expect(view.text()).toContain(label('folder_search_empty'));

    await search('');
    expect(view.outline()).toEqual(['Work', 'Personal', '  Trips', '    · Delta plan']);
  });
});

describe('ChatGPT folder section: collapse', () => {
  it('hides the search and the tree, and stays collapsed on this device', async () => {
    const view = await activate();

    collapseToggle().click();
    await nextPass();

    expect(collapseToggle().getAttribute('aria-expanded')).toBe('false');
    expect(collapseToggle().textContent).toBe(label('floatingPanelTitle'));
    expect(view.outline()).toEqual([]);
    expect(memory.values.local.get(PREFS_KEY)).toEqual({
      collapsed: true,
      viewMode: 'folders',
    });

    const again = await reactivate();
    expect(collapseToggle().getAttribute('aria-expanded')).toBe('false');
    expect(again.outline()).toEqual([]);

    collapseToggle().click();
    expect(again.outline()).toEqual(['Work', 'Personal', '  Trips', '    · Delta plan']);
  });

  it('opens again to name a new folder from the header', async () => {
    memory.values.local.set(PREFS_KEY, { collapsed: true, sortMode: 'manual' });
    await activate();

    shadow().querySelector<HTMLButtonElement>('.gv-chatgpt-folder-section__create')!.click();

    expect(collapseToggle().getAttribute('aria-expanded')).toBe('true');
    expect(shadow().querySelector('.gv-floating-folder-panel__inline-input')).not.toBeNull();
  });
});

describe('ChatGPT folder section: conversation order', () => {
  it('a ChatGPT section saved in recent order shows folders in manual order', async () => {
    memory.values.local.set(PREFS_KEY, { collapsed: false, sortMode: 'recent' });
    memory.values.local.set(KEY, {
      ...structuredClone(DATA),
      folders: DATA.folders.map((f) => ({ ...f, isExpanded: true })),
    });

    const view = await activate();

    // Gamma was opened last and Beta added after Alpha; neither moves them.
    expect(view.outline()).toEqual([
      'Work',
      '  · Alpha',
      '  · Beta plan',
      '  · Gamma',
      'Personal',
      '  Trips',
      '    · Delta plan',
    ]);
  });
});

describe('ChatGPT folder section: opening a filed chat', () => {
  it('records the open of a filed chat with no row in ChatGPT’s sidebar, and marks it open', async () => {
    const data = structuredClone(DATA);
    data.folders = data.folders.map((f) => ({ ...f, isExpanded: true }));
    // Older than every row ChatGPT has loaded, so its sidebar never shows it.
    data.folderContents.work.push({
      conversationId: 'chatgpt:conv:unloaded',
      title: 'Older chat',
      url: 'https://chatgpt.com/c/unloaded',
      addedAt: 0,
      sortIndex: 3,
    });
    memory.values.local.set(KEY, data);
    const view = await activate();
    expect(view.outline().slice(1, 5)).toEqual([
      '  · Alpha',
      '  · Beta plan',
      '  · Gamma',
      '  · Older chat',
    ]);
    const before = Date.now();

    view.openConversation('work', 'Older chat');
    await nextPass();

    expect(location.pathname).toBe('/c/unloaded');
    const older = stored().folderContents.work.find((c) => c.title === 'Older chat')!;
    expect(older.lastOpenedAt).toBeGreaterThanOrEqual(before);
    // Manual order: opening it moves nothing.
    expect(view.outline()[4]).toBe('  · Older chat');
    expect(view.titleButton('work', 'Older chat').getAttribute('aria-current')).toBe('page');
  });

  it('writes nothing when the open chat is not filed', async () => {
    await activate();
    const writes = folderWrites();

    history.pushState(null, '', `/c/${ROWS[4].id}`);
    sidebar.setActive(ROWS[4].id);
    await nextPass();

    expect(folderWrites()).toBe(writes);
  });
});
