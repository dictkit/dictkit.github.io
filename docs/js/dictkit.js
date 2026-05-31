// ============================================================
// dictkit.js — Pure logic layer
// No DOM dependencies. Share global scope with script.js.
// ============================================================

// ── Constants ──

const DEBUG = false;
const DEFAULT_PAGE = {
    content: { count: 1, prefix: "" },
    header: { count: 0, prefix: "A" },
    footer: { count: 0, prefix: "C" },
};
const DEFAULT_IMAGE_INDEX = "0001";
const MAX_RESULTS = 10;
const PINYIN_MAP = {
    v: "ü",
    ẑ: "zh",
    ĉ: "ch",
    ŝ: "zh",
    ŋ: "ng"
};
const DEFAULT_IMAGE = `images/${DEFAULT_IMAGE_INDEX}.png`;
const DATA_FILE = "data/dicts.json";
const STORAGE_KEYS = {
    font: "dictkit:font",
    proxy: "dictkit:proxy",
};
const DEFAULT_FONTS = [
    { "id": "raw", "name": "默认", "stack": "system-ui, -apple-system, sans-serif" },
]

const PROXY_CACHE_DURATION = 30 * 60 * 1000; // 30分钟
const IMAGE_CACHE_CONFIG = {
    maxCacheSize: 200,
    preloadCount: 2,
    cacheExpiry: 24 * 60 * 60 * 1000, // 24 hours
};
const SEARCH_SUGGESTION_DEBOUNCE_MS = 100;
const SEARCH_SUGGESTION_MIN_LENGTH = 1;

const pinyinKeys = Object.keys(PINYIN_MAP).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const pinyinRegExp = new RegExp(pinyinKeys, "gi");
const keyToc = "toc";
const keyPinyin = "pinyin";

// ── State Variables ──

let fileInfoList = [];
let urlProxyList = [];
let metaConfigs = {};
let repoConfigs = {};
let currentDictRepo = null;
let currentImageIndex = DEFAULT_IMAGE_INDEX;
let selectedProxyId = "auto";
let imageLoadToken = 0;

// ── Storage ──

function getStorageValue(key, fallback) {
    try {
        return localStorage.getItem(key) || fallback;
    } catch (error) {
        return fallback;
    }
}

function setStorageValue(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (error) {
        if (DEBUG) {
            console.warn("Unable to persist preference", key, error);
        }
    }
}

// ── Proxy Helpers ──

function inferProxyName(url, index) {
    if (url.includes("jsdmirror")) return "JSDMirror";
    if (url.includes("fastly.jsdelivr")) return "jsDelivr Fastly";
    if (url.includes("cdn.jsdelivr")) return "jsDelivr";
    if (url.includes("ghproxy")) return "GHProxy";
    if (url.includes("raw.githubusercontent")) return "GitHub Raw";
    return `资源 ${index + 1}`;
}

function normalizeProxyEntries(urls) {
    return (urls || [])
        .map((entry, index) => {
            if (typeof entry === "string") {
                return {
                    id: `source-${index}`,
                    name: inferProxyName(entry, index),
                    url: entry,
                };
            }
            if (!entry || !entry.url) {
                return null;
            }
            return {
                id: entry.id || `source-${index}`,
                name: entry.name || inferProxyName(entry.url, index),
                url: entry.url,
            };
        })
        .filter(Boolean);
}

function getProxyCandidates(urls, proxyId) {
    if (!proxyId || proxyId === "auto") {
        return urls;
    }
    const selected = urls.find(proxy => proxy.id === proxyId);
    if (!selected) {
        return urls;
    }
    return [selected, ...urls.filter(proxy => proxy.id !== proxyId)];
}

// ── Proxy Cache ──

const proxyCache = {
    states: {
        image: {
            lastSuccessProxy: null,
            lastSuccessTime: 0,
            failedProxies: new Set(),
        },
        metadata: {
            lastSuccessProxy: null,
            lastSuccessTime: 0,
            failedProxies: new Set(),
        },
    },

    getState(kind = "image") {
        if (!this.states[kind]) {
            this.states[kind] = {
                lastSuccessProxy: null,
                lastSuccessTime: 0,
                failedProxies: new Set(),
            };
        }
        return this.states[kind];
    },

    updateProxy(proxy, kind = "image") {
        const state = this.getState(kind);
        state.lastSuccessProxy = proxy;
        state.lastSuccessTime = Date.now();
        state.failedProxies.delete(proxy);
    },

    addFail(proxy, kind = "image") {
        this.getState(kind).failedProxies.add(proxy);
    },

    clear(kind = "image") {
        const state = this.getState(kind);
        state.lastSuccessProxy = null;
        state.lastSuccessTime = 0;
        state.failedProxies.clear();
    },

    clearAll() {
        Object.keys(this.states).forEach(kind => this.clear(kind));
    },

    getBestProxy(urls, proxyId = "auto", kind = "image") {
        const now = Date.now();
        const state = this.getState(kind);
        const candidates = getProxyCandidates(urls, proxyId);
        if (state.lastSuccessProxy &&
            candidates.includes(state.lastSuccessProxy) &&
            now - state.lastSuccessTime < PROXY_CACHE_DURATION) {
            return state.lastSuccessProxy;
        }
        if (now - state.lastSuccessTime >= PROXY_CACHE_DURATION) {
            state.failedProxies.clear();
        }
        return candidates.find(proxy => !state.failedProxies.has(proxy)) || null;
    }
};

// ── Image Cache ──

const imageCache = {
    cache: new Map(),
    loadingPromises: new Map(),
    preloadedImages: new Set(),

    getKey(imagePath) {
        return `${currentDictRepo}_${imagePath}`;
    },

    isCached(imagePath) {
        const key = this.getKey(imagePath);
        const cached = this.cache.get(key);
        if (!cached) return false;
        if (Date.now() - cached.timestamp > IMAGE_CACHE_CONFIG.cacheExpiry) {
            this.cache.delete(key);
            return false;
        }
        return true;
    },

    getCached(imagePath) {
        const key = this.getKey(imagePath);
        const cached = this.cache.get(key);
        return cached ? cached.url : null;
    },

    setCached(imagePath, url) {
        const key = this.getKey(imagePath);
        if (this.cache.size >= IMAGE_CACHE_CONFIG.maxCacheSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }
        this.cache.set(key, {
            url: url,
            timestamp: Date.now(),
            imagePath: imagePath
        });
    },

    clearCurrentDict(dictRepo = currentDictRepo) {
        const prefix = `${dictRepo}_`;
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
        for (const key of this.loadingPromises.keys()) {
            if (key.startsWith(prefix)) {
                this.loadingPromises.delete(key);
            }
        }
        for (const key of this.preloadedImages.keys()) {
            if (key.startsWith(prefix)) {
                this.preloadedImages.delete(key);
            }
        }
    }
};

// ── Data Loading ──

async function loadJSONFile(filePath) {
    try {
        const response = await fetch(filePath);
        if (!response.ok) {
            throw new Error(`加载失败: ${filePath} (状态码 ${response.status})`);
        }
        return await response.json();
    } catch (error) {
        console.error(`加载文件出错: ${filePath}`, error);
        return null;
    }
}

function getFileList(files, dirPath) {
    return files.map(item => ({
        key: item.key,
        path: `${dirPath}/${item.path}`
    }));
}

function buildUrl(urlTemplate, owner, repo, branch, path) {
    const params = { owner, repo, branch, filepath: path };
    return urlTemplate.replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
        return key in params ? params[key] : `:${key}`;
    });
}

async function initializeDictData(repo) {
    const owner = metaConfigs.owner;
    const branch = metaConfigs.branch;
    const dataPath = metaConfigs.dataPath;
    const files = fileInfoList;
    const currentDictData = {};
    if (!repo) {
        console.error("No repository specified");
        return;
    }
    if (DEBUG) {
        console.log("Loading dict", repo);
    }

    const fileList = getFileList(files, dataPath);
    await Promise.all(fileList.map(async ({ key, path }) => {
        currentDictData[key] = null;
        const candidates = getProxyCandidates(urlProxyList, selectedProxyId);
        let proxy = proxyCache.getBestProxy(candidates, "auto", "metadata");
        let fileLoaded = false;

        while (proxy) {
            try {
                const repoURL = buildUrl(proxy.url, owner, repo, branch, path);
                const result = await loadJSONFile(repoURL);
                if (result) {
                    currentDictData[key] = result;
                    proxyCache.updateProxy(proxy, "metadata");
                    fileLoaded = true;
                    break;
                }
            } catch (error) {
                console.warn(`Failed to load ${path} from ${proxy.name}`, error);
            }
            proxyCache.addFail(proxy, "metadata");
            proxy = proxyCache.getBestProxy(candidates, "auto", "metadata");
        }

        if (!fileLoaded) {
            console.error(`Failed to load ${path} from all mirrors`);
        }
    }));

    return currentDictData;
}

// ── Page Helpers ──

function padPage(page) {
    return String(page).padStart(4, "0");
}

function isNumeric(str) {
    return /^[1-9]\d*$/.test(String(str).trim());
}

function isValidPageId(page, pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE) {
    const pageId = String(page).trim();
    if (!pageId) return false;

    const contentCount = pageConfigs.content.count;
    const headerCount = pageConfigs.header.count;
    const footerCount = pageConfigs.footer.count;

    if (isNumeric(pageId)) {
        const pageNumber = parseInt(pageId, 10);
        return pageNumber > 0 && pageNumber <= contentCount;
    }

    if (pageId.startsWith(pageConfigs.header.prefix)) {
        const pageNumber = parseInt(pageId.slice(pageConfigs.header.prefix.length), 10);
        return pageNumber > 0 && pageNumber <= headerCount;
    }

    if (pageId.startsWith(pageConfigs.footer.prefix)) {
        const pageNumber = parseInt(pageId.slice(pageConfigs.footer.prefix.length), 10);
        return pageNumber > 0 && pageNumber <= footerCount;
    }

    return false;
}

function normalizePageId(page, pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE) {
    const pageId = String(page).trim();
    if (!isValidPageId(pageId, pageConfigs)) return null;
    if (isNumeric(pageId)) return padPage(pageId);
    return pageId;
}

function fixPinyin(pinyin) {
    const out = pinyin.replace(pinyinRegExp, match => PINYIN_MAP[match]);
    return out == "ei" ? "ê" : out;
}

function getFirstPageId(pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE) {
    if (pageConfigs.header.count > 0) {
        return `${pageConfigs.header.prefix}${padPage(1)}`;
    }
    if (pageConfigs.content.count > 0) {
        return padPage(1);
    }
    if (pageConfigs.footer.count > 0) {
        return `${pageConfigs.footer.prefix}${padPage(1)}`;
    }
    return DEFAULT_IMAGE_INDEX;
}

function getImagePath(page, suffix) {
    const pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE;
    const isExtra = page.startsWith(pageConfigs.header.prefix) || page.startsWith(pageConfigs.footer.prefix);
    const imageDir = isExtra ? metaConfigs.imageExtra : metaConfigs.imageDir;
    return `${imageDir}/${page}.${suffix}`;
}

// ── Image Loading ──

function getImageCandidates(owner, repo, branch, imagePath) {
    const candidates = getProxyCandidates(urlProxyList, selectedProxyId);
    const bestProxy = proxyCache.getBestProxy(urlProxyList, selectedProxyId, "image");
    const orderedCandidates = bestProxy
        ? [bestProxy, ...candidates.filter(proxy => proxy !== bestProxy)]
        : candidates;

    return orderedCandidates.map(proxy => ({
        proxy,
        url: buildUrl(proxy.url, owner, repo, branch, imagePath),
    }));
}

function loadImageElement(url) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.decoding = "async";
        image.onload = () => resolve(url);
        image.onerror = () => reject(new Error(`Image load failed: ${url}`));
        image.src = url;
    });
}

async function _loadImageFromRemote(owner, repo, branch, imagePath) {
    const candidates = getImageCandidates(owner, repo, branch, imagePath);

    for (const { proxy, url } of candidates) {
        try {
            const loadedUrl = await loadImageElement(url);
            proxyCache.updateProxy(proxy, "image");
            return loadedUrl;
        } catch (error) {
            if (DEBUG) {
                console.warn(`Failed to load image from ${proxy.name}`, error);
            }
            proxyCache.addFail(proxy, "image");
        }
    }

    throw new Error(`Failed to load image from all mirrors: ${imagePath}`);
}

async function getImageLink(owner, repo, branch, imagePath) {
    if (imageCache.isCached(imagePath)) {
        const cachedUrl = imageCache.getCached(imagePath);
        if (cachedUrl) return cachedUrl;
    }

    const cacheKey = imageCache.getKey(imagePath);
    if (imageCache.loadingPromises.has(cacheKey)) {
        return imageCache.loadingPromises.get(cacheKey);
    }

    const loadingPromise = _loadImageFromRemote(owner, repo, branch, imagePath);
    imageCache.loadingPromises.set(cacheKey, loadingPromise);

    try {
        const url = await loadingPromise;
        imageCache.setCached(imagePath, url);
        return url;
    } finally {
        imageCache.loadingPromises.delete(cacheKey);
    }
}

function scheduleIdleTask(callback) {
    if ("requestIdleCallback" in window) {
        window.requestIdleCallback(callback, { timeout: 1200 });
        return;
    }
    window.setTimeout(callback, 150);
}

function _preloadAdjacentImages(currentIndex, limit, suffix, owner, repo, branch) {
    if (limit <= 0) return;

    for (let offset = -limit; offset <= limit; offset++) {
        if (offset === 0) continue;

        const page = changePage(currentIndex, offset);
        if (page === currentIndex) continue;

        const imagePath = getImagePath(page, suffix);
        const preloadKey = imageCache.getKey(imagePath);
        if (imageCache.isCached(imagePath) || imageCache.preloadedImages.has(preloadKey)) {
            continue;
        }

        imageCache.preloadedImages.add(preloadKey);
        getImageLink(owner, repo, branch, imagePath).catch(error => {
            imageCache.preloadedImages.delete(preloadKey);
            if (DEBUG) {
                console.warn("Preload failed:", imagePath, error);
            }
        });
    }
}

async function preLoadImages(index, limit) {
    const suffix = metaConfigs.imageSuffix;
    const repo = currentDictRepo;
    const owner = metaConfigs.owner;
    const branch = metaConfigs.branch;
    const imagePath = getImagePath(index, suffix);
    const imageUrl = await getImageLink(owner, repo, branch, imagePath);

    if (limit > 0) {
        scheduleIdleTask(() => {
            _preloadAdjacentImages(index, limit, suffix, owner, repo, branch);
        });
    }

    return imageUrl;
}

// ── Navigation ──

function changePage(currentPage, offset = 1) {
    const pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE;
    const header_pages = pageConfigs.header.count;
    const main_pages = header_pages + pageConfigs.content.count;
    const total_pages = main_pages + pageConfigs.footer.count;
    let currentGroup, currentNum, currentIndex, nextPage;
    currentPage = String(currentPage);

    if (currentPage.startsWith(pageConfigs.header.prefix)) {
        currentGroup = pageConfigs.header.prefix;
    } else if (currentPage.startsWith(pageConfigs.footer.prefix)) {
        currentGroup = pageConfigs.footer.prefix;
    } else {
        currentGroup = pageConfigs.content.prefix;
    }
    currentNum = parseInt(currentPage.slice(currentGroup.length), 10);

    switch (currentGroup) {
        case pageConfigs.header.prefix:
            currentIndex = currentNum - 1;
            break;
        case pageConfigs.content.prefix:
            currentIndex = header_pages + (currentNum - 1);
            break;
        case pageConfigs.footer.prefix:
            currentIndex = main_pages + (currentNum - 1);
            break;
        default:
            return currentPage;
    }

    const targetIndex = currentIndex + offset;
    if (targetIndex < 0 || targetIndex >= total_pages) {
        return currentPage;
    }

    if (targetIndex < header_pages) {
        nextPage = targetIndex + 1;
        currentGroup = pageConfigs.header.prefix;
    } else if (targetIndex < main_pages) {
        nextPage = targetIndex - header_pages + 1;
        currentGroup = pageConfigs.content.prefix;
    } else {
        nextPage = targetIndex - main_pages + 1;
        currentGroup = pageConfigs.footer.prefix;
    }

    return `${currentGroup}${padPage(nextPage)}`;
}

// ── Search ──

function matchWeight(term, query) {
    if (term === query) return 0;
    else if (term.startsWith(query)) return 1;
    else if (term.endsWith(query)) return 2;
    return 3;
}

function searchInDictionary(query, limit) {
    const results = [];
    const seen = new Set();
    const maxLimit = limit * 3;
    const normalizedQuery = query.toLowerCase().trim();
    const pinyinQuery = fixPinyin(normalizedQuery);
    const searchCategories = fileInfoList;
    const currentDictData = repoConfigs[currentDictRepo];

    if (DEBUG) {
        console.log("query", normalizedQuery, pinyinQuery);
    }

    for (const { key, type, weight } of searchCategories) {
        if (!currentDictData[key]) continue;
        if (key === keyPinyin && pinyinQuery !== normalizedQuery) {
            if (Object.hasOwn(currentDictData[key], pinyinQuery)) {
                const pages = Array.isArray(currentDictData[key][pinyinQuery])
                    ? currentDictData[key][pinyinQuery]
                    : [currentDictData[key][pinyinQuery]];
                pages.forEach((page) => {
                    const pageId = padPage(page);
                    const dedupeKey = `${key}:${pinyinQuery}:${pageId}`;
                    if (seen.has(dedupeKey)) return;
                    seen.add(dedupeKey);
                    results.push({
                        term: pinyinQuery,
                        page: pageId,
                        type,
                        key,
                        score: weight,
                    });
                });
            }
        }
        for (const [term, value] of Object.entries(currentDictData[key])) {
            if (
                (term.includes(normalizedQuery) && key !== keyPinyin) ||
                (term.startsWith(normalizedQuery) && key === keyPinyin)
            ) {
                const pages = Array.isArray(value) ? value : [value];
                pages.forEach((page) => {
                    const pageId = padPage(page);
                    const dedupeKey = `${key}:${term}:${pageId}`;
                    if (seen.has(dedupeKey)) return;
                    seen.add(dedupeKey);
                    results.push({
                        term,
                        page: pageId,
                        type,
                        key,
                        score: matchWeight(term, normalizedQuery) + weight,
                    });
                });
                if (results.length >= maxLimit) break;
            }
        }
        if (results.length >= maxLimit) break;
    }

    return results.sort((a, b) => a.score - b.score || a.page.localeCompare(b.page));
}
