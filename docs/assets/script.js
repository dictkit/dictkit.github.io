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
// 词典索引相关的文件
const FILE_TYPES = {
    TOC: "toc.json",
    PINYIN: "pinyin.json",
    CHARS: "chars.json",
    WORDS: "words.json"
};
const URL_PROXY = [
    "https://cdn.jsdmirror.com/gh/:owner/:repo/:filepath",
    "https://fastly.jsdelivr.net/gh/:owner/:repo/:filepath",
    "https://cdn.jsdelivr.net/gh/:owner/:repo/:filepath",
    "https://ghproxy.net/https://raw.githubusercontent.com/:owner/:repo/refs/heads/:branch/:filepath",
    "https://raw.githubusercontent.com/:owner/:repo/refs/heads/:branch/:filepath"
]
// Repository configuration
const REPO_CONFIG = {
    owner: "dictkit",
    branch: "main",
    defaultPath: "docs/data",
    urlTemplates: URL_PROXY
};

let dictConfigs = [];
let pageConfigs = DEFAULT_PAGE;
let currentDictRepo = null;
let currentDictData = {};
let currentImageIndex = DEFAULT_IMAGE_INDEX;
const pinyinKeys = Object.keys(PINYIN_MAP).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const pinyinRegExp = new RegExp(pinyinKeys, 'gi');

function getFileList() {
    return Object.entries(FILE_TYPES).map(([key, filename]) => ({
        key,
        path: `${REPO_CONFIG.defaultPath}/${filename}`
    }));
}

function buildUrl(template, repo, path) {
    const params = {
        owner: REPO_CONFIG.owner,
        repo: repo,
        branch: REPO_CONFIG.branch,
        filepath: path
    };

    return template.replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
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

function randomIndex() {
    return padPage(Math.floor(Math.random() * pageConfigs.content.count) + 1);
}

function isNumeric(str) {
    return !isNaN(str) && !isNaN(parseInt(str));
}

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

function getImageLink(repo, imagePath) {
    // 本地默认图片
    const directUrl = `assets/images/${DEFAULT_IMAGE_INDEX}.png`;

    return new Promise(async (resolve) => {
        const img = new Image();
        img.src = directUrl;
        // 尝试加载实际图片
        for (const template of REPO_CONFIG.urlTemplates) {
            try {
                const imageUrl = buildUrl(template, repo, imagePath);
                const response = await fetch(imageUrl, { method: 'HEAD' });
                if (response.ok) {
                    // console.log("Using template URL:", imageUrl);
                    img.src = imageUrl;
                    resolve(imageUrl);
                    return;
                }
            } catch (error) {
                console.warn(`Failed to load ${imagePath} from template`, error);
            }
        }

        // console.log("Using fallback URL:", directUrl);
        resolve(directUrl);
    });
}

async function initializeDictSelector() {
    try {
        const response = await fetch('dicts.json');
        const data = await response.json();
        dictConfigs = data.dicts || [];
        const dictSelector = document.getElementById('dictSelector');
        const dictLogo = document.getElementById('dictLogo');

        // Clear existing options
        dictSelector.innerHTML = '';

        // Add options
        dictConfigs.forEach((dict) => {
            const option = document.createElement('option');
            option.value = dict.repo;
            option.textContent = dict.name;
            option.dataset.logo = `assets/logos/${dict.repo}.png`;
            dictSelector.appendChild(option);
        });

        // Set default selection and load first dictionary
        if (dictConfigs.length > 0) {
            const firstDict = dictConfigs[0];
            currentDictRepo = firstDict.repo;
            pageConfigs = firstDict.pages || DEFAULT_PAGE;

            // Set the logo for the first dictionary
            dictLogo.src = `assets/logos/${currentDictRepo}.png`;
            dictLogo.alt = `${firstDict.name} Logo`;

            // Load the dictionary data
            await initializeDictData();
        }

        // Add change event listener
        dictSelector.addEventListener('change', async (e) => {
            const selectedOption = e.target.options[e.target.selectedIndex];
            const selectedDict = dictConfigs.find(dict => dict.repo === e.target.value);

            if (selectedDict) {
                currentDictRepo = selectedDict.repo;
                pageConfigs = selectedDict.pages || DEFAULT_PAGE;

                // Update the logo
                dictLogo.src = selectedOption.dataset.logo;
                dictLogo.alt = `${selectedOption.text} Logo`;

                // Load the new dictionary data
                await initializeDictData();

                // Reset search and UI
                document.getElementById('searchInput').value = '';
                document.getElementById('searchSuggestions').innerHTML = '';
                document.getElementById('search-result').innerHTML = '';
            }
            if (DEBUG) {
                console.log("切换词典", currentDictRepo, pageConfigs);
            }

            if (currentDictRepo) {
                currentImageIndex = randomIndex();
                showImage();

                // Load data and initialize bookmarks
                await initializeDictData();

                if (bookmarksList) {
                    bookmarksList.innerHTML = "";
                    await setupBookmarks(bookmarksList);
                }

                setupSearch(MAX_RESULTS);
            } else {
                console.error("No dictionary selected");
                if (bookmarksList) {
                    bookmarksList.innerHTML = "未找到可用的词典，请检查网络连接";
                }
            }
        });
    } catch (error) {
        console.error('Failed to load dictionary list:', error);
    }
}

async function initializeDictData() {
    const repo = currentDictRepo;
    if (!repo) {
        console.error('No repository specified');
        return;
    }
    if (DEBUG) {
        console.log("加载词典", repo);
    }

    const fileList = getFileList(repo);

    // Try to load each file from available mirrors
    for (const { key, path } of fileList) {
        currentDictData[key] = null;
        let success = false;
        for (const template of REPO_CONFIG.urlTemplates) {
            try {
                const url = buildUrl(template, repo, path);
                // console.log("加载", url);

                const response = await fetch(url);
                if (response.ok) {
                    currentDictData[key] = await response.json();
                    success = true;
                    break; // Move to next file if successful
                }
            } catch (error) {
                console.warn(`Failed to load ${path} from ${template}`, error);
            }
        }

        if (!success) {
            console.error(`Failed to load ${path} from all mirrors`);
            return false;
        }
    }
    // console.log("dictData", dictData)
    return true;
}

function searchImage() {
    // 查询逻辑：如果是有效数字对应页码
    // 否则：优先判断是否拼音、字词，最后判断是否是目录
    if (pageNumber && pageNumber >= 1 && pageNumber <= totalImages) {
        document.getElementById("search-result").innerHTML = "";
        if (extraPages) {
            document.getElementById(
                "search-result"
            ).innerHTML = `“${searchInput}”相关页面：${extraPages.join(", ")}`;
        }
        currentImageIndex = pageNumber;
        showImage();
    } else {
        document.getElementById(
            "search-result"
        ).innerHTML = `检索的拼音（及声调）、字词或正文页码（1～${pageConfigs.content.count}）无效，请重新输入!`;
        // alert("请输入一个有效的拼音或正文页码!");
    }
}

async function showImage() {
    // console.log("currentImageIndex", currentImageIndex);
    const currentPage = padPage(currentImageIndex);
    const isExtra = currentPage.startsWith(pageConfigs.header.prefix) ||
        currentPage.startsWith(pageConfigs.footer.prefix);
    const imageDir = isExtra ? "extra" : "images";
    const imageSuffix = "png";
    const imageName = currentPage;
    const imagePath = `docs/${imageDir}/${imageName}.${imageSuffix}`;

    const imgElement = document.getElementById("main-image");

    // Show loading state
    imgElement.style.opacity = '0.5';

    try {
        const imageUrl = await getImageLink(currentDictRepo, imagePath);
        imgElement.src = imageUrl;
        imgElement.onload = () => {
            imgElement.style.opacity = '1';
        };
    } catch (error) {
        console.error("Error loading image:", error);
        imgElement.style.opacity = '1';
    }
}

async function searchImages(limit) {
    const searchInput = document.getElementById("searchInput").value.trim();
    const divResult = document.getElementById("search-result");
    divResult.innerHTML = "";

    // 输入为空则忽略
    if (!searchInput) return;
    // 优先匹配页码
    if (isNumeric(searchInput)) {
        const pageNumber = parseInt(searchInput);
        if (pageNumber > 0 && pageNumber <= pageConfigs.content.count) {
            currentImageIndex = pageNumber;
            showImage();
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
        showImage();
        document.getElementById("searchSuggestions").classList.remove("visible");
    } else {
        // No results found
        divResult.innerHTML = `未找到与“${searchInput}”相关的页面`;
    }
}

function changePage(currentPage, offset = 1) {
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

function changeImage(nextPage) {
    if (nextPage) {
        currentImageIndex = changePage(currentImageIndex, +1);
    } else {
        currentImageIndex = changePage(currentImageIndex, -1);
    }
    // console.log("changeImage", nextPage, currentImageIndex)
    showImage();
}

async function setupBookmarks(bookmarksList) {
    const sidebarToggle = document.getElementById("sidebarToggle");
    const sidebarPopup = document.getElementById("sidebarPopup");
    const closeSidebarPopup = document.getElementById("closeSidebarPopup");
    const toc = currentDictData.TOC;
    toc.forEach((item) => {
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
        bookmarkElement.onclick = (e) => {
            if (e.target.closest(".bookmark-group-header")) return;
            currentImageIndex = page;
            showImage();
            closeSidebarHandler();
        };
        return bookmarkElement;
    }
    // Toggle sidebar
    function toggleSidebar() {
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
        sidebarPopup.classList.remove("active");
        sidebarToggle.classList.remove("active");
        document.body.style.overflow = "";

        // Close all groups
        document.querySelectorAll(".bookmark-group").forEach((group) => {
            group.classList.remove("expanded");
        });
    }
    // 侧边栏
    sidebarToggle.addEventListener("click", toggleSidebar);
    closeSidebarPopup.addEventListener("click", function () {
        closeSidebarHandler();
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
    const searchCategories = [
        { key: "PINYIN", type: "拼音", weight: 0.0 },
        { key: "CHARS", type: "单字", weight: 0.1 },
        { key: "WORDS", type: "词语", weight: 0.2 },
        { key: "TOC2", type: "目录", weight: 0.3 },
    ];

    if (DEBUG) {
        console.log("query", normalizedQuery, pinyinQuery);
    }

    for (const { key, type, weight } of searchCategories) {
        if (!currentDictData[key]) continue;
        if (key === "PINYIN" && pinyinQuery !== normalizedQuery) {
            if (pinyinQuery in currentDictData[key]) {
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
            if (term.includes(normalizedQuery)) {
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

                if (results.length >= maxLimit) break; // 超过2倍则截断
            }
        }

        if (results.length >= maxLimit) break;
    }

    // Sort by score and limit results
    return results.sort((a, b) => a.score - b.score || a.page - b.page).slice(0, limit);
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

    // 候选匹配
    results.forEach((result, index) => {
        const item = document.createElement("div");
        item.className = "suggestion-item" + (index === highlightedIndex ? " highlighted" : "");
        item.innerHTML = `
            <span>${result.term}</span>
            <span class="suggestion-type">${result.type} · 第 ${result.page} 页</span>
        `;

        item.addEventListener("click", () => {
            currentImageIndex = result.page;
            showImage();
            suggestionsContainer.classList.remove("visible");
        });

        suggestionsContainer.appendChild(item);
    });

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

    searchBtn.addEventListener("click", searchImages(limit));

    // Handle Enter key in search input
    searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            searchImages(limit);
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

    prevBtn.addEventListener("click", function () {
        changeImage(false);
    });
    nextBtn.addEventListener("click", function () {
        changeImage(true);
    });

    // 键盘点击查询
    document.addEventListener("keydown", function (event) {
        // 检查焦点是否在搜索输入框或按钮上
        const activeElement = document.activeElement;
        const isSearchFocused = activeElement.id === 'searchInput' ||
            activeElement.closest('.search-buttons') !== null;

        // 如果焦点在搜索相关元素上，则不处理左右箭头
        if (isSearchFocused) return;

        // 左右翻页
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            changeImage(false);
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            changeImage(true);
        }
    });
});

document.addEventListener("DOMContentLoaded", async function () {
    const bookmarksList = document.getElementById("bookmarksList");
    if (bookmarksList) {
        bookmarksList.innerHTML = "加载目录中……";
    }

    try {
        // Initialize dictionary selector and wait for it to complete
        await initializeDictSelector();

        // Only proceed if we have a current dictionary selected
        if (currentDictRepo) {
            currentImageIndex = randomIndex();
            showImage(); // 默认页面

            // Load data and initialize bookmarks
            await initializeDictData();

            if (bookmarksList) {
                bookmarksList.innerHTML = "";
                await setupBookmarks(bookmarksList);
            }

            setupSearch(MAX_RESULTS);
        } else {
            console.error("No dictionary selected");
            if (bookmarksList) {
                bookmarksList.innerHTML = "未找到可用的词典，请检查网络连接";
            }
        }
    } catch (error) {
        console.error("Error initializing application:", error);
        if (bookmarksList) {
            bookmarksList.innerHTML = "加载失败，请刷新重试";
        }
    }
});
