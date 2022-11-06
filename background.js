// Param values from https://developer.mozilla.org/Add-ons/WebExtensions/API/contextualIdentities/create
const MICROSOFT_CONTAINER_NAME = "Microsoft";
const MICROSOFT_CONTAINER_COLOR = "blue";
const MICROSOFT_CONTAINER_ICON = "briefcase";

let MICROSOFT_DOMAINS = [
    "microsoft.com", "microsoft.org", "microsoft.net", "microsoft.co", "microsoft.co.uk", "microsoft.nl",
  "githubapp.com", "azurewebsites.net","azure-mobile.net","cloudapp.net",
  "microsoftproductionstudios.org", "azure.com", "windowsazure.com", "bing.com", "bing.net", "bingtoolbar.com", "outlook.com",
  "skype.com", "hotmail.com", "live.com", "sharepoint.com", "bingtoolbar.com", "internetexplorer.com",  "onedrive.com",
  "office.com","office365.com", "xbox.com", "visualstudio.com","microsoftvisualstudio.com",  "microsoftonline.com",
  "Surface.com", "Zone.com", "rare.com", "Sites.com", "msdn.com", "microsoftstream.com"
];

const GITHUB_DOMAINS = [
    "github.com", "github.io", "githubusercontent.com"
];

MICROSOFT_DOMAINS = MICROSOFT_DOMAINS.concat(GITHUB_DOMAINS);

const MAC_ADDON_ID = "@testpilot-containers";

let macAddonEnabled = false;
let microsoftCookieStoreId = null;
let extensionSettings = {};

const canceledRequests = {};
const tabsWaitingToLoad = {};
const microsoftHostREs = [];
const githubHostREs = [];
const whitelistedHostREs = [];
const allowlistedHostREs = [];

async function isMACAddonEnabled () {
  try {
    const macAddonInfo = await browser.management.get(MAC_ADDON_ID);
    if (macAddonInfo.enabled) {
      return true;
    }
  } catch (e) {
    return false;
  }
  return false;
}

async function setupMACAddonManagementListeners () {
  browser.management.onInstalled.addListener(info => {
    if (info.id === MAC_ADDON_ID) {
      macAddonEnabled = true;
    }
  });
  browser.management.onUninstalled.addListener(info => {
    if (info.id === MAC_ADDON_ID) {
      macAddonEnabled = false;
    }
  });
  browser.management.onEnabled.addListener(info => {
    if (info.id === MAC_ADDON_ID) {
      macAddonEnabled = true;
    }
  });
  browser.management.onDisabled.addListener(info => {
    if (info.id === MAC_ADDON_ID) {
      macAddonEnabled = false;
    }
  });
}

async function getMACAssignment (url) {
  if (!macAddonEnabled) {
    return false;
  }

  try {
    const assignment = await browser.runtime.sendMessage(MAC_ADDON_ID, {
      method: "getAssignment",
      url
    });
    return assignment;
  } catch (e) {
    return false;
  }
}

function cancelRequest (tab, options) {
  // we decided to cancel the request at this point, register canceled request
  canceledRequests[tab.id] = {
    requestIds: {
      [options.requestId]: true
    },
    urls: {
      [options.url]: true
    }
  };

  // since webRequest onCompleted and onErrorOccurred are not 100% reliable
  // we register a timer here to cleanup canceled requests, just to make sure we don't
  // end up in a situation where certain urls in a tab.id stay canceled
  setTimeout(() => {
    if (canceledRequests[tab.id]) {
      delete canceledRequests[tab.id];
    }
  }, 2000);
}

function shouldCancelEarly (tab, options) {
  // we decided to cancel the request at this point
  if (!canceledRequests[tab.id]) {
    cancelRequest(tab, options);
  } else {
    let cancelEarly = false;
    if (canceledRequests[tab.id].requestIds[options.requestId] ||
        canceledRequests[tab.id].urls[options.url]) {
      // same requestId or url from the same tab
      // this is a redirect that we have to cancel early to prevent opening two tabs
      cancelEarly = true;
    }
    // register this requestId and url as canceled too
    canceledRequests[tab.id].requestIds[options.requestId] = true;
    canceledRequests[tab.id].urls[options.url] = true;
    if (cancelEarly) {
      return true;
    }
  }
  return false;
}

function generateMicrosoftHostREs () {
  const matchOperatorsRegex = /[|\\{}()[\]^$+*?.-]/g;

  for (let microsoftDomain of MICROSOFT_DOMAINS) {
    microsoftDomain = microsoftDomain.replace(matchOperatorsRegex, '\\$&');
    microsoftHostREs.push(new RegExp(`(^|\\.)${microsoftDomain}$`));
  }
  for (let githubDomain of GITHUB_DOMAINS) {
    githubDomain = githubDomain.replace(matchOperatorsRegex, '\\$&');
    githubHostREs.push(new RegExp(`(^|\\.)${githubDomain}$`));
  }
}

function generateWhitelistedHostREs () {
 if (whitelistedHostREs.length != 0) {return;}
  const matchOperatorsRegex = /[|\\{}()[\]^$+*?.-]/g;
  for (let whitelistedDomain of extensionSettings.whitelist) {
    whitelistedDomain = whitelistedDomain.replace(matchOperatorsRegex, '\\$&');
    whitelistedHostREs.push(new RegExp(`(^|\\.)${whitelistedDomain}$`));
  }
}

function generateAllowlistedHostREs () {
 if (allowlistedHostREs.length != 0) {return;}
  const matchOperatorsRegex = /[|\\{}()[\]^$+*?.-]/g;
  for (let allowlistedDomain of extensionSettings.allowlist) {
    allowlistedDomain = allowlistedDomain.replace(matchOperatorsRegex, '\\$&');
    allowlistedHostREs.push(new RegExp(`(^|\\.)${allowlistedDomain}$`));
  }
}

async function loadExtensionSettings () {
  extensionSettings = await browser.storage.sync.get();
  if (extensionSettings.whitelist === undefined){
 	extensionSettings.whitelist = "";
  }
  if (extensionSettings.allowlist === undefined){
 	extensionSettings.allowlist = "";
  }
}

async function clearMicrosoftCookies () {
  // Clear all microsoft cookies
  const containers = await browser.contextualIdentities.query({});
  containers.push({
    cookieStoreId: "firefox-default"
  });

  let macAssignments = [];
  if (macAddonEnabled) {
    const promises = MICROSOFT_DOMAINS.map(async microsoftDomain => {
      const assigned = await getMACAssignment(`https://${microsoftDomain}/`);
      return assigned ? microsoftDomain : null;
    });
    macAssignments = await Promise.all(promises);
  }

  MICROSOFT_DOMAINS.map(async microsoftDomain => {
    const microsoftCookieUrl = `https://${microsoftDomain}/`;

    // dont clear cookies for microsoftDomain if mac assigned (with or without www.)
    if (macAddonEnabled &&
        (macAssignments.includes(microsoftDomain) ||
         macAssignments.includes(`www.${microsoftDomain}`))) {
      return;
    }

    containers.map(async container => {
      const storeId = container.cookieStoreId;
      if (storeId === microsoftCookieStoreId) {
        // Don't clear cookies in the Microsoft Container
        return;
      }

      const cookies = await browser.cookies.getAll({
        domain: microsoftDomain,
        storeId
      });

      cookies.map(cookie => {
        browser.cookies.remove({
          name: cookie.name,
          url: microsoftCookieUrl,
          storeId
        });
      });
    });
  });
}

async function setupContainer () {
  // Use existing Microsoft container, or create one
  const contexts = await browser.contextualIdentities.query({name: MICROSOFT_CONTAINER_NAME});
  if (contexts.length > 0) {
    microsoftCookieStoreId = contexts[0].cookieStoreId;
  } else {
    const context = await browser.contextualIdentities.create({
      name: MICROSOFT_CONTAINER_NAME,
      color: MICROSOFT_CONTAINER_COLOR,
      icon: MICROSOFT_CONTAINER_ICON
    });
    microsoftCookieStoreId = context.cookieStoreId;
  }
}

function reopenTab ({url, tab, cookieStoreId}) {
  browser.tabs.create({
    url,
    cookieStoreId,
    active: tab.active,
    index: tab.index + 1,
    windowId: tab.windowId
  });
  browser.tabs.remove(tab.id);
}

function isMicrosoftURL (url) {
  const parsedUrl = new URL(url);
  for (let microsoftHostRE of microsoftHostREs) {
    if (microsoftHostRE.test(parsedUrl.hostname)) {
      return true;
    }
  }
  return false;
}

function isGitHubURL (url) {
  const parsedUrl = new URL(url);
  for (let githubHostRE of githubHostREs) {
    if (githubHostRE.test(parsedUrl.hostname)) {
      return true;
    }
  }
  return false;
}

function isWhitelistedURL (url) {
  generateWhitelistedHostREs();
  const parsedUrl = new URL(url);
  for (let whitelistedHostRE of whitelistedHostREs) {
    if (whitelistedHostRE.test(parsedUrl.hostname)) {
      return true;
    }
  }
  return false;
}

function isAllowlistedURL (url) {
  generateAllowlistedHostREs();
  const parsedUrl = new URL(url);
  for (let allowlistedHostRE of allowlistedHostREs) {
    if (allowlistedHostRE.test(parsedUrl.hostname)) {
      return true;
    }
  }
  return false;
}

function shouldContainInto (url, tab) {
  if (!url.startsWith("http")) {
    // we only handle URLs starting with http(s)
    return false;
  }

  let handleUrl = isMicrosoftURL(url) || (extensionSettings.allowlist.length!=0 && isAllowlistedURL(url));

  if (handleUrl && extensionSettings.whitelist.length!=0 && isWhitelistedURL(url)) {
    handleUrl = false;
  }

  if (handleUrl && extensionSettings.ignore_github && isGitHubURL(url)) {
    handleUrl = false;
  }

  if (handleUrl) {
    if (tab.cookieStoreId !== microsoftCookieStoreId) {
      if (tab.cookieStoreId !== "firefox-default" && extensionSettings.dont_override_containers) {
        // Tab is already in a container, the user doesn't want us to override containers
        return false;
      }

      // Microsoft-URL outside of Microsoft Container Tab
      // Should contain into Microsoft Container
      return microsoftCookieStoreId;
    }
  } else if (tab.cookieStoreId === microsoftCookieStoreId) {
    // Non-Microsoft-URL inside Microsoft Container Tab
    // Should contain into Default Container
    return "firefox-default";
  }

  return false;
}

async function maybeReopenAlreadyOpenTabs () {
  const maybeReopenTab = async tab => {
    const macAssigned = await getMACAssignment(tab.url);
    if (macAssigned) {
      // We don't reopen MAC assigned urls
      return;
    }
    const cookieStoreId = shouldContainInto(tab.url, tab);
    if (!cookieStoreId) {
      // Tab doesn't need to be contained
      return;
    }
    reopenTab({
      url: tab.url,
      tab,
      cookieStoreId
    });
  };

  const tabsOnUpdated = (tabId, changeInfo, tab) => {
    if (changeInfo.url && tabsWaitingToLoad[tabId]) {
      // Tab we're waiting for switched it's url, maybe we reopen
      delete tabsWaitingToLoad[tabId];
      maybeReopenTab(tab);
    }
    if (tab.status === "complete" && tabsWaitingToLoad[tabId]) {
      // Tab we're waiting for completed loading
      delete tabsWaitingToLoad[tabId];
    }
    if (!Object.keys(tabsWaitingToLoad).length) {
      // We're done waiting for tabs to load, remove event listener
      browser.tabs.onUpdated.removeListener(tabsOnUpdated);
    }
  };

  // Query for already open Tabs
  const tabs = await browser.tabs.query({});
  tabs.map(async tab => {
    if (tab.incognito) {
      return;
    }
    if (tab.url === "about:blank") {
      if (tab.status !== "loading") {
        return;
      }
      // about:blank Tab is still loading, so we indicate that we wait for it to load
      // and register the event listener if we haven't yet.
      //
      // This is a workaround until platform support is implemented:
      // https://bugzilla.mozilla.org/show_bug.cgi?id=1447551
      // https://github.com/mozilla/multi-account-containers/issues/474
      tabsWaitingToLoad[tab.id] = true;
      if (!browser.tabs.onUpdated.hasListener(tabsOnUpdated)) {
        browser.tabs.onUpdated.addListener(tabsOnUpdated);
      }
    } else {
      // Tab already has an url, maybe we reopen
      maybeReopenTab(tab);
    }
  });
}

async function containMicrosoft (options) {
  // Listen to requests and open Microsoft into its Container,
  // open other sites into the default tab context
  if (options.tabId === -1) {
    // Request doesn't belong to a tab
    return;
  }
  if (tabsWaitingToLoad[options.tabId]) {
    // Cleanup just to make sure we don't get a race-condition with startup reopening
    delete tabsWaitingToLoad[options.tabId];
  }

  // We have to check with every request if the requested URL is assigned with MAC
  // because the user can assign URLs at any given time (needs MAC Events)
  const macAssigned = await getMACAssignment(options.url);
  if (macAssigned) {
    // This URL is assigned with MAC, so we don't handle this request
    return;
  }

  const tab = await browser.tabs.get(options.tabId);
  if (tab.incognito) {
    // We don't handle incognito tabs
    return;
  }

  // Check whether we should contain this request into another container
  const cookieStoreId = shouldContainInto(options.url, tab);
  if (!cookieStoreId) {
    // Request doesn't need to be contained
    return;
  }
  if (shouldCancelEarly(tab, options)) {
    // We need to cancel early to prevent multiple reopenings
    return {cancel: true};
  }
  // Decided to contain
  reopenTab({
    url: options.url,
    tab,
    cookieStoreId
  });
  return {cancel: true};
}

(async function init() {
  await setupMACAddonManagementListeners();
  macAddonEnabled = await isMACAddonEnabled();

  try {
    await setupContainer();
  } catch (error) {
    // TODO: Needs backup strategy
    // See https://github.com/mozilla/contain-facebook/issues/23
    // Sometimes this add-on is installed but doesn't get a microsoftCookieStoreId ?
    // eslint-disable-next-line no-console
    console.log(error);
    return;
  }
  loadExtensionSettings();
  clearMicrosoftCookies();
  generateMicrosoftHostREs();

  // Clean up canceled requests
  browser.webRequest.onCompleted.addListener((options) => {
    if (canceledRequests[options.tabId]) {
      delete canceledRequests[options.tabId];
    }
  },{urls: ["<all_urls>"], types: ["main_frame"]});
  browser.webRequest.onErrorOccurred.addListener((options) => {
    if (canceledRequests[options.tabId]) {
      delete canceledRequests[options.tabId];
    }
  },{urls: ["<all_urls>"], types: ["main_frame"]});

  // Add the request listener
  browser.webRequest.onBeforeRequest.addListener(containMicrosoft, {urls: ["<all_urls>"], types: ["main_frame"]}, ["blocking"]);

  maybeReopenAlreadyOpenTabs();
})();
