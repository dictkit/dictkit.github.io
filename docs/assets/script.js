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
const DATA_FILE = 'dicts.json';

let fileInfoList = [];
let urlProxyList = [];
let metaConfigs = {};
let repoConfigs = {};
let currentDictRepo = null;

// let currentDictData = {};
// let pageConfigs = DEFAULT_PAGE;

let currentImageIndex = DEFAULT_IMAGE_INDEX;
const pinyinKeys = Object.keys(PINYIN_MAP).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const pinyinRegExp = new RegExp(pinyinKeys, 'gi');
const keyToc = "toc";
const keyPinyin = "pinyin";

const PROXY_CACHE_DURATION = 30 * 60 * 1000; // 30分钟
const proxyCache = {
    lastSuccessProxy: null,
    lastSuccessTime: 0,
    failedProxies: new Set(),

    updateProxy(proxy) {
        this.lastSuccessProxy = proxy;
        this.lastSuccessTime = new Date();
        this.failedProxies.delete(proxy);
    },

    addFail(proxy) {
        this.failedProxies.add(proxy);
    },

    getBestProxy(urls) {
        // 获取候选
        const now = Date.now();
        if (this.lastSuccessProxy &&
            now - this.lastSuccessTime < PROXY_CACHE_DURATION) {
            return this.lastSuccessProxy;
        }
        if (now - this.lastSuccessTime >= PROXY_CACHE_DURATION) {
            this.failedProxies.clear();
        }
        return urls.find(proxy => !this.failedProxies.has(proxy)) || urls[0];
    }
};

const IMAGE_CACHE_CONFIG = {
    maxCacheSize: 200,
    preloadCount: 3,
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
    // pinyin.replace(/[*·]+|[0-9]+$/g, '')
    const out = pinyin.replace(pinyinRegExp, match => PINYIN_MAP[match]);
    return out == "ei" ? "ê" : out;
}

function padPage(page) {
    return String(page).padStart(4, "0");
}

function isNumeric(str) {
    return !isNaN(str) && !isNaN(parseInt(str));
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

// Separate function for actual remote loading
async function _loadImageFromRemote(owner, repo, branch, imagePath) {
    const defaultImageUrl = DEFAULT_IMAGE;

    // Try to load actual image
    const proxy = proxyCache.getBestProxy(urlProxyList);
    const imageUrl = buildUrl(proxy, owner, repo, branch, imagePath);

    try {
        const response = await fetch(imageUrl, { method: 'HEAD' });
        if (response.ok) {
            proxyCache.updateProxy(proxy);
            return imageUrl;
        }
    } catch (error) {
        console.warn(`Failed to load image from ${proxy}`, error);
        proxyCache.addFail(proxy);
    }

    return defaultImageUrl;
}

async function initializeDictSelector() {
    try {
        const data = await loadJSONFile(DATA_FILE);
        const dictConfigs = data.dicts || [];
        urlProxyList = data.urls || [];
        metaConfigs = data.config || {}
        fileInfoList = data.files || [];

        const dictSelector = document.getElementById('dictSelector');
        const dictLogo = document.getElementById('dictLogo');

        // Clear existing options
        dictSelector.innerHTML = '';

        // Add options
        dictConfigs.forEach((dict) => {
            const repo = dict.repo;
            const option = document.createElement('option');
            option.value = repo;
            option.textContent = dict.name;
            option.dataset.logo = `assets/logos/${dict.repo}.png`;
            dictSelector.appendChild(option);
        });

        // Set default selection and load first dictionary
        if (dictConfigs.length > 0) {
            const firstDict = dictConfigs[0];
            currentDictRepo = firstDict.repo;

            // 获取所有词典信息
            const promises = dictConfigs.map(async (dict) => {
                const data = await initializeDictData(dict.repo);
                return { repo: dict.repo, data };
            });
            const results = await Promise.all(promises);

            repoConfigs = dictConfigs.reduce((acc, item) => {
                acc[item.repo] = item;
                return acc
            }, {});
            results.forEach(item => {
                repoConfigs[item.repo] = { ...repoConfigs[item.repo], ...item.data };
            });
            // console.log(Object.keys(repoConfigs), repoConfigs);

            // Set the logo for the first dictionary
            dictLogo.src = `assets/logos/${currentDictRepo}.png`;
            dictLogo.alt = `${firstDict.name} Logo`;
            await initializeDictionaryView();
        }

        // Add change event listener
        dictSelector.addEventListener('change', async (e) => {
            const selectedOption = e.target.options[e.target.selectedIndex];
            const selectedDict = dictConfigs.find(dict => dict.repo === e.target.value);

            if (!selectedDict) {
                return
            }
            currentDictRepo = selectedDict.repo;
            if (DEBUG) {
                console.log("Switch dict", currentDictRepo);
            }

            // Clear image cache for previous dictionary
            // imageCache.clearCurrentDict();

            // Update the logo
            dictLogo.src = selectedOption.dataset.logo;
            dictLogo.alt = `${selectedDict.name} Logo`;
            await initializeDictionaryView();
        });
    } catch (error) {
        console.error('Failed to load dictionary list:', error);
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

    // Reset search and UI
    document.getElementById('searchInput').value = '';
    document.getElementById('searchSuggestions').innerHTML = '';
    document.getElementById('searchResult').innerHTML = '';

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
        console.error('No repository specified');
        return;
    }
    if (DEBUG) {
        console.log("Loading dict", repo);
    }

    const fileList = getFileList(files, dataPath);
    // Try to load each file from available mirrors
    let success = false;
    for (const { key, path } of fileList) {
        currentDictData[key] = null;
        const proxy = proxyCache.getBestProxy(urlProxyList);
        try {
            const repoURL = buildUrl(proxy, owner, repo, branch, path);
            const result = await loadJSONFile(repoURL);
            if (result) {
                currentDictData[key] = result;
                proxyCache.updateProxy(proxy)
                success = true;
                continue;
            }
        } catch (error) {
            console.warn(`Failed to load ${path} from ${proxy}`, error);
            proxyCache.addFail(proxy);
        }

        if (!success) {
            console.error(`Failed to load ${path} from all mirrors`);
            // return false;
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

// Preload adjacent images for smooth navigation
async function _preloadAdjacentImages(currentIndex, limit, suffix, owner, repo, branch) {
    const preloadPromises = [];
    let outURL = null;
    for (let offset = -limit; offset <= limit; offset++) {
        const page = changePage(currentIndex, offset);
        const imagePath = getImagePath(page, suffix);
        const imageURL = getImageLink(owner, repo, branch, imagePath);
        if (offset === 0) {
            outURL = imageURL;
        }

        if (!imageCache.isCached(imagePath) && !imageCache.preloadedImages.has(imagePath)) {
            preloadPromises.push(
                imageURL.then(url => {
                    imageCache.preloadedImages.add(imagePath);
                    // Preload the actual image into browser cache
                    const img = new Image();
                    img.src = url;
                })
                    .catch(err => console.warn('Preload failed:', imagePath, err))
            );
        }
    }

    // Execute preloading in parallel without blocking
    Promise.allSettled(preloadPromises);
    return outURL;
}

async function preLoadImages(index, limit = 0) {
    // const currentPage = padPage(index);
    const suffix = metaConfigs.imageSuffix;
    const repo = currentDictRepo;
    const owner = metaConfigs.owner;
    const branch = metaConfigs.branch;
    const imageUrl = _preloadAdjacentImages(index, limit, suffix, owner, repo, branch);
    return imageUrl;
}

async function searchImages(limit) {
    const pageConfigs = repoConfigs[currentDictRepo].pages || DEFAULT_PAGE;
    const searchInput = document.getElementById("searchInput").value.trim();
    const divResult = document.getElementById("searchResult");
    divResult.innerHTML = "";

    // 输入为空则忽略
    if (!searchInput) {
        return;
    }

    // 优先匹配页码
    if (isNumeric(searchInput)) {
        const pageNumber = parseInt(searchInput);
        if (pageNumber > 0 && pageNumber <= pageConfigs.content.count) {
            currentImageIndex = pageNumber;
            await showImage();
        } else {
            divResult.innerHTML = `搜索页面超出范围（1～${pageConfigs.content.count}页）`;
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
        divResult.innerHTML = `未找到与“${searchInput}”相关的页面`;
    }
}

async function showImage() {
    const imgElement = document.getElementById("mainImage");
    imgElement.style.opacity = '0.3';

    try {
        // Start loading with preloading
        const imageUrl = await preLoadImages(currentImageIndex, IMAGE_CACHE_CONFIG.preloadCount);

        // Create a new image object to test loading
        const tempImg = new Image();

        // Use a Promise to handle the image loading
        await new Promise((resolve, reject) => {
            tempImg.onload = () => {
                // Image loaded successfully, update the main image
                imgElement.src = imageUrl;
                imgElement.style.opacity = '1';
                resolve();
            };

            tempImg.onerror = () => {
                // Image failed to load, use fallback
                console.error("Image loading failed for:", imageUrl);
                imgElement.src = DEFAULT_IMAGE;
                imgElement.style.opacity = '0.3';
                reject(new Error('Image load error'));
            };

            // Start loading the image
            tempImg.src = imageUrl;
        });

    } catch (error) {
        console.error("Error loading image:", error);
        imgElement.src = DEFAULT_IMAGE;
        imgElement.style.opacity = '0.3';
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
    await showImage();
}

async function setupBookmarks() {
    const bookmarksList = document.getElementById("bookmarksList");
    const tocTile = document.getElementById("tocTitle");
    const currentDictData = repoConfigs[currentDictRepo];
    const tocData = currentDictData[keyToc] || [];

    bookmarksList.innerHTML = '';
    tocTile.innerText = currentDictData.name + "目录";
    tocData.forEach((item) => {
        // 检查是否有子项
        if (item.more && item.more.length > 0) {
            // 创建分组容器
            const groupElement = document.createElement("div");
            groupElement.className = "bookmark-group";

            // 创建分组标题（可点击）
            const groupHeader = document.createElement("div");
            groupHeader.className = "bookmark-group-header";
            groupHeader.innerHTML = `
                <span class="group-title">${item.title}</span>
                <span class="group-arrow">▼</span>
            `;

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
        bookmarkElement.innerHTML = `<span>${title}</span>`;
        if (showPage) {
            const actualPage = parseInt(String(page).replace(/^[A-Za-z]+/, ""), 10);
            bookmarkElement.innerHTML += `<span class="page-number">第 ${actualPage} 页</span>`;
        }
        bookmarkElement.onclick = async (e) => {
            if (e.target.closest(".bookmark-group-header")) return;
            currentImageIndex = page;
            await showImage();
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
            if (currentDictData[key].startsWith(pinyinQuery)) {
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
        item.innerHTML = `
            <span>${result.term}</span>
            <span class="suggestion-type">${result.type} · 第 ${result.page} 页</span>
        `;

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
        item.innerHTML = "<span>……</span>";
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
    const searchInput = document.getElementById("searchInput");
    const searchBtn = document.getElementById("searchBtn");
    const suggestionsContainer = document.getElementById("searchSuggestions");

    searchBtn.addEventListener("click", async () => {
        await searchImages(limit);
    });

    // Handle Enter key in search input
    searchInput.addEventListener("keydown", async (e) => {
        if (e.key === "Enter") {
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

document.addEventListener("DOMContentLoaded", function () {
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");
    const searchBtn = document.getElementById("searchBtn");
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
        const isSearchFocused = activeElement.id === 'searchInput' ||
            activeElement.closest('.search-buttons') !== null;

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
});

document.addEventListener("DOMContentLoaded", async function () {
    const bookmarksList = document.getElementById("bookmarksList");
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
