import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConversationReference, FolderData } from '../types';
import { createFolderViewHarness, resetFolderViewBrowserMocks } from './folderViewHarness';
import { sidebarTree } from './sidebarTreeDriver';

vi.mock('webextension-polyfill', () => ({ default: chrome }));

vi.mock('@/utils/i18n', () => ({
  getTranslationSync: (key: string) => key,
  getTranslationSyncUnsafe: (key: string) => key,
  initI18n: () => Promise.resolve(),
}));

const folder = (id: string, name: string, sortIndex: number) => ({
  id,
  name,
  parentId: null,
  isExpanded: true,
  sortIndex,
  createdAt: 1,
  updatedAt: 1,
});

/**
 * "Shared" is filed in Project as `c_shared` and in Copy as `shared`, the two
 * spellings Gemini records hold for one chat. "Other" sorts first in Copy
 * while neither chat is starred.
 */
function data(stars: { project?: boolean; copy?: boolean }): FolderData {
  const shared: ConversationReference = {
    conversationId: 'shared',
    title: 'Shared',
    url: 'https://gemini.google.com/app/shared',
    addedAt: 1,
  };
  return {
    folders: [folder('project', 'Project', 0), folder('copy', 'Copy', 1)],
    folderContents: {
      project: [{ ...shared, conversationId: 'c_shared', starred: stars.project }],
      copy: [
        { ...shared, starred: stars.copy },
        {
          conversationId: 'other',
          title: 'Other',
          url: 'https://gemini.google.com/app/other',
          addedAt: 2,
        },
      ],
    },
  };
}

describe('Gemini folder tree: a star belongs to the conversation', () => {
  let harness: Awaited<ReturnType<typeof createFolderViewHarness>>;

  async function mount(stored: FolderData) {
    resetFolderViewBrowserMocks();
    harness = await createFolderViewHarness(stored);
    return sidebarTree(harness.runtime.panel);
  }

  const storedStars = () =>
    Object.values(harness.saved.folderContents)
      .flat()
      .filter((c) => c.title === 'Shared')
      .map((c) => !!c.starred);

  afterEach(() => {
    harness?.destroy();
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starring a chat filed in two folders stars it in both', async () => {
    const view = await mount(data({}));

    view.toggleStar('project', 'Shared');
    await vi.waitFor(() => expect(storedStars()).toEqual([true, true]));

    expect(view.isStarred('project', 'Shared')).toBe(true);
    expect(view.isStarred('copy', 'Shared')).toBe(true);
  });

  it('a chat starred in only one folder shows starred and first in every folder', async () => {
    const view = await mount(data({ project: true }));

    expect(view.isStarred('copy', 'Shared')).toBe(true);
    expect(view.outline()).toEqual(['Project', '  · Shared', 'Copy', '  · Shared', '  · Other']);
  });

  it('unstarring a chat starred in only one folder clears it in every folder', async () => {
    const view = await mount(data({ project: true }));

    view.toggleStar('copy', 'Shared');
    await vi.waitFor(() => expect(storedStars()).toEqual([false, false]));

    expect(view.isStarred('project', 'Shared')).toBe(false);
    expect(view.isStarred('copy', 'Shared')).toBe(false);
  });
});
