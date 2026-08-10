/// <reference path="../../online-streaming-provider.d.ts" />
/// <reference path="../../core.d.ts" />

/**
 * AnimeJara - Online Streaming Provider for animejara.com
 * 
 * Targets Filemoon embed server for HLS (.m3u8) extraction.
 * 
 * Flow:
 * 1. Episode page → extract multiplayer iframe (multiplayer.streamhj.top)
 * 2. Multiplayer page → extract Filemoon iframe (bysekoze.com/e/...)
 * 3. Filemoon page → extract .m3u8 URL (requires JS execution via ChromeDP)
 */

class Provider {

    baseUrl = "https://animejara.com"

    getSettings(): Settings {
        return {
            episodeServers: ["Filemoon"],
            supportsDub: true,
        }
    }

    // ---------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------

    _normalise(s: string): string {
        return s
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    }

    _similarity(query: string, candidate: string): number {
        const qWords = this._normalise(query).split(" ")
        const cNorm = this._normalise(candidate)
        const matches = qWords.filter((w) => cNorm.includes(w)).length
        return qWords.length > 0 ? matches / qWords.length : 0
    }

    _defaultHeaders(referer?: string): Record<string, string> {
        const headers: Record<string, string> = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        }
        if (referer) {
            headers["Referer"] = referer
        }
        return headers
    }

    // ---------------------------------------------------------------------------
    // search
    // ---------------------------------------------------------------------------

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = encodeURIComponent(opts.query)
        // WordPress search uses ?s= parameter
        const searchUrl = `${this.baseUrl}/catalogo?s=${query}`

        const res = await fetch(searchUrl, {
            headers: this._defaultHeaders(this.baseUrl),
        })

        if (!res.ok) {
            console.error(`[AnimeJara] Search failed: ${res.status}`)
            return []
        }

        const html = await res.text()
        const $ = LoadDoc(html)

        const results: SearchResult[] = []

        // Search results in WordPress are typically in article, .post, .type-post, or similar containers
        // Try multiple selectors for flexibility
        const selectors = [
            "article",
            ".post",
            ".type-post",
            ".search-result",
            ".anime-item",
            ".item-anime",
            ".col-anime",
            ".anime-card",
            "[class*='anime']",
            "main .post",
            "#content .post",
            ".posts .post",
            ".entry",
        ]

        for (const selector of selectors) {
            $(selector).each((i, el) => {
                const $el = el
                const link = $el.find("a").first()
                const titleEl = $el.find("h1, h2, h3, h4, .title, .entry-title, .post-title, [class*='title']").first()
                
                const href = link.attr("href")
                const title = titleEl.text() || link.attr("title") || ""

                if (href && title && title.length > 2) {
                    let fullUrl = href
                    if (!href.startsWith("http")) {
                        fullUrl = `${this.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`
                    }
                    
                    // Extract slug from URL for ID (prefer /anime/ slug)
                    const slugMatch = fullUrl.match(/\/anime\/([^\/]+)/)
                    const id = slugMatch ? slugMatch[1] : fullUrl

                    // Avoid duplicates
                    if (!results.some(r => r.id === id)) {
                        results.push({
                            id,
                            title: title.trim(),
                            url: fullUrl,
                            subOrDub: "sub",
                        })
                    }
                }
            })
            
            if (results.length > 0) break
        }

        // Fallback: look for any links to anime pages
        if (results.length === 0) {
            $("a[href*='/anime/']").each((i, el) => {
                const $el = el
                const href = $el.attr("href")
                const title = $el.attr("title") || $el.text() || $el.find("img").attr("alt") || ""
                
                if (href && title && title.length > 2) {
                    let fullUrl = href
                    if (!href.startsWith("http")) {
                        fullUrl = `${this.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`
                    }
                    
                    const slugMatch = fullUrl.match(/\/anime\/([^\/]+)/)
                    const id = slugMatch ? slugMatch[1] : fullUrl

                    // Avoid duplicates
                    if (!results.some(r => r.id === id)) {
                        results.push({
                            id,
                            title: title.trim(),
                            url: fullUrl,
                            subOrDub: "sub",
                        })
                    }
                }
            })
        }

        // Sort by similarity
        results.sort((a, b) => this._similarity(opts.query, b.title) - this._similarity(opts.query, a.title))

        return results.slice(0, 20)
    }

    // ---------------------------------------------------------------------------
    // findEpisodes
    // ---------------------------------------------------------------------------

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        const slug = id
        const animeUrl = `${this.baseUrl}/anime/${slug}/`

        const res = await fetch(animeUrl, {
            headers: this._defaultHeaders(this.baseUrl),
        })

        if (!res.ok) {
            throw new Error(`Anime page not found for "${slug}" (status ${res.status})`)
        }

        const html = await res.text()
        const $ = LoadDoc(html)

        const episodes: EpisodeDetails[] = []

        // AnimeJara loads episodes dynamically via JavaScript (TEMPORADAS_DATA variable)
        // Extract the TEMPORADAS_DATA from script tags
        let temporadasData: any = null
        let foundInScript = false
        $("script").each((i, el) => {
            const content = el.text() || el.html() || ""
            if (!content.includes('TEMPORADAS_DATA')) return
            console.log(`[AnimeJara] Found TEMPORADAS_DATA in script ${i}, length: ${content.length}`)
            
            // Look for TEMPORADAS_DATA = [...];
            // The data is valid JSON with escaped forward slashes
            let match = content.match(/const\s+TEMPORADAS_DATA\s*=\s*(\[[\s\S]*?\]);\s*const\s/)
            if (!match) {
                match = content.match(/const\s+TEMPORADAS_DATA\s*=\s*(\[[\s\S]*?\]);\s*$/)
            }
            if (!match) {
                match = content.match(/const\s+TEMPORADAS_DATA\s*=\s*(\[[\s\S]*?\]);/)
            }
            if (!match) {
                // Try finding just the array part
                const arrMatch = content.match(/TEMPORADAS_DATA\s*=\s*(\[[\s\S]*?\])/)
                if (arrMatch) match = arrMatch
            }
            
            if (match && match[1]) {
                try {
                    // Clean up the JSON-like string and parse
                    // The data has escaped forward slashes (\/) which need to be unescaped
                    let jsonStr = match[1]
                        .replace(/\\\//g, '/')  // unescape forward slashes
                    console.log(`[AnimeJara] Parsing JSON, first 200 chars: ${jsonStr.substring(0, 200)}`)
                    temporadasData = JSON.parse(jsonStr)
                    foundInScript = true
                    console.log(`[AnimeJara] Successfully parsed ${temporadasData.length} seasons`)
                    return false // break
                } catch (e) {
                    console.log(`[AnimeJara] Failed to parse TEMPORADAS_DATA: ${e}`)
                    console.log(`[AnimeJara] Match preview: ${match[1]?.substring(0, 500)}`)
                }
            }
        })

        if (!foundInScript || !temporadasData || !Array.isArray(temporadasData)) {
            console.log(`[AnimeJara] TEMPORADAS_DATA not found or invalid, falling back to static links`)
            // Fallback: try to find static episode links
            $("a[href*='/episode/']").each((i, el) => {
                const $el = el
                const href = $el.attr("href")
                const title = $el.text().trim() || $el.attr("title") || ""

                if (href && title) {
                    let fullUrl = href
                    if (!href.startsWith("http")) {
                        fullUrl = `${this.baseUrl}${href.startsWith("/") ? "" : "/"}${href}`
                    }

                    let epNum = 0
                    const urlEpMatch = fullUrl.match(/-(\d+)x(\d+)/)
                    if (urlEpMatch) {
                        epNum = parseInt(urlEpMatch[2], 10)
                    } else {
                        const titleEpMatch = title.match(/(?:ep|episodio|cap[ií]tulo)\s*(\d+)/i)
                        if (titleEpMatch) {
                            epNum = parseInt(titleEpMatch[1], 10)
                        } else {
                            epNum = episodes.length + 1
                        }
                    }

                    if (epNum > 0) {
                        episodes.push({
                            id: `${slug}::${epNum}`,
                            number: epNum,
                            url: fullUrl,
                            title: title,
                        })
                    }
                }
            })
        } else {
            // Parse episodes from TEMPORADAS_DATA
            for (const temporada of temporadasData) {
                const seasonNum = temporada.numero_temporada
                const episodios = temporada.episodios || []
                
                for (const ep of episodios) {
                    const epNum = parseInt(ep.numero_episodio, 10)
                    if (isNaN(epNum)) continue
                    
                    // Build episode URL: /episode/{slug}-{season}x{episode}/
                    const epSlug = `${slug}-${seasonNum}x${epNum}`
                    const epUrl = `${this.baseUrl}/episode/${epSlug}/`
                    
                    const epTitle = ep.nombre_episodio?.trim() 
                        ? `Temporada ${seasonNum} - ${ep.nombre_episodio}`
                        : `Temporada ${seasonNum} - Episodio ${epNum}`

                    episodes.push({
                        id: `${slug}::${epNum}`,
                        number: epNum,
                        url: epUrl,
                        title: epTitle,
                    })
                }
            }
        }

        // Sort by episode number
        episodes.sort((a, b) => a.number - b.number)

        // Remove duplicates (same episode number)
        const uniqueEpisodes = episodes.filter((ep, idx, arr) => 
            arr.findIndex(e => e.number === ep.number) === idx
        )

        if (uniqueEpisodes.length === 0) {
            throw new Error("No episodes found.")
        }

        return uniqueEpisodes
    }

    // ---------------------------------------------------------------------------
    // findEpisodeServer - Main extraction logic for Filemoon
    // ---------------------------------------------------------------------------

    async findEpisodeServer(
        episode: EpisodeDetails | { MediaID?: number; EpisodeJSON?: EpisodeDetails | string; Server?: string },
        server?: string
    ): Promise<EpisodeServer> {
        try {
            // Handle playground passing object with MediaID/EpisodeJSON/Server
            let episodeDetails: EpisodeDetails
            let serverName: string

            console.log(`[AnimeJara] findEpisodeServer called with args[0]:`, JSON.stringify(episode).substring(0, 300))

            if (typeof episode === 'object' && episode !== null && 'EpisodeJSON' in episode) {
                // Playground format: { MediaID, EpisodeJSON, Server }
                // EpisodeJSON might be a string (JSON) or object
                const rawEpisode = episode.EpisodeJSON
                if (typeof rawEpisode === 'string') {
                    try {
                        episodeDetails = JSON.parse(rawEpisode)
                    } catch (e) {
                        throw new Error(`Failed to parse EpisodeJSON string: ${e}`)
                    }
                } else {
                    episodeDetails = rawEpisode as EpisodeDetails
                }
                serverName = episode.Server || server || ''
            } else {
                // Standard format: (episode, server)
                episodeDetails = episode as EpisodeDetails
                serverName = server || ''
            }

            if (!episodeDetails?.url) {
                throw new Error('findEpisodeServer: Episode URL is missing from EpisodeJSON')
            }

            const serverLower = serverName.toLowerCase()
            if (serverLower !== "filemoon") {
                throw new Error(`Server "${serverName}" not supported. Only "Filemoon" is available.`)
            }

            // Step 1: Fetch episode page to get multiplayer iframe
            const episodeUrl = episodeDetails.url
            console.log(`[AnimeJara] Fetching episode page: ${episodeUrl}`)

            // Try multiple URL patterns if the first one fails
            const urlsToTry = [episodeUrl]
            
            // If URL doesn't have season x episode pattern, try adding it
            if (!episodeUrl.match(/-\d+x\d+\//)) {
                // Try to extract season/episode from ID like "naruto::1"
                const idMatch = episodeDetails.id.match(/^(.+)::(\d+)$/)
                if (idMatch) {
                    const slug = idMatch[1]
                    const epNum = parseInt(idMatch[2])
                    // Try season 1 format
                    urlsToTry.push(`${this.baseUrl}/episode/${slug}-1x${epNum}/`)
                    // Try without season
                    urlsToTry.push(`${this.baseUrl}/episode/${slug}-${epNum}/`)
                }
            }

            let episodeRes: any = null
            let episodeHtml: string = ''
            let lastError: string = ''
            
            for (const url of urlsToTry) {
                console.log(`[AnimeJara] Trying episode URL: ${url}`)
                
                // Try fetch first (faster)
                try {
                    episodeRes = await fetch(url, {
                        headers: this._defaultHeaders(this.baseUrl),
                    })
                    console.log(`[AnimeJara] Fetch completed for ${url}, status: ${episodeRes?.status}`)
                    
                    if (episodeRes && episodeRes.ok) {
                        episodeHtml = await episodeRes.text()
                        console.log(`[AnimeJara] Episode page fetched from ${url}, length: ${episodeHtml.length}`)
                        
                        // Check if we got a challenge page or empty content
                        if (episodeHtml.length < 1000) {
                            console.log(`[AnimeJara] WARNING: Episode page too short, possible challenge. First 500 chars: ${episodeHtml.substring(0, 500)}`)
                        }
                        
                        // Check for Cloudflare challenge
                        if (episodeHtml.includes('cf-challenge') || episodeHtml.includes('cloudflare') || episodeHtml.includes('Checking your browser')) {
                            console.log(`[AnimeJara] Cloudflare challenge detected, trying ChromeDP...`)
                            const chromeHtml = await this._fetchWithChromeDP(url)
                            if (chromeHtml && chromeHtml.length > 1000) {
                                console.log(`[AnimeJara] ChromeDP fetch succeeded, length: ${chromeHtml.length}`)
                                episodeHtml = chromeHtml
                            }
                        }
                        
                        // Success - break out of loop
                        episodeUrl = url // update to working URL for referer
                        break
                    } else {
                        lastError = `Failed to fetch episode page (status ${episodeRes?.status})`
                    }
                } catch (e) {
                    console.error(`[AnimeJara] Fetch exception for ${url}: ${e}`)
                    lastError = `Network error: ${e}`
                    // Try ChromeDP as fallback for network errors too
                    console.log(`[AnimeJara] Trying ChromeDP as fallback...`)
                    const chromeHtml = await this._fetchWithChromeDP(url)
                    if (chromeHtml && chromeHtml.length > 1000) {
                        console.log(`[AnimeJara] ChromeDP fallback succeeded, length: ${chromeHtml.length}`)
                        episodeHtml = chromeHtml
                        episodeUrl = url
                        break
                    }
                    continue
                }
            }

            // If fetch completely failed, try ChromeDP on the original URL as last resort
            if (!episodeHtml || episodeHtml.length < 1000) {
                console.log(`[AnimeJara] All fetch attempts failed, trying ChromeDP on original URL...`)
                const chromeHtml = await this._fetchWithChromeDP(episodeUrl)
                if (chromeHtml && chromeHtml.length > 1000) {
                    console.log(`[AnimeJara] ChromeDP last resort succeeded, length: ${chromeHtml.length}`)
                    episodeHtml = chromeHtml
                } else {
                    throw new Error(`All URL patterns failed. Last error: ${lastError}`)
                }
            }
            
            const $episode = LoadDoc(episodeHtml)

        // Extract multiplayer iframe URL from #iframe-video
        const multiplayerIframe = $episode("#iframe-video").first()
        let multiplayerUrl = multiplayerIframe.attr("src")

        if (!multiplayerUrl) {
            // Fallback: search for any iframe with streamhj.top
            $episode("iframe[src*='streamhj.top']").each((i, el) => {
                const src = el.attr("src")
                if (src && src.includes("multiplayer")) {
                    multiplayerUrl = src
                    return false // break
                }
            })
        }

        if (!multiplayerUrl) {
            // Debug: log all iframes found
            const iframes: string[] = []
            $episode("iframe").each((i, el) => {
                iframes.push(el.attr("src") || '')
            })
            console.log(`[AnimeJara] Iframes found: ${iframes.join(', ')}`)
            // Also log the HTML around #reproductor-wrapper if exists
            const reproductor = $episode("#reproductor-wrapper").html()
            if (reproductor) {
                console.log(`[AnimeJara] #reproductor-wrapper content: ${reproductor.substring(0, 500)}`)
            }
            throw new Error("Could not find multiplayer iframe on episode page")
        }

        console.log(`[AnimeJara] Found multiplayer URL: ${multiplayerUrl}`)

        // Step 2: Fetch multiplayer page to get Filemoon URL
        // The multiplayer page has server buttons with onclick handlers, not iframes
        let multiplayerRes
        let multiplayerHtml: string = ''
        try {
            multiplayerRes = await fetch(multiplayerUrl, {
                headers: this._defaultHeaders(episodeUrl),
            })
            console.log(`[AnimeJara] Multiplayer fetch completed, status: ${multiplayerRes?.status}`)
            
            if (multiplayerRes && multiplayerRes.ok) {
                multiplayerHtml = await multiplayerRes.text()
            } else {
                throw new Error(`Failed to fetch multiplayer page (status ${multiplayerRes?.status})`)
            }
        } catch (e) {
            console.error(`[AnimeJara] Multiplayer fetch exception: ${e}`)
            console.log(`[AnimeJara] Trying ChromeDP as fallback for multiplayer...`)
            multiplayerHtml = await this._fetchWithChromeDP(multiplayerUrl) || ''
            if (!multiplayerHtml || multiplayerHtml.length < 1000) {
                throw new Error(`Failed to fetch multiplayer page: ${e}`)
            }
        }
        
        console.log(`[AnimeJara] Multiplayer page fetched, length: ${multiplayerHtml.length}`)
        
        // Parse the multiplayer page to find Filemoon server button
        // The page has <li> elements with onclick="playVideo(' https://bysekoze.com/e/...')"
        let filemoonUrl = ''
        
        // Try to extract from static HTML first
        const $multiplayer = LoadDoc(multiplayerHtml)
        
        // Look for Filemoon button in the server list
        $multiplayer("#logo-list li, .server-list li, [onclick*='filemoon'], [onclick*='bysekoze']").each((i, el) => {
            const onclick = el.attr("onclick") || ""
            const text = el.text() || ""
            const imgAlt = el.find("img").attr("alt") || ""
            
            // Check if this is the Filemoon server
            if (onclick.includes("bysekoze") || text.toLowerCase().includes("filemoon") || imgAlt.toLowerCase().includes("filemoon")) {
                // Extract URL from onclick: playVideo(" https://bysekoze.com/e/...")
                const match = onclick.match(/playVideo\s*\(\s*["']\s*(https?:\/\/[^"']+)["']/)
                if (match && match[1]) {
                    filemoonUrl = match[1].trim()
                    console.log(`[AnimeJara] Found Filemoon URL in onclick: ${filemoonUrl}`)
                    return false // break
                }
            }
        })
        
        // Fallback: search all onclick attributes for bysekoze/filemoon
        if (!filemoonUrl) {
            $multiplayer("[onclick]").each((i, el) => {
                const onclick = el.attr("onclick") || ""
                const match = onclick.match(/playVideo\s*\(\s*["']\s*(https?:\/\/bysekoze\.com\/e\/[^"']+)["']/)
                if (match && match[1]) {
                    filemoonUrl = match[1].trim()
                    console.log(`[AnimeJara] Found Filemoon URL in onclick (fallback): ${filemoonUrl}`)
                    return false
                }
            })
        }
        
        // If still not found, try ChromeDP on multiplayer page
        if (!filemoonUrl) {
            console.log(`[AnimeJara] Filemoon URL not found in static HTML, trying ChromeDP on multiplayer page...`)
            const chromeHtml = await this._fetchWithChromeDP(multiplayerUrl)
            if (chromeHtml && chromeHtml.length > 1000) {
                const $chromeMultiplayer = LoadDoc(chromeHtml)
                
                $chromeMultiplayer("[onclick]").each((i, el) => {
                    const onclick = el.attr("onclick") || ""
                    const match = onclick.match(/playVideo\s*\(\s*["']\s*(https?:\/\/bysekoze\.com\/e\/[^"']+)["']/)
                    if (match && match[1]) {
                        filemoonUrl = match[1].trim()
                        console.log(`[AnimeJara] Found Filemoon via ChromeDP: ${filemoonUrl}`)
                        return false
                    }
                })
            }
        }
        
        if (!filemoonUrl) {
            throw new Error("Could not find Filemoon server URL on multiplayer page")
        }

        console.log(`[AnimeJara] Found Filemoon URL: ${filemoonUrl}`)

        // Step 3: Fetch Filemoon page and extract .m3u8 URL
        // Filemoon uses JavaScript to load the player, so we need ChromeDP
        const m3u8Url = await this._extractM3u8FromFilemoon(filemoonUrl, multiplayerUrl)

        if (!m3u8Url) {
            throw new Error("Could not extract .m3u8 URL from Filemoon page")
        }

        console.log(`[AnimeJara] Extracted .m3u8 URL: ${m3u8Url}`)

        const isM3u8 = /\.m3u8/i.test(m3u8Url)

 return {
                server: "Filemoon",
                headers: {
                    "Referer": filemoonUrl,
                    "Origin": new URL(filemoonUrl).origin,
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                },
                videoSources: [
                    {
                        url: m3u8Url,
                        type: isM3u8 ? "m3u8" : "mp4",
                        quality: "auto",
                        subtitles: [],
                    },
                ],
            }
        } catch (error) {
            console.error(`[AnimeJara] findEpisodeServer fatal error: ${error}`)
            throw error
        }
    }

    // ---------------------------------------------------------------------------
    // Helper: Fetch page with ChromeDP (for Cloudflare bypass)
    // ---------------------------------------------------------------------------

    async _fetchWithChromeDP(url: string): Promise<string | null> {
        try {
            console.log(`[AnimeJara] Using ChromeDP to fetch: ${url}`)
            const browser = await ChromeDP.newBrowser({
                headless: true,
                timeout: 30,
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            })
            await browser.navigate(url)
            await browser.sleep(3000)
            const html = await browser.outerHTML("html")
            await browser.close()
            return html
        } catch (e) {
            console.log(`[AnimeJara] ChromeDP fetch failed: ${e}`)
            return null
        }
    }

    // ---------------------------------------------------------------------------
    // Extract .m3u8 from Filemoon page using ChromeDP
    // ---------------------------------------------------------------------------

    async _extractM3u8FromFilemoon(filemoonUrl: string, referer: string): Promise<string | null> {
        try {
            console.log(`[AnimeJara] Using ChromeDP to extract .m3u8 from: ${filemoonUrl}`)

            // Use ChromeDP to navigate and intercept network requests
            const browser = await ChromeDP.newBrowser({
                headless: true,
                timeout: 30,
                userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            })

            let m3u8Url: string | null = null

            // Navigate and wait for network requests
            await browser.navigate(filemoonUrl)

            // Wait a bit for the player to initialize and make requests
            await browser.sleep(10000)

            // Try to evaluate JavaScript to find the video source
            try {
                const jsCode = String.raw`
                    (function() {
                        // Look for video elements
                        const videos = document.querySelectorAll('video')
                        for (const v of videos) {
                            if (v.src && v.src.includes('.m3u8')) return v.src
                            const sources = v.querySelectorAll('source')
                            for (const s of sources) {
                                if (s.src && s.src.includes('.m3u8')) return s.src
                            }
                        }
                        // Look for HLS.js players
                        if (window.hls && window.hls.url) return window.hls.url
                        if (window.player && window.player.hls && window.player.hls.url) return window.player.hls.url
                        if (window.Hls && window.Hls.instances) {
                            for (const hls of window.Hls.instances) {
                                if (hls.url) return hls.url
                            }
                        }
                        // Search in scripts for master.m3u8
                        const scripts = document.querySelectorAll('script')
                        for (const s of scripts) {
                            const content = s.textContent || s.innerText || ''
                            const matches = content.match(/https?:\/\/[^'"\s]+\.m3u8[^'"\s]*/g)
                            if (matches && matches.length > 0) return matches[0]
                        }
                        // Also check iframes for embedded players
                        const iframes = document.querySelectorAll('iframe')
                        let iframeResults = []
                        for (const iframe of iframes) {
                            try {
                                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document
                                const iframeVideos = iframeDoc.querySelectorAll('video')
                                for (const v of iframeVideos) {
                                    if (v.src && v.src.includes('.m3u8')) iframeResults.push(v.src)
                                    const sources = iframeDoc.querySelectorAll('source')
                                    for (const s of sources) {
                                        if (s.src && s.src.includes('.m3u8')) iframeResults.push(s.src)
                                    }
                                }
                                const iframeScripts = iframeDoc.querySelectorAll('script')
                                for (const s of iframeScripts) {
                                    const content = s.textContent || s.innerText || ''
                                    const matches = content.match(/https?:\/\/[^'"\s]+\.m3u8[^'"\s]*/g)
                                    if (matches && matches.length > 0) iframeResults.push(...matches)
                                }
                            } catch (e) {
                                // Cross-origin iframe, skip
                            }
                        }
                        if (iframeResults.length > 0) return iframeResults[0]
                        return null
                    })()
                `
                const result = await browser.evaluate(jsCode)
                if (result && typeof result === 'string' && result.includes('.m3u8')) {
                    m3u8Url = result
                }
            } catch (e) {
                console.log(`[AnimeJara] JS evaluation failed: ${e}`)
            }

            // Also try to find and click play button if video exists
            if (!m3u8Url) {
                try {
                    const playClickCode = String.raw`
                        (function() {
                            const videos = document.querySelectorAll('video')
                            for (const v of videos) {
                                v.play().catch(() => {})
                            }
                            // Click play buttons
                            const playButtons = document.querySelectorAll('.play-btn, .vjs-big-play-button, button[title*="play"], [class*="play"]')
                            for (const btn of playButtons) {
                                btn.click()
                            }
                        })()
                    `
                    await browser.evaluate(playClickCode)
                    await browser.sleep(3000)
                    
                    // Check again after potential play click
                    const checkAfterPlayCode = String.raw`
                        (function() {
                            const videos = document.querySelectorAll('video')
                            for (const v of videos) {
                                if (v.src && v.src.includes('.m3u8')) return v.src
                                const sources = v.querySelectorAll('source')
                                for (const s of sources) {
                                    if (s.src && s.src.includes('.m3u8')) return s.src
                                }
                            }
                            if (window.hls && window.hls.url) return window.hls.url
                            if (window.player && window.player.hls && window.player.hls.url) return window.player.hls.url
                            if (window.Hls && window.Hls.instances) {
                                for (const hls of window.Hls.instances) {
                                    if (hls.url) return hls.url
                                }
                            }
                            const scripts = document.querySelectorAll('script')
                            for (const s of scripts) {
                                const content = s.textContent || s.innerText || ''
                                const matches = content.match(/https?:\/\/[^'"\s]+\.m3u8[^'"\s]*/g)
                                if (matches && matches.length > 0) return matches[0]
                            }
                            return null
                        })()
                    `
                    const result2 = await browser.evaluate(checkAfterPlayCode)
                    if (result2 && typeof result2 === 'string' && result2.includes('.m3u8')) {
                        m3u8Url = result2
                    }
                } catch (e) {
                    console.log(`[AnimeJara] Play click attempt failed: ${e}`)
                }
            }

            // Debug: dump page HTML to understand structure
            if (!m3u8Url) {
                try {
                    const html = await browser.outerHTML("html")
                    console.log(`[AnimeJara] Filemoon page HTML length: ${html.length}`)
                    // Look for any .m3u8 in the raw HTML
                    const m3u8InHtml = html.match(/https?:\/\/[^'"\s]+\.m3u8[^'"\s]*/g)
                    if (m3u8InHtml && m3u8InHtml.length > 0) {
                        console.log(`[AnimeJara] Found .m3u8 in raw HTML: ${m3u8InHtml[0]}`)
                        m3u8Url = m3u8InHtml[0]
                    } else {
                        // Check for video elements
                        const videoCount = html.match(/<video/gi)?.length || 0
                        const iframeCount = html.match(/<iframe/gi)?.length || 0
                        const scriptCount = html.match(/<script/gi)?.length || 0
                        console.log(`[AnimeJara] Page structure: videos=${videoCount}, iframes=${iframeCount}, scripts=${scriptCount}`)
                        // Look for common player IDs/classes
                        const playerMarkers = ['video', 'player', 'hls', 'm3u8', 'master', 'playlist']
                        for (const marker of playerMarkers) {
                            if (html.toLowerCase().includes(marker)) {
                                console.log(`[AnimeJara] Found "${marker}" in HTML`)
                            }
                        }
                    }
                } catch (e) {
                    console.log(`[AnimeJara] Debug HTML dump failed: ${e}`)
                }
            }

            // If not found via JS, try to get page HTML and parse
            if (!m3u8Url) {
                try {
                    const html = await browser.outerHTML("html")
                    const $ = LoadDoc(html)
                    
                    // Check video elements
                    $("video").each((i, el) => {
                        const src = el.attr("src")
                        if (src && src.includes(".m3u8")) {
                            m3u8Url = src
                            return false
                        }
                        el.find("source").each((j, srcEl) => {
                            const s = srcEl.attr("src")
                            if (s && s.includes(".m3u8")) {
                                m3u8Url = s
                                return false
                            }
                        })
                    })

// Check scripts for m3u8 URLs
                    if (!m3u8Url) {
                        $("script").each((i, el) => {
                            const content = el.text() || el.html() || ""
                            const matches = content.match(/https?:\/\/[^'"\s]+\.m3u8[^'"\s]*/g)
                            if (matches && matches.length > 0) {
                                m3u8Url = matches[0]
                                return false
                            }
                        })
                    }
                } catch (e) {
                    console.log(`[AnimeJara] HTML parsing failed: ${e}`)
                }
            }

            await browser.close()

            return m3u8Url
        } catch (error) {
            console.error(`[AnimeJara] ChromeDP extraction failed: ${error}`)
            return null
        }
    }
}

if (typeof window !== "undefined" && (window as any).registerProvider) {
    (window as any).registerProvider(new Provider())
}