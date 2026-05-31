// ============================================================
// script.js — DOM setup and event wiring
// Depends on dictkit.js loaded first.
// ============================================================

// ── DOM-only State ──

let searchIsSetup = false;
let highlightedIndex = -1;
let suggestionSearchTimer = null;
let font_options = DEFAULT_FONTS;
let pendingDictLoads = {};
let isSpreadMode = false;
const DARK_MODE_KEY = "dictkit:darkmode";

// ── Page Indicator ──

function updatePageIndicator() {
    const el = document.getElementById("pageIndicator");
    if (!el) return;
    const pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE;
    const total = pageConfigs.header.count + pageConfigs.content.count + pageConfigs.footer.count;
    if (isSpreadMode && isContentPage(currentImageIndex)) {
        const num = parseInt(currentImageIndex, 10);
        if (!Number.isNaN(num) && num >= 1 && num <= pageConfigs.content.count) {
            let text;
            if (num === 1) {
                text = `0001 / ${padPage(total)}`;
            } else if (num % 2 === 1) {
                text = `${padPage(num - 1)} · ${currentImageIndex} / ${padPage(total)}`;
            } else {
                const right = num + 1 <= pageConfigs.content.count ? ` · ${padPage(num + 1)}` : "";
                text = `${currentImageIndex}${right} / ${padPage(total)}`;
            }
            el.textContent = text;
        } else {
            el.textContent = `${currentImageIndex} / ${padPage(total)}`;
        }
    } else {
        el.textContent = `${currentImageIndex} / ${padPage(total)}`;
    }
}

// ── DOM Helpers ──

function setStatusMessage(message) {
    const el = document.getElementById("searchResult");
    if (el) el.textContent = message;
}

function applyFontPreference(fontId) {
    const selectedFont = font_options.find(option => option.id === fontId) || font_options[0];
    document.documentElement.style.setProperty("--font", selectedFont.stack);
    setStorageValue(STORAGE_KEYS.font, selectedFont.id);
    return selectedFont.id;
}

function applyDictionarySelection(dictRepo, logoSrc, dictName) {
    currentDictRepo = dictRepo;
    const selector = document.getElementById("dictSelector");
    const logo = document.getElementById("dictLogo");
    if (selector) selector.value = dictRepo;
    if (logo) {
        logo.src = logoSrc || repoConfigs[dictRepo]?.logo || "";
        logo.alt = `${dictName || repoConfigs[dictRepo]?.name || "Dictionary"} Logo`;
    }
}

function resetSearchUi() {
    if (suggestionSearchTimer) {
        window.clearTimeout(suggestionSearchTimer);
        suggestionSearchTimer = null;
    }
    highlightedIndex = -1;
    const input = document.getElementById("searchInput");
    const suggestions = document.getElementById("searchSuggestions");
    const result = document.getElementById("searchResult");
    if (input) input.value = "";
    if (suggestions) {
        suggestions.textContent = "";
        suggestions.classList.remove("visible");
    }
    if (result) result.textContent = "";
}

// ── Settings Panel ──

function initializeFontSelector() {
    const sel = document.getElementById("fontSelector");
    if (!sel) return;
    sel.innerHTML = "";
    font_options.forEach(font => {
        const opt = document.createElement("option");
        opt.value = font.id;
        opt.textContent = font.name;
        sel.appendChild(opt);
    });
    const fontId = getStorageValue(STORAGE_KEYS.font, font_options[0].id);
    sel.value = applyFontPreference(fontId);
    sel.addEventListener("change", e => applyFontPreference(e.target.value));
}

function initializeProxySelector() {
    const sel = document.getElementById("proxySelector");
    if (!sel) return;
    sel.innerHTML = "";
    const auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = "自动选择";
    sel.appendChild(auto);
    urlProxyList.forEach(proxy => {
        const opt = document.createElement("option");
        opt.value = proxy.id;
        opt.textContent = proxy.name;
        sel.appendChild(opt);
    });
    selectedProxyId = getStorageValue(STORAGE_KEYS.proxy, "auto");
    if (!getProxyCandidates(urlProxyList, selectedProxyId).length) {
        selectedProxyId = "auto";
    }
    sel.value = selectedProxyId;
    sel.addEventListener("change", e => {
        selectedProxyId = e.target.value;
        proxyCache.clearAll();
        setStorageValue(STORAGE_KEYS.proxy, selectedProxyId);
    });
}

function initializeSettingsPanel() {
    const toggle = document.getElementById("settingsToggle");
    const panel = document.getElementById("settingsPanel");
    if (!toggle || !panel) return;

    initializeFontSelector();
    initializeProxySelector();
    initializeDarkMode();
    initializeSpreadMode();

    toggle.addEventListener("click", e => {
        e.stopPropagation();
        const open = panel.classList.toggle("active");
        toggle.classList.toggle("active", open);
        toggle.setAttribute("aria-expanded", String(open));
    });
    panel.addEventListener("click", e => e.stopPropagation());
    document.addEventListener("click", () => {
        panel.classList.remove("active");
        toggle.classList.remove("active");
        toggle.setAttribute("aria-expanded", "false");
    });
}

// ── Dark Mode ──

function migrateDarkModeKey(raw) {
    // Migrate old boolean values to new scheme names
    if (raw === "true") return "dark";
    if (raw === "false" || raw === "") return "light";
    return raw;
}

function applyColorScheme(scheme) {
    const isDark = scheme === "dark" ||
        (scheme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.body.classList.toggle("dark-mode", isDark);
    setStorageValue(DARK_MODE_KEY, scheme);
}

function initializeDarkMode() {
    const sel = document.getElementById("darkModeSelect");
    if (!sel) return;
    let stored = getStorageValue(DARK_MODE_KEY, "auto");
    stored = migrateDarkModeKey(stored);
    if (!["auto", "light", "dark"].includes(stored)) stored = "auto";
    sel.value = stored;
    applyColorScheme(stored);
    sel.addEventListener("change", () => applyColorScheme(sel.value));
    // Listen for system changes when in auto mode
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (sel.value === "auto") applyColorScheme("auto");
    });
}

// ── Fullscreen ──

function toggleFullscreen() {
    const container = document.querySelector(".result-container");
    if (!container) return;
    if (document.fullscreenElement || container.classList.contains("fullscreen")) {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
        container.classList.remove("fullscreen");
    } else {
        container.classList.add("fullscreen");
        if (container.requestFullscreen) {
            container.requestFullscreen().catch(() => {});
        }
    }
}

// ── Spread / Dual-page Mode ──
function isContentPage(page) {
    return /^\d+$/.test(String(page));
}

function getSecondPageUrl() {
    const num = parseInt(currentImageIndex, 10);
    if (Number.isNaN(num) || num < 2 || num % 2 === 1) return null;
    const pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE;
    if (num + 1 > pageConfigs.content.count) return null;
    const suffix = metaConfigs.imageSuffix;
    const imagePath = getImagePath(padPage(num + 1), suffix);
    return getImageLink(metaConfigs.owner, currentDictRepo, metaConfigs.branch, imagePath);
}

function initializeSpreadMode() {
    const sel = document.getElementById("spreadMode");
    if (!sel) return;
    const stored = getStorageValue("dictkit:spread", "0");
    sel.value = stored;
    isSpreadMode = stored === "1";
    // Don't apply spread class here — showImage manages it after page ready

    sel.addEventListener("change", async () => {
        isSpreadMode = sel.value === "1";
        setStorageValue("dictkit:spread", sel.value);
        if (isSpreadMode) {
            const num = parseInt(currentImageIndex, 10);
            if (isContentPage(currentImageIndex) && !Number.isNaN(num)) {
                if (num > 1 && num % 2 === 1) {
                    currentImageIndex = padPage(num - 1);
                }
            }
            applySpreadClass();
        } else {
            removeSpreadClass();
        }
        await showImage(IMAGE_CACHE_CONFIG.preloadCount);
    });
}

function applySpreadClass() {
    const el = document.querySelector(".result-container");
    if (!el) return;
    // Only apply spread layout for content pages
    if (isContentPage(currentImageIndex)) {
        el.classList.add("spread-mode");
    } else {
        el.classList.remove("spread-mode");
    }
}

function removeSpreadClass() {
    document.querySelector(".result-container")?.classList.remove("spread-mode");
}

document.addEventListener("fullscreenchange", () => {
    const container = document.querySelector(".result-container");
    if (!document.fullscreenElement && container) {
        container.classList.remove("fullscreen");
    }
});

// ── Touch Swipe ──

let touchStartX = 0;
let touchStartY = 0;

function setupTouchSwipe() {
    const container = document.querySelector(".result-container");
    if (!container) return;

    container.addEventListener("touchstart", e => {
        const t = e.changedTouches[0];
        touchStartX = t.screenX;
        touchStartY = t.screenY;
    }, { passive: true });

    container.addEventListener("touchend", async e => {
        const t = e.changedTouches[0];
        const dx = t.screenX - touchStartX;
        const dy = t.screenY - touchStartY;
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
            e.preventDefault();
            await changeImage(dx < 0);
        }
    }, { passive: false });
}

// ── Image Display ──

async function showImage(limit = 0) {
    const img = document.getElementById("mainImage");
    const img2 = document.getElementById("mainImage2");
    const container = document.querySelector(".result-container");
    const token = ++imageLoadToken;
    container?.classList.add("is-loading");
    setStatusMessage("加载中……");
    try {
        // Sync spread CSS — shows spread only for content pages
        (isSpreadMode ? applySpreadClass : removeSpreadClass)();
        const isSpread = isSpreadMode && isContentPage(currentImageIndex);
        if (isSpread) {
            await loadSpreadView(img, img2, token);
        } else {
            await loadSingleView(img, img2, limit, token);
        }
    } catch (error) {
        if (token === imageLoadToken) {
            setStatusMessage("图片加载失败，请切换来源或稍后重试");
            console.error("Error loading image:", error);
            img.src = DEFAULT_IMAGE;
            img.style.opacity = "0.3";
            if (img2) { img2.src = ""; img2.style.opacity = "0"; }
        }
    } finally {
        if (token === imageLoadToken) {
            container?.classList.remove("is-loading");
            updatePageIndicator();
            updateURLParameters();
        }
    }
}

async function loadSingleView(img, img2, limit, token) {
    const url = await preLoadImages(currentImageIndex, limit);
    if (token !== imageLoadToken) return;
    img.src = url;
    img.style.opacity = "1";
    if (img2) { img2.src = ""; img2.style.opacity = "0"; }
    setStatusMessage("");
}

async function loadSpreadView(img, img2, token) {
    const num = parseInt(currentImageIndex, 10);

    if (num === 1) {
        // Page 1 on the right, placeholder on the left
        const url = await preLoadImages(currentImageIndex, 0);
        if (token !== imageLoadToken) return;
        img.src = EMPTY_IMAGE;
        img.style.opacity = "1";
        img2.src = url;
        img2.style.opacity = "1";
    } else if (num % 2 === 1) {
        // Odd > 1: left = num-1 (even), right = num
        const leftPage = padPage(num - 1);
        const [leftUrl, rightUrl] = await Promise.all([
            preLoadImages(leftPage, 0),
            preLoadImages(currentImageIndex, 0),
        ]);
        if (token !== imageLoadToken) return;
        img.src = leftUrl;
        img.style.opacity = "1";
        img2.src = rightUrl;
        img2.style.opacity = "1";
    } else {
        // Even: left = num, right = num+1 or placeholder
        const url = await preLoadImages(currentImageIndex, 0);
        const url2 = await getSecondPageUrl();
        if (token !== imageLoadToken) return;
        img.src = url;
        img.style.opacity = "1";
        img2.src = url2 || EMPTY_IMAGE;
        img2.style.opacity = "1";
    }
    setStatusMessage("");
}

async function changeImage(nextPage) {
    if (isSpreadMode && isContentPage(currentImageIndex)) {
        const num = parseInt(currentImageIndex, 10);
        if (!Number.isNaN(num)) {
            if (!nextPage && num <= 1) {
                // Page 1 prev: fall through to changePage for header transition (→A0094)
            } else {
                const pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE;
                const currentEven = num <= 1 ? 1 : (num % 2 === 0 ? num : num - 1);
                let target = nextPage
                    ? (currentEven <= 1 ? 2 : Math.min(currentEven + 2, pageConfigs.content.count))
                    : Math.max(currentEven - 2, 2);
                if (target !== num) {
                    currentImageIndex = padPage(target);
                    await showImage(IMAGE_CACHE_CONFIG.preloadCount);
                    return;
                }
                // At content boundary — fall through to single-page navigation
            }
        }
    }
    currentImageIndex = changePage(currentImageIndex, nextPage ? 1 : -1);
    await showImage(IMAGE_CACHE_CONFIG.preloadCount);
}

// ── Search UI ──

async function searchImages(limit) {
    const pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE;
    const input = document.getElementById("searchInput").value.trim();
    const result = document.getElementById("searchResult");
    if (suggestionSearchTimer) {
        window.clearTimeout(suggestionSearchTimer);
        suggestionSearchTimer = null;
    }
    result.textContent = "";

    if (!input) return;

    if (isNumeric(input)) {
        const pageNumber = parseInt(input);
        const maxPage = pageConfigs.content.count;
        if (pageNumber > 0 && pageNumber <= maxPage) {
            currentImageIndex = padPage(pageNumber);
            await showImage();
        } else {
            result.textContent = `搜索页面超出范围（1～${maxPage}页）`;
        }
        return;
    }

    const results = searchInDictionary(input, limit);
    if (results.length > 0) {
        currentImageIndex = results[0].page;
        await showImage();
        document.getElementById("searchSuggestions").classList.remove("visible");
    } else {
        result.textContent = `未找到与"${input}"相关的页面`;
    }
}

function showSearchSuggestions(query, limit) {
    const container = document.getElementById("searchSuggestions");
    if (!query) {
        container.classList.remove("visible");
        return;
    }

    const results = searchInDictionary(query, limit);
    if (results.length === 0) {
        container.classList.remove("visible");
        return;
    }

    container.innerHTML = "";
    results.slice(0, limit).forEach((result, index) => {
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
            container.classList.remove("visible");
        });
        container.appendChild(item);
    });

    if (results.length > limit) {
        const item = document.createElement("div");
        item.className = "suggestion-item";
        const more = document.createElement("span");
        more.textContent = "……";
        item.appendChild(more);
        container.appendChild(item);
    }

    container.classList.add("visible");
}

function hideSearchSuggestions() {
    const c = document.getElementById("searchSuggestions");
    if (!c) return;
    c.textContent = "";
    c.classList.remove("visible");
}

function scheduleSearchSuggestions(query, limit) {
    if (suggestionSearchTimer) {
        window.clearTimeout(suggestionSearchTimer);
        suggestionSearchTimer = null;
    }
    const q = query.trim();
    if (q.length < SEARCH_SUGGESTION_MIN_LENGTH) {
        hideSearchSuggestions();
        return;
    }
    suggestionSearchTimer = window.setTimeout(() => {
        suggestionSearchTimer = null;
        showSearchSuggestions(q, limit);
    }, SEARCH_SUGGESTION_DEBOUNCE_MS);
}

function highlightSuggestion(direction) {
    const items = document.querySelectorAll(".suggestion-item");
    if (items.length === 0) return;
    if (highlightedIndex >= 0) {
        items[highlightedIndex].classList.remove("highlighted");
    }
    highlightedIndex += direction;
    if (highlightedIndex < 0) highlightedIndex = items.length - 1;
    if (highlightedIndex >= items.length) highlightedIndex = 0;
    items[highlightedIndex].classList.add("highlighted");
    items[highlightedIndex].scrollIntoView({ block: "nearest" });
}

function setupSearch(limit) {
    if (searchIsSetup) return;
    searchIsSetup = true;

    const input = document.getElementById("searchInput");
    const btn = document.getElementById("searchBtn");
    const suggestions = document.getElementById("searchSuggestions");

    btn.addEventListener("click", async () => searchImages(limit));

    input.addEventListener("keydown", async e => {
        if (e.key === "Enter") {
            if (highlightedIndex >= 0) {
                const items = document.querySelectorAll(".suggestion-item");
                if (items[highlightedIndex]) {
                    items[highlightedIndex].click();
                    return;
                }
            }
            await searchImages(limit);
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            highlightSuggestion(1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            highlightSuggestion(-1);
        }
    });

    input.addEventListener("input", e => {
        highlightedIndex = -1;
        scheduleSearchSuggestions(e.target.value, limit);
    });

    document.addEventListener("click", e => {
        if (!input.contains(e.target) && !suggestions.contains(e.target)) {
            suggestions.classList.remove("visible");
        }
    });
}

// ── Sidebar / Bookmarks ──

async function setupBookmarks() {
    const list = document.getElementById("bookmarksList");
    const title = document.getElementById("tocTitle");
    const data = repoConfigs[currentDictRepo];
    const toc = data[keyToc] || [];

    list.innerHTML = "";
    title.textContent = `《${data.name}》目录`;

    function createBookmarkElement(title, page, showPage) {
        const el = document.createElement("div");
        el.className = "bookmark-item";
        const span = document.createElement("span");
        span.textContent = title;
        el.appendChild(span);
        if (showPage) {
            const num = parseInt(String(page).replace(/^[A-Za-z]+/, ""), 10);
            const pg = document.createElement("span");
            pg.className = "page-number";
            pg.textContent = `第 ${num} 页`;
            el.appendChild(pg);
        }
        el.onclick = async e => {
            if (e.target.closest(".bookmark-group-header")) return;
            currentImageIndex = page;
            await showImage(IMAGE_CACHE_CONFIG.preloadCount);
            closeSidebarHandler();
        };
        return el;
    }

    toc.forEach(item => {
        if (item.more && item.more.length > 0) {
            const group = document.createElement("div");
            group.className = "bookmark-group";

            const header = document.createElement("div");
            header.className = "bookmark-group-header";
            const titleSpan = document.createElement("span");
            titleSpan.className = "group-title";
            titleSpan.textContent = item.title;
            const arrow = document.createElement("span");
            arrow.className = "group-arrow";
            arrow.textContent = "▼";
            header.append(titleSpan, arrow);
            header.addEventListener("click", () => {
                group.classList.toggle("expanded");
                header.querySelector(".group-arrow").textContent =
                    group.classList.contains("expanded") ? "▶" : "▼";
            });

            const content = document.createElement("div");
            content.className = "bookmark-group-content";
            content.appendChild(createBookmarkElement(item.title, item.page, true));
            item.more.forEach(sub =>
                content.appendChild(createBookmarkElement(sub.title, sub.page, true))
            );

            group.appendChild(header);
            group.appendChild(content);
            list.appendChild(group);
        } else {
            list.appendChild(createBookmarkElement(item.title, item.page, false));
        }
    });
}

function toggleSidebar() {
    const popup = document.getElementById("sidebarPopup");
    const toggle = document.getElementById("sidebarToggle");
    popup.classList.toggle("active");
    toggle.classList.toggle("active");
    document.body.style.overflow = popup.classList.contains("active") ? "hidden" : "";
    if (!popup.classList.contains("active")) {
        document.querySelectorAll(".bookmark-group").forEach(g => g.classList.remove("expanded"));
    }
}

function closeSidebarHandler() {
    document.getElementById("sidebarPopup").classList.remove("active");
    document.getElementById("sidebarToggle").classList.remove("active");
    document.body.style.overflow = "";
    document.querySelectorAll(".bookmark-group").forEach(g => g.classList.remove("expanded"));
}

// ── URL ──

function updateURLParameters() {
    const url = new URL(window.location.href);
    const query = document.getElementById("searchInput").value.trim();
    const params = { dict: currentDictRepo, query, page: currentImageIndex };
    Object.entries(params).forEach(([key, value]) => {
        if (value) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
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
        document.getElementById("dictSelector").value = dictParam;
        applyDictionarySelection(dictParam, repoConfigs[dictParam].logo, repoConfigs[dictParam].name);
    }

    await initializeDictionaryView({ showImage: false });

    // Ensure the target dict's data is loaded before search/navigation
    if (pendingDictLoads[currentDictRepo]) {
        try {
            await pendingDictLoads[currentDictRepo];
        } catch (err) {
            console.warn(`Background load failed for ${currentDictRepo}:`, err);
        }
    }

    if (queryParam && !pageParam) {
        document.getElementById("searchInput").value = queryParam;
        document.getElementById("searchBtn").click();
    } else if (pageParam) {
        const cleanedPage = String(pageParam).replace(/^0+/, "") || pageParam;
        const page = normalizePageId(cleanedPage);
        if (page) {
            currentImageIndex = page;
            await showImage();
        } else if (queryParam) {
            document.getElementById("searchInput").value = queryParam;
            document.getElementById("searchBtn").click();
        } else {
            document.getElementById("searchResult").textContent = "页码参数格式异常，可能超出范围";
        }
    } else {
        await showImage();
    }
}

// ── Initialization ──

async function initializeDictionaryView(options = {}) {
    const { showImage: doShow = true } = options;
    const list = document.getElementById("bookmarksList");
    if (!currentDictRepo) {
        console.error("No dictionary selected");
        if (list) list.innerHTML = "未找到可用的词典，请检查网络连接";
        return false;
    }
    setupSearch(MAX_RESULTS);
    await setupBookmarks();
    if (doShow) await showImage();
    return true;
}

async function initializeDictSelector() {
    try {
        const data = await loadJSONFile(DATA_FILE);
        const dictConfigs = data.dicts || [];
        urlProxyList = normalizeProxyEntries(data.urls || []);
        metaConfigs = data.config || {};
        fileInfoList = data.files || [];
        font_options = data.fonts || DEFAULT_FONTS;
        initializeSettingsPanel();

        const dictSelector = document.getElementById("dictSelector");
        dictSelector.innerHTML = "";

        if (dictConfigs.length > 0) {
            currentDictRepo = dictConfigs[0].repo;
            repoConfigs = dictConfigs.reduce((acc, item) => {
                acc[item.repo] = item;
                return acc;
            }, {});

            dictConfigs.forEach(dict => {
                const logo = `images/logos/${dict.repo}.png`;
                repoConfigs[dict.repo].logo = logo;
                const opt = document.createElement("option");
                opt.value = dict.repo;
                opt.textContent = dict.name;
                opt.dataset.logo = logo;
                dictSelector.appendChild(opt);
            });

            // Load default dictionary first, then lazy-load others
            const defaultData = await initializeDictData(dictConfigs[0].repo);
            repoConfigs[dictConfigs[0].repo] = { ...repoConfigs[dictConfigs[0].repo], ...defaultData };

            dictConfigs.slice(1).forEach(dict => {
                pendingDictLoads[dict.repo] = (async () => {
                    const d = await initializeDictData(dict.repo);
                    repoConfigs[dict.repo] = { ...repoConfigs[dict.repo], ...d };
                })();
            });

            dictSelector.addEventListener("change", async e => {
                const selected = dictConfigs.find(d => d.repo === e.target.value);
                if (!selected) return;
                if (pendingDictLoads[selected.repo]) {
                    try {
                        await pendingDictLoads[selected.repo];
                    } catch (err) {
                        console.warn(`Background load failed for ${selected.repo}:`, err);
                    }
                }
                const prev = currentDictRepo;
                applyDictionarySelection(selected.repo, selected.logo, selected.name);
                resetSearchUi();
                imageCache.clearCurrentDict(prev);
                currentImageIndex = DEFAULT_IMAGE_INDEX;
                await initializeDictionaryView();
            });

            applyDictionarySelection(currentDictRepo, repoConfigs[currentDictRepo].logo, repoConfigs[currentDictRepo].name);
            await initializeFromURL();
            document.body.dataset.ready = "true";
        }
    } catch (error) {
        console.error("Failed to load dictionary list:", error);
    }
}

document.addEventListener("DOMContentLoaded", async function () {
    const prevBtn = document.getElementById("prevBtn");
    const nextBtn = document.getElementById("nextBtn");
    const container = document.querySelector(".result-container");

    // Navigation arrows always visible (CSS handles show on hover)
    prevBtn.addEventListener("click", async () => changeImage(false));
    nextBtn.addEventListener("click", async () => changeImage(true));

    // Keyboard navigation
    document.addEventListener("keydown", async event => {
        const active = document.activeElement;
        if (active.id === "searchInput" || active.closest(".search-buttons")) return;
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            await changeImage(false);
        } else if (event.key === "ArrowRight") {
            event.preventDefault();
            await changeImage(true);
        } else if (event.key === "Home") {
            event.preventDefault();
            const pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE;
            if (isSpreadMode) {
                currentImageIndex = padPage(2);
            } else {
                currentImageIndex = getFirstPageId(pageConfigs);
            }
            await showImage(IMAGE_CACHE_CONFIG.preloadCount);
        } else if (event.key === "End") {
            event.preventDefault();
            if (isSpreadMode) {
                const pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE;
                let last = pageConfigs.content.count;
                if (last % 2 === 1) last--;
                if (last < 2) last = 2;
                currentImageIndex = padPage(last);
            } else {
                const pageConfigs = repoConfigs[currentDictRepo]?.pages || DEFAULT_PAGE;
                let idx;
                if (pageConfigs.footer.count > 0) {
                    idx = `${pageConfigs.footer.prefix}${padPage(pageConfigs.footer.count)}`;
                } else if (pageConfigs.content.count > 0) {
                    idx = padPage(pageConfigs.content.count);
                } else {
                    idx = getFirstPageId(pageConfigs);
                }
                currentImageIndex = idx;
            }
            await showImage(IMAGE_CACHE_CONFIG.preloadCount);
        }
    });

    // Fullscreen
    document.getElementById("fullscreenBtn").addEventListener("click", toggleFullscreen);

    // Touch swipe
    setupTouchSwipe();

    // Tip popup
    const tipToggle = document.getElementById("tipToggle");
    const pinyinPopup = document.getElementById("pinyinPopup");
    const closePopup = document.getElementById("closePopup");
    tipToggle.addEventListener("click", () => pinyinPopup.style.display = "flex");
    closePopup.addEventListener("click", () => pinyinPopup.style.display = "none");
    pinyinPopup.addEventListener("click", e => {
        if (e.target === pinyinPopup) pinyinPopup.style.display = "none";
    });

    // Sidebar
    document.getElementById("sidebarToggle").addEventListener("click", toggleSidebar);
    document.getElementById("closeSidebarPopup").addEventListener("click", closeSidebarHandler);

    document.getElementById("bookmarksList").innerHTML = "加载目录中……";
    try {
        await initializeDictSelector();
    } catch (error) {
        console.error("Error initializing application:", error);
        document.getElementById("bookmarksList").innerHTML = "加载失败，请刷新重试";
    }
});
