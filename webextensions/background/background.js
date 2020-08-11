/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import RichConfirm from '/extlib/RichConfirm.js';

import {
  log as internalLogger,
  wait,
  configs,
  sanitizeForHTMLText
} from '/common/common.js';

import * as Constants from '/common/constants.js';
import * as MetricsData from '/common/metrics-data.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TabsUpdate from '/common/tabs-update.js';
import * as ContextualIdentities from '/common/contextual-identities.js';
import * as Permissions from '/common/permissions.js';
import * as TSTAPI from '/common/tst-api.js';
import * as SidebarConnection from '/common/sidebar-connection.js';
import * as UserOperationBlocker from '/common/user-operation-blocker.js';
import '/common/bookmark.js'; // we need to load this once in the background page to register the global listener

import Tab from '/common/Tab.js';
import Window from '/common/Window.js';

import * as ApiTabsListener from './api-tabs-listener.js';
import * as Commands from './commands.js';
import * as Tree from './tree.js';
import * as TreeStructure from './tree-structure.js';
import * as BackgroundCache from './background-cache.js';
import * as TabContextMenu from './tab-context-menu.js';
import * as ContextMenu from './context-menu.js';
import * as Migration from './migration.js';
import './browser-action-menu.js';
import './successor-tab.js';

import EventListenerManager from '/extlib/EventListenerManager.js';

function log(...args) {
  internalLogger('background/background', ...args);
}

// This needs to be large enough for bulk updates on multiple tabs.
const DELAY_TO_PROCESS_RESERVED_UPDATE_TASKS = 250;

export const onInit    = new EventListenerManager();
export const onBuilt   = new EventListenerManager();
export const onReady   = new EventListenerManager();
export const onDestroy = new EventListenerManager();
export const onTreeCompletelyAttached = new EventListenerManager();

export const instanceId = `${Date.now()}-${parseInt(Math.random() * 65000)}`;

let mInitialized = false;
const mPreloadedCaches = new Map();

async function getAllWindows() {
  return browser.windows.getAll({
    populate:    true,
    windowTypes: ['normal']
  }).catch(ApiTabs.createErrorHandler());
}

export async function init() {
  log('init: start');
  MetricsData.add('init: start');
  window.addEventListener('pagehide', destroy, { once: true });

  onInit.dispatch();
  SidebarConnection.init();

  // Read caches from existing tabs at first, for better performance.
  // Those promises will be resolved while waiting for waitUntilCompletelyRestored().
  getAllWindows()
    .then(windows => {
      for (const window of windows) {
        const tab = window.tabs[window.tabs.length - 1];
        browser.sessions.getTabValue(tab.id, Constants.kWINDOW_STATE_CACHED_TABS)
          .catch(ApiTabs.createErrorSuppressor())
          .then(cache => mPreloadedCaches.set(tab.id, cache));
      }
    });

  let promisedWindows;
  log('init: Getting existing windows and tabs');
  await MetricsData.addAsync('init: waiting for waitUntilCompletelyRestored, ContextualIdentities.init and configs.$loaded', Promise.all([
    waitUntilCompletelyRestored().then(() => {
      // don't wait at here for better performance
      promisedWindows = getAllWindows();
      log('init: Start queuing of messages notified via WE APIs');
      ApiTabsListener.init();
    }),
    ContextualIdentities.init(),
    configs.$loaded
  ]));
  MetricsData.add('init: prepare');
  EventListenerManager.debug = configs.debug;

  Migration.migrateConfigs();
  Migration.migrateBookmarkUrls();
  configs.grantedRemovingTabIds = []; // clear!
  MetricsData.add('init: Migration.migrateConfigs');

  updatePanelUrl();

  const windows = await MetricsData.addAsync('init: getting all tabs across windows', promisedWindows); // wait at here for better performance
  const restoredFromCache = await MetricsData.addAsync('init: rebuildAll', rebuildAll(windows));
  mPreloadedCaches.clear();
  await MetricsData.addAsync('init: TreeStructure.loadTreeStructure', TreeStructure.loadTreeStructure(windows, restoredFromCache));

  log('init: Start to process messages including queued ones');
  ApiTabsListener.start();

  Migration.tryNotifyNewFeatures();

  ContextualIdentities.startObserve();
  onBuilt.dispatch(); // after this line, this master process may receive "kCOMMAND_PING_TO_BACKGROUND" requests from sidebars.
  MetricsData.add('init: started listening');

  TabContextMenu.init();
  ContextMenu.init();
  MetricsData.add('init: started initializing of context menu');

  Permissions.clearRequest();

  for (const windowId of restoredFromCache.keys()) {
    if (!restoredFromCache[windowId])
      BackgroundCache.reserveToCacheTree(windowId);
    TabsUpdate.completeLoadingTabs(windowId);
  }

  for (const tab of Tab.getAllTabs(null, { iterator: true })) {
    updateSubtreeCollapsed(tab);
  }
  for (const tab of Tab.getActiveTabs()) {
    for (const ancestor of tab.$TST.ancestors) {
      Tree.collapseExpandTabAndSubtree(ancestor, {
        collapsed: false,
        justNow:   true
      });
    }
  }

  // we don't need to await that for the initialization of TST itself.
  MetricsData.addAsync('init: initializing API for other addons', TSTAPI.initAsBackend());

  mInitialized = true;
  onReady.dispatch();
  BackgroundCache.activate();
  TreeStructure.startTracking();

  await MetricsData.addAsync('init: exporting tabs to sidebars', notifyReadyToSidebars());

  log(`Startup metrics for ${TabsStore.tabs.size} tabs: `, MetricsData.toString());
}

async function notifyReadyToSidebars() {
  log('notifyReadyToSidebars: start');
  const promisedResults = [];
  for (const window of TabsStore.windows.values()) {
    // Send PING to all windows whether they are detected as opened or not, because
    // the connection may be established before this background page starts listening
    // of messages from sidebar pages.
    // See also: https://github.com/piroor/treestyletab/issues/2200
    TabsUpdate.completeLoadingTabs(window.id); // failsafe
    log(`notifyReadyToSidebars: to ${window.id}`);
    promisedResults.push(browser.runtime.sendMessage({
      type:     Constants.kCOMMAND_PING_TO_SIDEBAR,
      windowId: window.id,
      tabs:     window.export(true) // send tabs together to optimizie further initialization tasks in the sidebar
    }).catch(ApiTabs.createErrorSuppressor()));
  }
  return Promise.all(promisedResults);
}

function updatePanelUrl() {
  const panel = `${Constants.kSHORTHAND_URIS.tabbar}?style=${encodeURIComponent(configs.style)}`;
  browser.sidebarAction.setPanel({ panel });
}

function waitUntilCompletelyRestored() {
  log('waitUntilCompletelyRestored');
  return new Promise((resolve, _aReject) => {
    let timeout;
    let resolver;
    let onNewTabRestored = async (tab, _info = {}) => {
      clearTimeout(timeout);
      log('new restored tab is detected.');
      // Read caches from restored tabs while waiting, for better performance.
      browser.sessions.getTabValue(tab.id, Constants.kWINDOW_STATE_CACHED_TABS)
        .catch(ApiTabs.createErrorSuppressor())
        .then(cache => mPreloadedCaches.set(tab.id, cache));
      //uniqueId = uniqueId && uniqueId.id || '?'; // not used
      timeout = setTimeout(resolver, 100);
    };
    browser.tabs.onCreated.addListener(onNewTabRestored);
    resolver = (() => {
      log('timeout: all tabs are restored.');
      browser.tabs.onCreated.removeListener(onNewTabRestored);
      timeout = resolver = onNewTabRestored = undefined;
      resolve();
    });
    timeout = setTimeout(resolver, 500);
  });
}

function destroy() {
  browser.runtime.sendMessage({
    type:  TSTAPI.kUNREGISTER_SELF
  }).catch(ApiTabs.createErrorSuppressor());

  // This API doesn't work as expected because it is not notified to
  // other addons actually when browser.runtime.sendMessage() is called
  // on pagehide or something unloading event.
  TSTAPI.sendMessage({
    type: TSTAPI.kNOTIFY_SHUTDOWN
  }).catch(ApiTabs.createErrorSuppressor());

  onDestroy.dispatch();
  ApiTabsListener.destroy();
  ContextualIdentities.endObserve();
}

async function rebuildAll(windows) {
  if (!windows)
    windows = await getAllWindows();
  const restoredFromCache = new Map();
  await Promise.all(windows.map(async (window) => {
    await MetricsData.addAsync(`rebuildAll: tabs in window ${window.id}`, async () => {
      let trackedWindow = TabsStore.windows.get(window.id);
      if (!trackedWindow)
        trackedWindow = Window.init(window.id);

      for (const tab of window.tabs) {
        Tab.track(tab);
        Tab.init(tab, { existing: true });
        tryStartHandleAccelKeyOnTab(tab);
      }
      try {
        if (configs.useCachedTree) {
          log(`trying to restore window ${window.id} from cache`);
          const restored = await MetricsData.addAsync(`rebuildAll: restore tabs in window ${window.id} from cache`, BackgroundCache.restoreWindowFromEffectiveWindowCache(window.id, {
            owner: window.tabs[window.tabs.length - 1],
            tabs:  window.tabs,
            caches: mPreloadedCaches
          }));
          restoredFromCache.set(window.id, restored);
          log(`window ${window.id}: restored from cache?: `, restored);
          if (restored)
            return;
        }
      }
      catch(e) {
        log(`failed to restore tabs for ${window.id} from cache `, e);
      }
      try {
        log(`build tabs for ${window.id} from scratch`);
        Window.init(window.id);
        for (let tab of window.tabs) {
          tab = Tab.get(tab.id);
          tab.$TST.clear(); // clear dirty restored states
          TabsUpdate.updateTab(tab, tab, { forceApply: true });
          tryStartHandleAccelKeyOnTab(tab);
        }
      }
      catch(e) {
        log(`failed to build tabs for ${window.id}`, e);
      }
      restoredFromCache.set(window.id, false);
    });
    for (const tab of Tab.getGroupTabs(window.id, { iterator: true })) {
      if (!tab.discarded)
        tab.$TST.shouldReloadOnSelect = true;
    }
  }));
  return restoredFromCache;
}

export async function reload(options = {}) {
  mPreloadedCaches.clear();
  for (const window of TabsStore.windows.values()) {
    window.clear();
  }
  TabsStore.clear();
  const windows = await getAllWindows();
  await MetricsData.addAsync('reload: rebuildAll', rebuildAll(windows));
  await MetricsData.addAsync('reload: TreeStructure.loadTreeStructure', TreeStructure.loadTreeStructure(windows));
  if (!options.all)
    return;
  for (const window of TabsStore.windows.values()) {
    if (!SidebarConnection.isOpen(window.id))
      continue;
    browser.runtime.sendMessage({
      type: Constants.kCOMMAND_RELOAD
    }).catch(ApiTabs.createErrorSuppressor());
  }
}

export async function tryStartHandleAccelKeyOnTab(tab) {
  if (!TabsStore.ensureLivingTab(tab))
    return;
  const granted = await Permissions.isGranted(Permissions.ALL_URLS);
  if (!granted ||
      /^(about|chrome|resource):/.test(tab.url))
    return;
  try {
    //log(`tryStartHandleAccelKeyOnTab: initialize tab ${tab.id}`);
    browser.tabs.executeScript(tab.id, {
      file:            '/common/handle-accel-key.js',
      allFrames:       true,
      matchAboutBlank: true,
      runAt:           'document_start'
    }).catch(ApiTabs.createErrorSuppressor(ApiTabs.handleMissingTabError));
  }
  catch(error) {
    console.log(error);
  }
}

export function reserveToUpdateInsertionPosition(tabOrTabs) {
  const tabs = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs] ;
  for (const tab of tabs) {
    if (!TabsStore.ensureLivingTab(tab))
      continue;
    const reserved = reserveToUpdateInsertionPosition.reserved.get(tab.windowId) || {
      timer: null,
      tabs:  new Set()
    };
    if (reserved.timer)
      clearTimeout(reserved.timer);
    reserved.tabs.add(tab);
    reserved.timer = setTimeout(() => {
      reserveToUpdateInsertionPosition.reserved.delete(tab.windowId);
      for (const tab of reserved.tabs) {
        if (!tab.$TST)
          continue;
        updateInsertionPosition(tab);
      }
    }, DELAY_TO_PROCESS_RESERVED_UPDATE_TASKS);
    reserveToUpdateInsertionPosition.reserved.set(tab.windowId, reserved);
  }
}
reserveToUpdateInsertionPosition.reserved = new Map();

async function updateInsertionPosition(tab) {
  if (!TabsStore.ensureLivingTab(tab))
    return;

  const prev = tab.hidden ? tab.$TST.unsafePreviousTab : tab.$TST.previousTab;
  if (prev)
    browser.sessions.setTabValue(
      tab.id,
      Constants.kPERSISTENT_INSERT_AFTER,
      prev.$TST.uniqueId.id
    ).catch(ApiTabs.createErrorSuppressor());
  else
    browser.sessions.removeTabValue(
      tab.id,
      Constants.kPERSISTENT_INSERT_AFTER
    ).catch(ApiTabs.createErrorSuppressor());

  const next = tab.hidden ? tab.$TST.unsafeNextTab : tab.$TST.nextTab;
  if (next)
    browser.sessions.setTabValue(
      tab.id,
      Constants.kPERSISTENT_INSERT_BEFORE,
      next.$TST.uniqueId.id
    ).catch(ApiTabs.createErrorSuppressor());
  else
    browser.sessions.removeTabValue(
      tab.id,
      Constants.kPERSISTENT_INSERT_BEFORE
    ).catch(ApiTabs.createErrorSuppressor());
}


export function reserveToUpdateAncestors(tabOrTabs) {
  const tabs = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs] ;
  for (const tab of tabs) {
    if (!TabsStore.ensureLivingTab(tab))
      continue;
    const reserved = reserveToUpdateAncestors.reserved.get(tab.windowId) || {
      timer: null,
      tabs:  new Set()
    };
    if (reserved.timer)
      clearTimeout(reserved.timer);
    reserved.tabs.add(tab);
    reserved.timer = setTimeout(() => {
      reserveToUpdateAncestors.reserved.delete(tab.windowId);
      for (const tab of reserved.tabs) {
        if (!tab.$TST)
          continue;
        updateAncestors(tab);
      }
    }, DELAY_TO_PROCESS_RESERVED_UPDATE_TASKS);
    reserveToUpdateAncestors.reserved.set(tab.windowId, reserved);
  }
}
reserveToUpdateAncestors.reserved = new Map();

async function updateAncestors(tab) {
  if (!TabsStore.ensureLivingTab(tab))
    return;

  browser.sessions.setTabValue(
    tab.id,
    Constants.kPERSISTENT_ANCESTORS,
    tab.$TST.ancestors.map(ancestor => ancestor.$TST.uniqueId.id)
  ).catch(ApiTabs.createErrorSuppressor());
}

export function reserveToUpdateChildren(tabOrTabs) {
  const tabs = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs] ;
  for (const tab of tabs) {
    if (!TabsStore.ensureLivingTab(tab))
      continue;
    const reserved = reserveToUpdateChildren.reserved.get(tab.windowId) || {
      timer: null,
      tabs:  new Set()
    };
    if (reserved.timer)
      clearTimeout(reserved.timer);
    reserved.tabs.add(tab);
    reserved.timer = setTimeout(() => {
      reserveToUpdateChildren.reserved.delete(tab.windowId);
      for (const tab of reserved.tabs) {
        if (!tab.$TST)
          continue;
        updateChildren(tab);
      }
    }, DELAY_TO_PROCESS_RESERVED_UPDATE_TASKS);
    reserveToUpdateChildren.reserved.set(tab.windowId, reserved);
  }
}
reserveToUpdateChildren.reserved = new Map();

async function updateChildren(tab) {
  if (!TabsStore.ensureLivingTab(tab))
    return;

  browser.sessions.setTabValue(
    tab.id,
    Constants.kPERSISTENT_CHILDREN,
    tab.$TST.children.map(child => child.$TST.uniqueId.id)
  ).catch(ApiTabs.createErrorSuppressor());
}

function reserveToUpdateSubtreeCollapsed(tab) {
  if (!mInitialized ||
      !TabsStore.ensureLivingTab(tab))
    return;
  const reserved = reserveToUpdateSubtreeCollapsed.reserved.get(tab.windowId) || {
    timer: null,
    tabs:  new Set()
  };
  if (reserved.timer)
    clearTimeout(reserved.timer);
  reserved.tabs.add(tab);
  reserved.timer = setTimeout(() => {
    reserveToUpdateSubtreeCollapsed.reserved.delete(tab.windowId);
    for (const tab of reserved.tabs) {
      if (!tab.$TST)
        continue;
      updateSubtreeCollapsed(tab);
    }
  }, DELAY_TO_PROCESS_RESERVED_UPDATE_TASKS);
  reserveToUpdateSubtreeCollapsed.reserved.set(tab.windowId, reserved);
}
reserveToUpdateSubtreeCollapsed.reserved = new Map();

async function updateSubtreeCollapsed(tab) {
  if (!TabsStore.ensureLivingTab(tab))
    return;
  if (tab.$TST.subtreeCollapsed)
    tab.$TST.addState(Constants.kTAB_STATE_SUBTREE_COLLAPSED, { permanently: true });
  else
    tab.$TST.removeState(Constants.kTAB_STATE_SUBTREE_COLLAPSED, { permanently: true });
}

export async function confirmToCloseTabs(tabs, { windowId, configKey, messageKey, titleKey } = {}) {
  const grantedIds = new Set(configs.grantedRemovingTabIds);
  let count = 0;
  const tabIds = [];
  tabs = tabs.map(tab => tab && Tab.get(tab.id)).filter(tab => {
    if (tab && !grantedIds.has(tab.id)) {
      count++;
      tabIds.push(tab.id);
      return true;
    }
    return false;
  });
  const shouldConfirm = configs[configKey || 'warnOnCloseTabs'];
  log('confirmToCloseTabs ', { tabIds, count, windowId, configKey, grantedIds, shouldConfirm });
  if (count <= 1 ||
      !shouldConfirm ||
      Date.now() - configs.lastConfirmedToCloseTabs < 500) {
    log('confirmToCloseTabs: skip confirmation and treated as granted');
    return true;
  }

  if (!windowId) {
    const activeTabs = await browser.tabs.query({
      active:   true,
      windowId
    }).catch(ApiTabs.createErrorHandler());
    windowId = activeTabs[0].windowId;
  }

  const listing = configs.warnOnCloseTabsWithListing ?
    tabsToHTMLList(tabs, { maxRows: configs.warnOnCloseTabsWithListingMaxRows }) :
    '';
  const dialogParams = {
    content: `
      <div>${sanitizeForHTMLText(browser.i18n.getMessage(messageKey || 'warnOnCloseTabs_message', [count]))}</div>${listing}
    `.trim(),
    buttons: [
      browser.i18n.getMessage('warnOnCloseTabs_close'),
      browser.i18n.getMessage('warnOnCloseTabs_cancel')
    ],
    checkMessage: browser.i18n.getMessage('warnOnCloseTabs_warnAgain'),
    checked: true
  };
  let result;
  UserOperationBlocker.blockIn(windowId, { throbber: false });
  try {
    if (configs.showDialogInSidebar &&
        SidebarConnection.isOpen(windowId)/* &&
        SidebarConnection.hasFocus(windowId)*/) {
      result = await browser.runtime.sendMessage({
        type:   Constants.kCOMMAND_SHOW_DIALOG,
        params: dialogParams,
        windowId
      }).catch(ApiTabs.createErrorHandler());
    }
    else {
      log('confirmToCloseTabs: show confirmation in a popup window on ', windowId);
      result = await RichConfirm.showInPopup(windowId, {
        ...dialogParams,
        onShown(container) {
          setTimeout(() => { // this need to be done on the next tick, to use the height of the box for     calculation of dialog size
            const style = container.querySelector('ul').style;
            style.height = '0px'; // this makes the box shrinkable
            style.maxHeight = 'none';
            style.minHeight = '0px';
          }, 0);
        },
        modal: true,
        type:  'common-dialog',
        url:   '/resources/blank.html', // required on Firefox ESR68
        title: browser.i18n.getMessage(titleKey || 'warnOnCloseTabs_title')
      });
    }
  }
  catch(_error) {
    result = { buttonIndex: -1 };
  }
  finally {
    UserOperationBlocker.unblockIn(windowId, { throbber: false });
  }

  log('confirmToCloseTabs: result = ', result);
  switch (result.buttonIndex) {
    case 0:
      if (!result.checked)
        configs.warnOnCloseTabs = false;
      configs.grantedRemovingTabIds = Array.from(new Set((configs.grantedRemovingTabIds || []).concat(tabIds)));
      log('confirmToCloseTabs: granted ', configs.grantedRemovingTabIds);
      reserveToClearGrantedRemovingTabs();
      return true;
    default:
      return false;
  }
}
Commands.onTabsClosing.addListener((tabIds, options = {}) => {
  return confirmToCloseTabs(tabIds.map(Tab.get), options);
});

export function tabsToHTMLList(tabs, { maxRows }) {
  const rootLevelOffset = tabs.map(tab => parseInt(tab.$TST.getAttribute(Constants.kLEVEL) || 0)).sort()[0];
  return (
    `<ul style="border: 1px inset;
                display: flex;
                flex-direction: column;
                flex-grow: 1;
                flex-shrink: 1;
                margin: 0.5em 0;
                min-height: ${(Math.max(1, maxRows || 0)) + 1}em;
                max-height: ${(Math.max(1, maxRows || 0)) + 1}em;
                overflow: auto;
                padding: 0.5em;">` +
      tabs.map(tab => `<li style="align-items: center;
                                  display: flex;
                                  flex-direction: row;
                                  padding-left: calc((${tab.$TST.getAttribute(Constants.kLEVEL)} - ${rootLevelOffset}) * 0.25em);"
                           title="${sanitizeForHTMLText(tab.title)}"
                          ><img style="display: flex;
                                       max-height: 1em;
                                       max-width: 1em;"
                                alt=""
                                src="${sanitizeForHTMLText(tab.favIconUrl || browser.extension.getURL('resources/icons/globe-16.svg'))}"
                               ><span style="display: flex;
                                             margin-left: 0.25em;
                                             overflow: hidden;
                                             white-space: nowrap;"
                                     >${sanitizeForHTMLText(tab.title)}</span></li>`).join('') +
      `</ul>`
  );
}

function reserveToClearGrantedRemovingTabs() {
  const lastGranted = configs.grantedRemovingTabIds.join(',');
  setTimeout(() => {
    if (configs.grantedRemovingTabIds.join(',') == lastGranted)
      configs.grantedRemovingTabIds = [];
  }, 1000);
}

Tab.onCreated.addListener((tab, info = {}) => {
  if (!info.duplicated)
    return;
  // Duplicated tab has its own tree structure information inherited
  // from the original tab, but they must be cleared.
  reserveToUpdateAncestors(tab);
  reserveToUpdateChildren(tab);
  reserveToUpdateInsertionPosition([
    tab,
    tab.hidden ? tab.$TST.unsafePreviousTab : tab.$TST.previousTab,
    tab.hidden ? tab.$TST.unsafeNextTab : tab.$TST.nextTab
  ]);
});

Tab.onUpdated.addListener((tab, changeInfo) => {
  // Loading of "about:(unknown type)" won't report new URL via tabs.onUpdated,
  // so we need to see the complete tab object.
  const status = changeInfo.status || tab && tab.status;
  const url = changeInfo.url ? changeInfo.url :
    status == 'complete' && tab ? tab.url : '';
  if (tab &&
      Constants.kSHORTHAND_ABOUT_URI.test(url)) {
    const shorthand = RegExp.$1;
    const oldUrl = tab.url;
    wait(100).then(() => { // redirect with delay to avoid infinite loop of recursive redirections.
      if (tab.url != oldUrl)
        return;
      browser.tabs.update(tab.id, {
        url: url.replace(Constants.kSHORTHAND_ABOUT_URI, Constants.kSHORTHAND_URIS[shorthand] || 'about:blank')
      }).catch(ApiTabs.createErrorSuppressor(ApiTabs.handleMissingTabError));
      if (shorthand == 'group')
        tab.$TST.addState(Constants.kTAB_STATE_GROUP_TAB, { permanently: true });
    });
  }

  if (changeInfo.status || changeInfo.url)
    tryStartHandleAccelKeyOnTab(tab);
});

Tab.onShown.addListener(tab => {
  if (configs.fixupTreeOnTabVisibilityChanged) {
    reserveToUpdateAncestors(tab);
    reserveToUpdateChildren(tab);
  }
  reserveToUpdateInsertionPosition([
    tab,
    tab.hidden ? tab.$TST.unsafePreviousTab : tab.$TST.previousTab,
    tab.hidden ? tab.$TST.unsafeNextTab : tab.$TST.nextTab
  ]);
});

Tab.onMutedStateChanged.addListener((root, toBeMuted) => {
  // Spread muted state of a parent tab to its collapsed descendants
  if (!root.$TST.subtreeCollapsed ||
      // We don't need to spread muted state to descendants of multiselected
      // tabs here, because tabs.update() was called with all multiselected tabs.
      root.$TST.multiselected ||
      // We should not spread muted state to descendants of collapsed tab
      // recursively, because they were already controlled from a visible
      // ancestor.
      root.$TST.collapsed)
    return;

  const tabs = root.$TST.descendants;
  for (const tab of tabs) {
    const playing = tab.$TST.soundPlaying;
    const muted   = tab.$TST.muted;
    log(`tab ${tab.id}: playing=${playing}, muted=${muted}`);
    if (configs.spreadMutedStateOnlyToSoundPlayingTabs &&
        !playing &&
        playing != toBeMuted)
      continue;

    log(` => set muted=${toBeMuted}`);
    browser.tabs.update(tab.id, {
      muted: toBeMuted
    }).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));

    const add = [];
    const remove = [];
    if (toBeMuted) {
      add.push(Constants.kTAB_STATE_MUTED);
      tab.$TST.addState(Constants.kTAB_STATE_MUTED);
    }
    else {
      remove.push(Constants.kTAB_STATE_MUTED);
      tab.$TST.removeState(Constants.kTAB_STATE_MUTED);
    }

    if (tab.audible && !toBeMuted) {
      add.push(Constants.kTAB_STATE_SOUND_PLAYING);
      tab.$TST.addState(Constants.kTAB_STATE_SOUND_PLAYING);
    }
    else {
      remove.push(Constants.kTAB_STATE_SOUND_PLAYING);
      tab.$TST.removeState(Constants.kTAB_STATE_SOUND_PLAYING);
    }

    // tabs.onUpdated is too slow, so users will be confused
    // from still-not-updated tabs (in other words, they tabs
    // are unresponsive for quick-clicks).
    Tab.broadcastState(tab, { add, remove });
  }
});

Tab.onTabInternallyMoved.addListener((tab, info = {}) => {
  reserveToUpdateInsertionPosition([
    tab,
    tab.hidden ? tab.$TST.unsafePreviousTab : tab.$TST.previousTab,
    tab.hidden ? tab.$TST.unsafeNextTab : tab.$TST.nextTab,
    info.oldPreviousTab,
    info.oldNextTab
  ]);
});

Tab.onMoved.addListener((tab, moveInfo) => {
  if (!moveInfo.isSubstantiallyMoved)
    return;
  reserveToUpdateInsertionPosition([
    tab,
    moveInfo.oldPreviousTab,
    moveInfo.oldNextTab,
    tab.hidden ? tab.$TST.unsafePreviousTab : tab.$TST.previousTab,
    tab.hidden ? tab.$TST.unsafeNextTab : tab.$TST.nextTab
  ]);
});

Tree.onAttached.addListener((tab, attachInfo) => {
  reserveToUpdateAncestors([tab].concat(tab.$TST.descendants));
  reserveToUpdateChildren(attachInfo.parent);
});

Tree.onDetached.addListener((tab, detachInfo) => {
  reserveToUpdateAncestors([tab].concat(tab.$TST.descendants));
  reserveToUpdateChildren(detachInfo.oldParentTab);
});

Tree.onSubtreeCollapsedStateChanging.addListener((tab, _info) => { reserveToUpdateSubtreeCollapsed(tab); });

// This section should be removed and define those flexible SVG icons
// statically on manifest.json on future versions of Firefox, after
// theming of extension icons are officially supported.
// See also:
//   https://github.com/piroor/treestyletab/issues/2053
//   https://bugzilla.mozilla.org/show_bug.cgi?id=1367042
function applyThemeColorToIcon() {
  if (configs.applyThemeColorToIcon) {
    const icons = { path: browser.runtime.getManifest().icons };
    browser.browserAction.setIcon(icons);
    browser.sidebarAction.setIcon(icons);
  }
}
configs.$loaded.then(applyThemeColorToIcon);

configs.$addObserver(key => {
  switch (key) {
    case 'style':
      updatePanelUrl();
      break;
    case 'applyThemeColorToIcon':
      applyThemeColorToIcon();
      break;
    case 'debug':
      EventListenerManager.debug = configs.debug;
      break;

    case 'testKey': // for tests/utils.js
      browser.runtime.sendMessage({
        type:  Constants.kCOMMAND_NOTIFY_TEST_KEY_CHANGED,
        value: configs.testKey
      });
      break;
  }
});
