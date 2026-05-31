const DEBUG = false;
const DEFAULT_PAGE = {
    content: { count: 1, prefix: "" },
    header: { count: 0, prefix: "A" },
    footer: { count: 0, prefix: "C" },
};
const DEFAULT_IMAGE_INDEX = "0001";
const MAX_RESULTS = 10;
const PINYIN_MAP = {
    // 拼音小写：āáǎàōóǒòēéěèīíǐìūúǔùüǖǘǚǜêê̄ếê̌ềm̄ḿm̀ńňǹẑĉŝŋ
    // 拼音大写：ĀÁǍÀŌÓǑÒĒÉĚÈĪÍǏÌŪÚǓÙÜǕǗǙǛÊÊ̄ẾÊ̌ỀM̄ḾM̀ŃŇǸẐĈŜŊ
    v: "ü",
    ẑ: "zh", ĉ: "zh", ŝ: "zh",
    ŋ: "ng"
}
const DEFAULT_IMAGE = `assets/images/${DEFAULT_IMAGE_INDEX}.png`;
const DATA_FILE = "dicts.json";
const STORAGE_KEYS = {
    font: "dictkit:font",
    proxy: "dictkit:proxy",
};

const FONT_OPTIONS = [
    {
        id: "kinghwa",
        name: "京华老宋",
        stack: "'KingHwaOldSong', 'Times New Roman', system-ui, -apple-system, serif",
    },
    {
        id: "system",
        name: "系统默认",
        stack: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    },
    {
        id: "song",
        name: "宋体",
        stack: "'SimSun', 'Songti SC', 'Noto Serif CJK SC', serif",
    },
    {
        id: "hei",
        name: "黑体",
        stack: "'PingFang SC', 'SimHei', 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif",
    },
    {
        id: "kai",
        name: "楷体",
        stack: "'KaiTi', 'Kaiti SC', 'STKaiti', serif",
    },
    {
        id: "fangsong",
        name: "仿宋",
        stack: "'FangSong', 'STFangsong', serif",
    },
];

let fileInfoList = [];
let urlProxyList = [];
let metaConfigs = {};
let repoConfigs = {};
let currentDictRepo = null;
let currentImageIndex = DEFAULT_IMAGE_INDEX;
let selectedProxyId = "auto";
let searchIsSetup = false;
let imageLoadToken = 0;

const pinyinKeys = Object.keys(PINYIN_MAP).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const pinyinRegExp = new RegExp(pinyinKeys, "gi");
const keyToc = "toc";
const keyPinyin = "pinyin";

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

function setStatusMessage(message) {
    const divResult = document.getElementById("searchResult");
    if (divResult) {
        divResult.textContent = message;
    }
}

const PROXY_CACHE_DURATION = 30 * 60 * 1000; // 30分钟
const proxyCache = {
    lastSuccessProxy: null,
    lastSuccessTime: 0,
    failedProxies: new Set(),

    updateProxy(proxy) {
        this.lastSuccessProxy = proxy;
        this.lastSuccessTime = Date.now();
        this.failedProxies.delete(proxy);
    },

    addFail(proxy) {
        this.failedProxies.add(proxy);
    },

    getBestProxy(urls, proxyId = "auto") {
        // 获取候选
        const now = Date.now();
        const candidates = getProxyCandidates(urls, proxyId);
        if (this.lastSuccessProxy &&
            candidates.includes(this.lastSuccessProxy) &&
            now - this.lastSuccessTime < PROXY_CACHE_DURATION) {
            return this.lastSuccessProxy;
        }
        if (now - this.lastSuccessTime >= PROXY_CACHE_DURATION) {
            this.failedProxies.clear();
        }
        return candidates.find(proxy => !this.failedProxies.has(proxy)) || null;
    }
};

const IMAGE_CACHE_CONFIG = {
    maxCacheSize: 200,
    preloadCount: 2,
    cacheExpiry: 24 * 60 * 60 * 1000, // 24 hours
};
const imageCache = {
    cache: new Map(), // 缓存图片
    loadingPromises: new Map(),
    preloadedImages: new Set(),

    // Generate cache key for an image
    getKey(imagePath) {
        return `${currentDictRepo}_${imagePath}`;
    },

    // Check if image is cached and not expired
    isCached(imagePath) {
        const key = this.getKey(imagePath);
        const cached = this.cache.get(key);
        if (!cached) return false;

        // Check expiry
        if (Date.now() - cached.timestamp > IMAGE_CACHE_CONFIG.cacheExpiry) {
            this.cache.delete(key);
            return false;
        }
        return true;
    },

    // Get cached image URL
    getCached(imagePath) {
        const key = this.getKey(imagePath);
        const cached = this.cache.get(key);
        return cached ? cached.url : null;
    },

    // Cache image URL
    setCached(imagePath, url) {
        const key = this.getKey(imagePath);

        // If cache is full, remove oldest entries
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

    // Clear cache for current dictionary
    clearCurrentDict() {
        const prefix = `${currentDictRepo}_`;
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
        this.loadingPromises.clear();
        this.preloadedImages.clear();
    }
};

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
    const params = {
        owner: owner,
        repo: repo,
        branch: branch,
        filepath: path
    };

    return urlTemplate.replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
        return key in params ? params[key] : `:${key}`;
    });
}

function fixPinyin(pinyin) {
    // pinyin.replace(/[*·]+|[0-9]+$/g, "")
    const out = pinyin.replace(pinyinRegExp, match => PINYIN_MAP[match]);
    return out == "ei" ? "ê" : out;
}

function padPage(page) {
    return String(page).padStart(4, "0");
}

function isNumeric(str) {
    return !isNaN(str) && !isNaN(parseInt(str));
}

function applyFontPreference(fontId) {
    const selectedFont = FONT_OPTIONS.find(option => option.id === fontId) || FONT_OPTIONS[0];
    document.documentElement.style.setProperty("--font", selectedFont.stack);
    setStorageValue(STORAGE_KEYS.font, selectedFont.id);
    return selectedFont.id;
}

function initializeFontSelector() {
    const fontSelector = document.getElementById("fontSelector");
    if (!fontSelector) return;

    fontSelector.innerHTML = "";
    FONT_OPTIONS.forEach((font) => {
        const option = document.createElement("option");
        option.value = font.id;
        option.textContent = font.name;
        fontSelector.appendChild(option);
    });

    const fontId = getStorageValue(STORAGE_KEYS.font, FONT_OPTIONS[0].id);
    fontSelector.value = applyFontPreference(fontId);
    fontSelector.addEventListener("change", (event) => {
        applyFontPreference(event.target.value);
    });
}

function initializeProxySelector() {
    const proxySelector = document.getElementById("proxySelector");
    if (!proxySelector) return;

    proxySelector.innerHTML = "";
    const autoOption = document.createElement("option");
    autoOption.value = "auto";
    autoOption.textContent = "自动选择";
    proxySelector.appendChild(autoOption);

    urlProxyList.forEach((proxy) => {
        const option = document.createElement("option");
        option.value = proxy.id;
        option.textContent = proxy.name;
        proxySelector.appendChild(option);
    });

    selectedProxyId = getStorageValue(STORAGE_KEYS.proxy, "auto");
    if (!getProxyCandidates(urlProxyList, selectedProxyId).length) {
        selectedProxyId = "auto";
    }
    proxySelector.value = selectedProxyId;
    proxySelector.addEventListener("change", (event) => {
        selectedProxyId = event.target.value;
        proxyCache.failedProxies.clear();
        proxyCache.lastSuccessProxy = null;
        setStorageValue(STORAGE_KEYS.proxy, selectedProxyId);
    });
}

function initializeSettingsPanel() {
    const settingsToggle = document.getElementById("settingsToggle");
    const settingsPanel = document.getElementById("settingsPanel");
    if (!settingsToggle || !settingsPanel) return;

    initializeFontSelector();
    initializeProxySelector();

    settingsToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        const isOpen = settingsPanel.classList.toggle("active");
        settingsToggle.classList.toggle("active", isOpen);
        settingsToggle.setAttribute("aria-expanded", String(isOpen));
    });

    settingsPanel.addEventListener("click", event => event.stopPropagation());
    document.addEventListener("click", () => {
        settingsPanel.classList.remove("active");
        settingsToggle.classList.remove("active");
        settingsToggle.setAttribute("aria-expanded", "false");
    });
}

async function getImageLink(owner, repo, branch, imagePath) {
    // Check cache first
    if (imageCache.isCached(imagePath)) {
        const cachedUrl = imageCache.getCached(imagePath);
        if (cachedUrl) {
            return cachedUrl;
        }
    }

    // Check if already loading
    const cacheKey = imageCache.getKey(imagePath);
    if (imageCache.loadingPromises.has(cacheKey)) {
        return imageCache.loadingPromises.get(cacheKey);
    }

    // Create loading promise
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

function getImageCandidates(owner, repo, branch, imagePath) {
    const candidates = getProxyCandidates(urlProxyList, selectedProxyId);
    const bestProxy = proxyCache.getBestProxy(urlProxyList, selectedProxyId);
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

// Separate function for actual remote loading
async function _loadImageFromRemote(owner, repo, branch, imagePath) {
    const candidates = getImageCandidates(owner, repo, branch, imagePath);

    for (const { proxy, url } of candidates) {
        try {
            const loadedUrl = await loadImageElement(url);
            proxyCache.updateProxy(proxy);
            return loadedUrl;
        } catch (error) {
            if (DEBUG) {
                console.warn(`Failed to load image from ${proxy.name}`, error);
            }
            proxyCache.addFail(proxy);
        }
    }

    throw new Error(`Failed to load image from all mirrors: ${imagePath}`);
}

async function initializeDictSelector() {
    try {
        const data = await loadJSONFile(DATA_FILE);
        const dictConfigs = data.dicts || [];
        urlProxyList = normalizeProxyEntries(data.urls || []);
        metaConfigs = data.config || {}
        fileInfoList = data.files || [];
        initializeSettingsPanel();

        const dictSelector = document.getElementById("dictSelector");
        const dictLogo = document.getElementById("dictLogo");

        // Clear existing options
        dictSelector.innerHTML = "";

        // Set default selection and load first dictionary
        if (dictConfigs.length > 0) {
            currentDictRepo = dictConfigs[0].repo;
            repoConfigs = dictConfigs.reduce((acc, item) => {
                acc[item.repo] = item;
                return acc
            }, {});

            dictConfigs.forEach((dict) => {
                const repo = dict.repo;
                const logoImage = `assets/logos/${repo}.png`;
                repoConfigs[repo].logo = logoImage;

                const option = document.createElement("option");
                option.value = repo;
                option.textContent = dict.name;
                option.dataset.logo = logoImage;
                dictSelector.appendChild(option);
            });

            // 获取所有词典信息
            const promises = dictConfigs.map(async (dict) => {
                const data = await initializeDictData(dict.repo);
                return { repo: dict.repo, data };
            });
            const results = await Promise.all(promises);
            results.forEach(item => {
                repoConfigs[item.repo] = { ...repoConfigs[item.repo], ...item.data };
            });

            dictSelector.addEventListener("change", async (e) => {
                const selectedOption = e.target.options[e.target.selectedIndex];
                const selectedDict = dictConfigs.find(dict => dict.repo === e.target.value);

                if (!selectedDict) {
                    return
                }
                currentDictRepo = selectedDict.repo;
                if (DEBUG) {
                    console.log("Switch dict", currentDictRepo);
                }

                // Update the logo
                dictLogo.src = selectedOption.dataset.logo;
                dictLogo.alt = `${selectedDict.name} Logo`;
                document.getElementById("searchInput").value = "";
                document.getElementById("searchSuggestions").textContent = "";
                document.getElementById("searchResult").textContent = "";
                await initializeDictionaryView();
            });

            // Set the logo for the first dictionary
            dictLogo.src = repoConfigs[currentDictRepo].logo;
            dictLogo.alt = `${repoConfigs[currentDictRepo].name} Logo`;
            await initializeFromURL();
            document.body.dataset.ready = "true";
        }
    } catch (error) {
        console.error("Failed to load dictionary list:", error);
    }
}

async function initializeDictionaryView() {
    const bookmarksList = document.getElementById("bookmarksList");
    if (!currentDictRepo) {
        console.error("No dictionary selected");
        if (bookmarksList) {
            bookmarksList.innerHTML = "未找到可用的词典，请检查网络连接";
        }
        return false;
    }

    setupSearch(MAX_RESULTS);
    await showImage();
    await setupBookmarks();
    return true;
}

async function initializeDictData(repo) {
    // const repo = currentDictRepo;
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
    for (const { key, path } of fileList) {
        currentDictData[key] = null;
        const candidates = getProxyCandidates(urlProxyList, selectedProxyId);
        let proxy = proxyCache.getBestProxy(candidates);
        let fileLoaded = false;

        while (proxy) {
            try {
                const repoURL = buildUrl(proxy.url, owner, repo, branch, path);
                const result = await loadJSONFile(repoURL);
                if (result) {
                    currentDictData[key] = result;
                    proxyCache.updateProxy(proxy);
                    fileLoaded = true;
                    break;
                }
            } catch (error) {
                console.warn(`Failed to load ${path} from ${proxy.name}`, error);
            }
            proxyCache.addFail(proxy);
            proxy = proxyCache.getBestProxy(candidates);
        }

        if (!fileLoaded) {
            console.error(`Failed to load ${path} from all mirrors`);
        }
    }

    return currentDictData;
}

function getImagePath(page, suffix) {
    const pageConfigs = repoConfigs[currentDictRepo].pages || DEFAULT_PAGE;
    const isExtra = page.startsWith(pageConfigs.header.prefix) || page.startsWith(pageConfigs.footer.prefix);
    const imageDir = isExtra ? metaConfigs.imageExtra : metaConfigs.imageDir;
    const imagePath = `${imageDir}/${page}.${suffix}`;
    return imagePath
}

function scheduleIdleTask(callback) {
    if ("requestIdleCallback" in window) {
        window.requestIdleCallback(callback, { timeout: 1200 });
        return;
    }
    window.setTimeout(callback, 150);
}

// Preload adjacent images for smooth navigation without blocking the current page.
function _preloadAdjacentImages(currentIndex, limit, suffix, owner, repo, branch) {
    if (limit <= 0) {
        return;
    }

    for (let offset = -limit; offset <= limit; offset++) {
        if (offset === 0) {
            continue;
        }

        const page = changePage(currentIndex, offset);
        if (page === currentIndex) {
            continue;
        }

        const imagePath = getImagePath(page, suffix);
        if (imageCache.isCached(imagePath) || imageCache.preloadedImages.has(imagePath)) {
            continue;
        }

        imageCache.preloadedImages.add(imagePath);
        getImageLink(owner, repo, branch, imagePath).catch(error => {
            imageCache.preloadedImages.delete(imagePath);
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

async function searchImages(limit) {
    const pageConfigs = repoConfigs[currentDictRepo].pages || DEFAULT_PAGE;
    const searchInput = document.getElementById("searchInput").value.trim();
    const divResult = document.getElementById("searchResult");
    divResult.textContent = "";

    // 输入为空则忽略
    if (!searchInput) {
        return;
    }

    // 优先匹配页码
    if (isNumeric(searchInput)) {
        const pageNumber = parseInt(searchInput);
        const maxPage = pageConfigs.content.count;
        if (pageNumber > 0 && pageNumber <= maxPage) {
            currentImageIndex = padPage(pageNumber);
            await showImage();
        } else {
            divResult.textContent = `搜索页面超出范围（1～${maxPage}页）`;
        }
        return;
    }

    // Search in dictionary
    const results = searchInDictionary(searchInput, limit);
    if (DEBUG) {
        console.log(searchInput, results.length);
    }
    if (results.length > 0) {
        // 跳转到第一项
        currentImageIndex = results[0].page;
        await showImage();
        document.getElementById("searchSuggestions").classList.remove("visible");
    } else {
        // No results found
        divResult.textContent = `未找到与“${searchInput}”相关的页面`;
    }
}

async function showImage(limit = 0) {
    const imgElement = document.getElementById("mainImage");
    const resultContainer = document.querySelector(".result-container");
    const loadToken = ++imageLoadToken;
    resultContainer?.classList.add("is-loading");
    setStatusMessage("加载中……");
    try {
        const imageUrl = await preLoadImages(currentImageIndex, limit);
        if (loadToken !== imageLoadToken) {
            return;
        }
        imgElement.src = imageUrl;
        imgElement.style.opacity = "1";
        setStatusMessage("");
    } catch (error) {
        if (loadToken !== imageLoadToken) {
            return;
        }
        setStatusMessage("图片加载失败，请切换来源或稍后重试");
        console.error("Error loading image:", error);
        imgElement.src = DEFAULT_IMAGE;
        imgElement.style.opacity = "0.3";
    } finally {
        if (loadToken === imageLoadToken) {
            resultContainer?.classList.remove("is-loading");
            updateURLParameters();
        }
    }
}

function changePage(currentPage, offset = 1) {
    const pageConfigs = repoConfigs[currentDictRepo].pages || DEFAULT_PAGE;
    const header_pages = pageConfigs.header.count;
    const main_pages = header_pages + pageConfigs.content.count;
    const total_pages = main_pages + pageConfigs.footer.count;
    let currentGroup, currentNum, currentIndex, nextPage;
    currentPage = String(currentPage);

    // 解析页面，得到前缀分组并转化成全局索引
    if (currentPage.startsWith(pageConfigs.header.prefix)) {
        currentGroup = pageConfigs.header.prefix;
        currentNum = parseInt(currentPage.slice(currentGroup.length), 10);
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
        return currentPage; // 超出边界保持不变
    }

    if (targetIndex < header_pages) {
        nextPage = targetIndex + 1;
        currentGroup = pageConfigs.header.prefix;
    } else if (targetIndex < main_pages) {
        nextPage = targetIndex - header_pages + 1;
        currentGroup = pageConfigs.content.prefix;
    } else {
        nextPage = targetIndex - main_pages + 1;
        currentGroup = pageConfigs.footer.prefix;;
    }

    return `${currentGroup}${padPage(nextPage)}`;
}

async function changeImage(nextPage) {
    if (nextPage) {
        currentImageIndex = changePage(currentImageIndex, +1);
    } else {
        currentImageIndex = changePage(currentImageIndex, -1);
    }
    // console.log("changeImage", nextPage, currentImageIndex)
    await showImage(IMAGE_CACHE_CONFIG.preloadCount);
}

async function setupBookmarks() {
    const bookmarksList = document.getElementById("bookmarksList");
    const tocTile = document.getElementById("tocTitle");
    const currentDictData = repoConfigs[currentDictRepo];
    const tocData = currentDictData[keyToc] || [];

    bookmarksList.innerHTML = "";
    tocTile.innerText = `《${currentDictData.name}》目录`;
    tocData.forEach((item) => {
        // 检查是否有子项
        if (item.more && item.more.length > 0) {
            // 创建分组容器
            const groupElement = document.createElement("div");
            groupElement.className = "bookmark-group";

            // 创建分组标题（可点击）
            const groupHeader = document.createElement("div");
            groupHeader.className = "bookmark-group-header";
            const groupTitle = document.createElement("span");
            groupTitle.className = "group-title";
            groupTitle.textContent = item.title;
            const groupArrow = document.createElement("span");
            groupArrow.className = "group-arrow";
            groupArrow.textContent = "▼";
            groupHeader.append(groupTitle, groupArrow);

            // 添加点击事件来切换显示/隐藏子项
            groupHeader.addEventListener("click", () => {
                groupElement.classList.toggle("expanded");
                const arrow = groupHeader.querySelector(".group-arrow");
                arrow.textContent = groupElement.classList.contains("expanded") ? "▶" : "▼";
            });

            // 创建子项容器
            const groupContent = document.createElement("div");
            groupContent.className = "bookmark-group-content";

            // 添加主项目作为第一项（如果也需要可点击）
            const mainItem = createBookmarkElement(item.title, item.page, true);
            groupContent.appendChild(mainItem);

            // 添加子项
            item.more.forEach((subItem) => {
                const bookmarkElement = createBookmarkElement(subItem.title, subItem.page, true);
                groupContent.appendChild(bookmarkElement);
            });

            groupElement.appendChild(groupHeader);
            groupElement.appendChild(groupContent);
            bookmarksList.appendChild(groupElement);
        } else {
            // 单一项，没有子项
            const singleElement = createBookmarkElement(item.title, item.page, false);
            bookmarksList.appendChild(singleElement);
        }
    });

    // Create bookmark element
    function createBookmarkElement(title, page, showPage) {
        const bookmarkElement = document.createElement("div");
        bookmarkElement.className = "bookmark-item";
        const titleElement = document.createElement("span");
        titleElement.textContent = title;
        bookmarkElement.appendChild(titleElement);
        if (showPage) {
            const actualPage = parseInt(String(page).replace(/^[A-Za-z]+/, ""), 10);
            const pageElement = document.createElement("span");
            pageElement.className = "page-number";
            pageElement.textContent = `第 ${actualPage} 页`;
            bookmarkElement.appendChild(pageElement);
        }
        bookmarkElement.onclick = async (e) => {
            if (e.target.closest(".bookmark-group-header")) return;
            currentImageIndex = page;
            await showImage(IMAGE_CACHE_CONFIG.preloadCount);
            closeSidebarHandler();
        };
        return bookmarkElement;
    }
}

// Global sidebar functions
function toggleSidebar() {
    const sidebarPopup = document.getElementById("sidebarPopup");
    const sidebarToggle = document.getElementById("sidebarToggle");

    sidebarPopup.classList.toggle("active");
    sidebarToggle.classList.toggle("active");
    document.body.style.overflow = sidebarPopup.classList.contains("active") ? "hidden" : "";

    if (!sidebarPopup.classList.contains("active")) {
        document.querySelectorAll(".bookmark-group").forEach((group) => {
            group.classList.remove("expanded");
        });
    }
}

function closeSidebarHandler() {
    const sidebarPopup = document.getElementById("sidebarPopup");
    const sidebarToggle = document.getElementById("sidebarToggle");

    sidebarPopup.classList.remove("active");
    sidebarToggle.classList.remove("active");
    document.body.style.overflow = "";

    // Close all groups
    document.querySelectorAll(".bookmark-group").forEach((group) => {
        group.classList.remove("expanded");
    });
}

function matchWeight(term, query) {
    if (term === query) return 0;
    else if (term.startsWith(query)) return 1;
    else if (term.endsWith(query)) return 2;
    return 3;
}

function searchInDictionary(query, limit) {
    const results = [];
    const maxLimit = limit * 3;
    const normalizedQuery = query.toLowerCase().trim(); // TODO 拼音兼容
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
                results.push({
                    term: pinyinQuery,
                    page: padPage(currentDictData[key][pinyinQuery]),
                    type,
                    key,
                    score: weight,
                });
            }
        }
        for (const [term, value] of Object.entries(currentDictData[key])) {
            // 限制拼音必须是开头匹配
            if (
                (term.includes(normalizedQuery) && key !== keyPinyin) ||
                (term.startsWith(normalizedQuery) && key === keyPinyin)
            ) {
                const pages = Array.isArray(value) ? value : [value];
                pages.forEach((page) => {
                    results.push({
                        term,
                        page: padPage(page),
                        type,
                        key,
                        score: matchWeight(term, normalizedQuery) + weight,
                    });
                });
                if (results.length >= maxLimit) break; // 超过N倍则截断
            }
        }
        if (results.length >= maxLimit) break;
    }

    // Sort by score and limit results
    return results.sort((a, b) => a.score - b.score || a.page - b.page);
}

function showSearchSuggestions(query, limit) {
    const suggestionsContainer = document.getElementById("searchSuggestions");

    if (!query) {
        suggestionsContainer.classList.remove("visible");
        return;
    }

    const results = searchInDictionary(query, limit);
    if (results.length === 0) {
        suggestionsContainer.classList.remove("visible");
        return;
    }

    // Clear previous suggestions
    suggestionsContainer.innerHTML = "";
    const topResults = results.slice(0, limit);
    // 候选匹配
    topResults.forEach((result, index) => {
        const item = document.createElement("div");
        item.className = "suggestion-item" + (index === highlightedIndex ? " highlighted" : "");
        const term = document.createElement("span");
        term.textContent = result.term;
        const type = document.createElement("span");
        type.className = "suggestion-type";
        type.textContent = `${result.type} · 第 ${result.page} 页`;
        item.append(term, type);

        item.addEventListener("click", async () => {
            currentImageIndex = result.page;
            await showImage();
            suggestionsContainer.classList.remove("visible");
        });
        suggestionsContainer.appendChild(item);
    });

    if (results.length > limit) {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        const more = document.createElement("span");
        more.textContent = "……";
        item.appendChild(more);
        suggestionsContainer.appendChild(item);
    }

    suggestionsContainer.classList.add("visible");
}

function highlightSuggestion(direction) {
    const items = document.querySelectorAll(".suggestion-item");
    if (items.length === 0) return;

    // Remove previous highlight
    if (highlightedIndex >= 0) {
        items[highlightedIndex].classList.remove("highlighted");
    }

    // Calculate new index
    highlightedIndex += direction;

    // Wrap around if needed
    if (highlightedIndex < 0) highlightedIndex = items.length - 1;
    if (highlightedIndex >= items.length) highlightedIndex = 0;

    // Add highlight
    items[highlightedIndex].classList.add("highlighted");
    items[highlightedIndex].scrollIntoView({ block: "nearest" });
}

function setupSearch(limit) {
    if (searchIsSetup) return;
    searchIsSetup = true;

    const searchInput = document.getElementById("searchInput");
    const searchBtn = document.getElementById("searchBtn");
    const suggestionsContainer = document.getElementById("searchSuggestions");

    searchBtn.addEventListener("click", async () => {
        await searchImages(limit);
    });

    // Handle Enter key in search input
    searchInput.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
            // If there"s a highlighted suggestion, use it
            if (highlightedIndex >= 0) {
                const items = document.querySelectorAll(".suggestion-item");
                if (items[highlightedIndex]) {
                    items[highlightedIndex].click();
                    return;
                }
            }
            // Otherwise, perform normal search
            await searchImages(limit);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            highlightSuggestion(1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            highlightSuggestion(-1);
        }
    });

    // Handle input changes for suggestions
    searchInput.addEventListener("input", (e) => {
        highlightedIndex = -1;
        showSearchSuggestions(e.target.value, limit);
    });

    // Close suggestions when clicking outside
    document.addEventListener("click", (e) => {
        if (!searchInput.contains(e.target) && !suggestionsContainer.contains(e.target)) {
            suggestionsContainer.classList.remove("visible");
        }
    });
}

function updateURLParameters() {
    const url = new URL(window.location.href);
    const searchInput = document.getElementById("searchInput").value.trim();
    const params = { dict: currentDictRepo, query: searchInput, page: currentImageIndex };
    Object.entries(params).forEach(([key, value]) => {
        if (value) {
            url.searchParams.set(key, value);
        } else {
            url.searchParams.delete(key);
        }
    });
    window.history.replaceState({}, "", url);
}

async function initializeFromURL() {
    const urlParams = new URLSearchParams(window.location.search);
    let dictParam = urlParams.get("dict");
    const pageParam = urlParams.get("page");
    const queryParam = urlParams.get("query");

    if (!Object.hasOwn(repoConfigs, dictParam)) {
        dictParam = Object.keys(repoConfigs)[0];
    }
    if (dictParam in repoConfigs) {
        const dictSelector = document.getElementById("dictSelector");
        const dictLogo = document.getElementById("dictLogo");
        const option = dictSelector.querySelector(`option[value="${dictParam}"]`);

        if (option) {
            currentDictRepo = dictParam;
            dictSelector.value = dictParam;
            dictLogo.src = repoConfigs[currentDictRepo].logo;
            dictLogo.alt = `${repoConfigs[currentDictRepo].name} Logo`;
            dictSelector.dispatchEvent(new Event("change", { bubbles: true }));
        }
    }

    setupSearch(MAX_RESULTS);
    await setupBookmarks();

    if (queryParam && !pageParam) {
        const searchInput = document.getElementById("searchInput");
        searchInput.value = queryParam;
        const searchBtn = document.getElementById("searchBtn");
        searchBtn.click();
    } else if (pageParam) {
        let isSuccess = false;
        if (isNumeric(pageParam)) {
            const pageConfigs = repoConfigs[currentDictRepo].pages || DEFAULT_PAGE;
            const maxPage = pageConfigs.content.count;
            const pageNumber = parseInt(pageParam);
            if (pageNumber > 0 && pageNumber <= maxPage) {
                currentImageIndex = padPage(pageNumber);
                await showImage();
                isSuccess = true;
            }
        }
        if (!isSuccess) {
            const divResult = document.getElementById("searchResult");
            divResult.textContent = "页码参数格式异常";
        }
    }
    // updateURLParameters();
}

document.addEventListener("DOMContentLoaded", async function () {
    const bookmarksList = document.getElementById("bookmarksList");

    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");
    const container = document.querySelector(".result-container");

    const tipToggle = document.getElementById("tipToggle");
    const pinyinPopup = document.getElementById("pinyinPopup");
    const closePopup = document.getElementById("closePopup");

    function showButtons() {
        prevBtn.style.display = "block";
        nextBtn.style.display = "block";
    }

    function hideButtons() {
        prevBtn.style.display = "none";
        nextBtn.style.display = "none";
    }

    // 显示弹窗
    tipToggle.addEventListener("click", function () {
        pinyinPopup.style.display = "flex";
    });

    // 关闭弹窗
    closePopup.addEventListener("click", function () {
        pinyinPopup.style.display = "none";
    });

    // 点击弹窗外部关闭
    pinyinPopup.addEventListener("click", function (e) {
        if (e.target === pinyinPopup) {
            pinyinPopup.style.display = "none";
        }
    });

    // 鼠标点击翻页
    container.addEventListener("mouseenter", showButtons);
    container.addEventListener("mouseleave", hideButtons);

    prevBtn.addEventListener("click", async function () {
        await changeImage(false);
    });
    nextBtn.addEventListener("click", async function () {
        await changeImage(true);
    });

    // 键盘点击查询
    document.addEventListener("keydown", async function (event) {
        // 检查焦点是否在搜索输入框或按钮上
        const activeElement = document.activeElement;
        const isSearchFocused = activeElement.id === "searchInput" ||
            activeElement.closest(".search-buttons") !== null;

        // 如果焦点在搜索相关元素上，则不处理左右箭头
        if (isSearchFocused) return;

        // 左右翻页
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            await changeImage(false);
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            await changeImage(true);
        }
    });

    if (bookmarksList) {
        bookmarksList.innerHTML = "加载目录中……";
    }

    // Setup sidebar event listeners (only once)
    const sidebarToggle = document.getElementById("sidebarToggle");
    const closeSidebarPopup = document.getElementById("closeSidebarPopup");

    if (sidebarToggle) {
        sidebarToggle.addEventListener("click", toggleSidebar);
    }
    if (closeSidebarPopup) {
        closeSidebarPopup.addEventListener("click", closeSidebarHandler);
    }

    try {
        await initializeDictSelector();
    } catch (error) {
        console.error("Error initializing application:", error);
        if (bookmarksList) {
            bookmarksList.innerHTML = "加载失败，请刷新重试";
        }
    }
});
