/// <reference path="../onlinestream-provider.d.ts" />
/// <reference path="../core.d.ts" />

class Provider {
    private baseUrl = "https://ww3.animeonline.ninja"
    private headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://ww3.animeonline.ninja/",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8"
    }

    getSettings(): Settings {
        return {
            episodeServers: ["streamtape", "netu", "filemoon", "voe", "doodstream", "uqload", "default"],
            supportsDub: true
        }
    }

    async search(opts: SearchOptions): Promise<SearchResult[]> {
        const query = opts.query || opts.media.romajiTitle || opts.media.englishTitle || ""
        if (!query) return []

        console.log(`AnimeOnlineNinja: Searching for "${query}"`)

        try {
            const searchUrl = `${this.baseUrl}/?s=${encodeURIComponent(query)}`
            const res = await fetch(searchUrl, { headers: this.headers })
            
            if (!res.ok) {
                console.error(`AnimeOnlineNinja: Search failed ${res.status}`)
                return []
            }

            const html = res.text()
            const $ = LoadDoc(html)
            const results: SearchResult[] = []

            // Multiple selector attempts - the site uses /online/ for anime pages
            const selectors = [
                "ul.ListAnimes li article",
                "ul.List-Animes li article",
                "article.Anime",
                ".ListAnimes article",
                "div.post",
                ".items article",
                ".search-results article",
                "article",
                ".result-item",
                ".item"
            ]

            for (const selector of selectors) {
                $(selector).each((i, el) => {
                    let title = el.find("h3.Title").text().trim() 
                        || el.find("h3").text().trim() 
                        || el.find(".Title").text().trim()
                        || el.find("h2").text().trim()
                        || el.find("a").text().trim()
                    let href = el.find("a").attr("href") || el.attr("href")
                    
                    if (title && href && (href.includes("/anime/") || href.includes("/online/"))) {
                        const id = this.extractIdFromUrl(href)
                        if (!results.find(r => r.id === id)) {
                            results.push({
                                id: id,
                                title: title,
                                url: href.startsWith("http") ? href : `${this.baseUrl}${href}`,
                                subOrDub: this.detectAudioType(title)
                            })
                        }
                    }
                })
                if (results.length > 0) break
            }

            // Fallback: find all anime/online links
            if (results.length === 0) {
                $("a[href*='/online/'], a[href*='/anime/']").each((i, el) => {
                    const href = el.attr("href")
                    let title = el.attr("title") || el.text().trim()
                    
                    if (!href || !title || title.length < 3) return
                    if (href.endsWith("/online/") || href.endsWith("/anime/")) return
                    
                    const id = this.extractIdFromUrl(href)
                    if (id && !results.find(r => r.id === id)) {
                        results.push({
                            id: id,
                            title: title,
                            url: href.startsWith("http") ? href : `${this.baseUrl}${href}`,
                            subOrDub: this.detectAudioType(title)
                        })
                    }
                })
            }

            console.log(`AnimeOnlineNinja: Found ${results.length} results`)
            return results
        } catch (error) {
            console.error("AnimeOnlineNinja: Search error:", error)
            return []
        }
    }

    async findEpisodes(id: string): Promise<EpisodeDetails[]> {
        console.log(`AnimeOnlineNinja: Finding episodes for ${id}`)

        try {
            // Build anime URL - handle both full URLs and IDs
            // The site uses /online/ for anime pages
            let animeUrl = id
            if (!id.startsWith("http")) {
                animeUrl = `${this.baseUrl}/online/${id}/`
            }
            
            // Extract the anime slug from the ID for filtering (remove numeric suffix like -100724)
            const animeSlug = id.replace(/^.*\/(online|anime)\//, "").replace(/\/$/, "").replace(/-\d+$/, "")
            console.log(`AnimeOnlineNinja: Fetching ${animeUrl}, slug: ${animeSlug}`)
            
            const res = await fetch(animeUrl, { headers: this.headers })
            
            if (!res.ok) {
                console.error(`AnimeOnlineNinja: Failed to load anime page ${res.status}`)
                return []
            }

            const html = res.text()
            const $ = LoadDoc(html)
            const episodes: EpisodeDetails[] = []

            // Method 1: Find episode links in HTML - prioritize this to get real URLs
            // Only look within the main content area to avoid sidebar/related content
            $("a[href*='/episodio/']").each((i, el) => {
                const href = el.attr("href")
                if (!href) return
                
                // Extract the episode slug from URL (e.g., "naruto-cap-1" or "naruto-t3-cap-54")
                const episodeSlugMatch = href.match(/\/episodio\/([^\/]+)/)
                if (!episodeSlugMatch) return
                
                const episodeSlug = episodeSlugMatch[1].toLowerCase()
                const slugLower = animeSlug.toLowerCase()
                
                // Check if this episode belongs to the current anime
                // The episode slug should START with the anime slug
                if (!episodeSlug.startsWith(slugLower + "-")) return
                
                // Extract episode number from URL patterns like -cap-1, -t3-cap-54, etc.
                const epMatch = href.match(/-cap-(\d+)/)
                if (epMatch) {
                    const epNum = parseInt(epMatch[1])
                    if (!isNaN(epNum) && !episodes.find(e => e.number === epNum)) {
                        episodes.push({
                            id: `${id}$${epNum}`,
                            number: epNum,
                            url: href.startsWith("http") ? href : `${this.baseUrl}${href}`,
                            title: `Episodio ${epNum}`
                        })
                    }
                }
            })

            // Method 2: If no episodes found via links, try script extraction
            if (episodes.length === 0) {
                console.log("AnimeOnlineNinja: Trying script extraction method")
                const scriptMatch = html.match(/var\s+episodes\s*=\s*\[([\s\S]*?)\];/)
                if (scriptMatch) {
                    const episodesData = scriptMatch[1]
                    // Match [epNum, ...] patterns
                    const epMatches = episodesData.match(/\[(\d+),/g)
                    if (epMatches) {
                        epMatches.forEach(match => {
                            const epNum = parseInt(match.replace(/[\[\],]/g, ""))
                            if (!isNaN(epNum) && !episodes.find(e => e.number === epNum)) {
                                // For script-based extraction, we need to construct URL
                                const episodeUrl = `${this.baseUrl}/episodio/${animeSlug}-cap-${epNum}/`
                                episodes.push({
                                    id: `${id}$${epNum}`,
                                    number: epNum,
                                    url: episodeUrl,
                                    title: `Episodio ${epNum}`
                                })
                            }
                        })
                    }
                }
            }

            episodes.sort((a, b) => a.number - b.number)
            console.log(`AnimeOnlineNinja: Found ${episodes.length} episodes`)
            return episodes
        } catch (error) {
            console.error("AnimeOnlineNinja: Error finding episodes:", error)
            return []
        }
    }

    async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
        console.log(`AnimeOnlineNinja: Finding server for episode ${episode.number}`)

        const episodeUrl = episode.url || episode.id

        try {
            const res = await fetch(episodeUrl, { headers: this.headers })
            
            if (!res.ok) {
                throw new Error(`Failed to load episode page ${res.status}`)
            }

            const html = res.text()
            const videoSources: VideoSource[] = []
            const $ = LoadDoc(html)

            // Step 1: Get the multiserver embed URL from dooplay API
            let multiServerEmbedUrl = ""
            
            // Get the first player option to fetch multiserver
            const firstOption = $(".dooplay_player_option, li[data-post][data-nume]").first()
            const dataPost = firstOption.attr("data-post")
            const dataNume = firstOption.attr("data-nume")
            const dataType = firstOption.attr("data-type") || "tv"

            if (dataPost && dataNume) {
                const apiUrl = `${this.baseUrl}/wp-json/dooplayer/v1/post/${dataPost}?type=${dataType}&source=${dataNume}`
                
                const apiRes = await fetch(apiUrl, { 
                    headers: {
                        ...this.headers,
                        "Referer": episodeUrl
                    }
                })
                
                if (apiRes.ok) {
                    const responseText = apiRes.text()
                    try {
                        const apiData = JSON.parse(responseText)
                        multiServerEmbedUrl = apiData.embed_url || apiData.url || ""
                        if (multiServerEmbedUrl) {
                            multiServerEmbedUrl = multiServerEmbedUrl.replace(/\\\//g, "/")
                            if (multiServerEmbedUrl.startsWith("//")) {
                                multiServerEmbedUrl = "https:" + multiServerEmbedUrl
                            }
                        }
                    } catch {}
                }
            }

            // Step 2: Fetch the multiserver embed page to extract individual servers
            if (multiServerEmbedUrl) {
                try {
                    const embedRes = await fetch(multiServerEmbedUrl, {
                        headers: {
                            "User-Agent": this.headers["User-Agent"],
                            "Referer": episodeUrl
                        }
                    })
                    
                    if (embedRes.ok) {
                        const embedHtml = embedRes.text()
                        const embed$ = LoadDoc(embedHtml)
                        
                        // Pattern 1: Look for buttons/links with data-video or data-src
                        embed$("[data-video], [data-src], [data-url], [data-embed]").each((i, el) => {
                            const url = el.attr("data-video") || el.attr("data-src") || el.attr("data-url") || el.attr("data-embed")
                            const name = el.text().trim() || el.attr("title") || `Server ${i + 1}`
                            
                            if (url && url.startsWith("http") && !videoSources.find(s => s.url === url)) {
                                videoSources.push({
                                    url: url,
                                    type: url.includes(".m3u8") ? "m3u8" : url.includes(".mp4") ? "mp4" : "unknown",
                                    quality: name,
                                    subtitles: []
                                })
                            }
                        })
                        
                        // Pattern 2: Extract from JavaScript - look for server arrays
                        const serverArrayMatch = embedHtml.match(/(?:servers|videos|sources)\s*[=:]\s*(\[[\s\S]*?\])/i)
                        if (serverArrayMatch) {
                            try {
                                const servers = JSON.parse(serverArrayMatch[1])
                                if (Array.isArray(servers)) {
                                    servers.forEach((srv: any, i: number) => {
                                        const url = srv.url || srv.file || srv.src || srv.embed
                                        const name = srv.name || srv.label || srv.server || srv.lang || `Server ${i + 1}`
                                        if (url && !videoSources.find(s => s.url === url)) {
                                            videoSources.push({
                                                url: url,
                                                type: url.includes(".m3u8") ? "m3u8" : url.includes(".mp4") ? "mp4" : "unknown",
                                                quality: name,
                                                subtitles: []
                                            })
                                        }
                                    })
                                }
                            } catch {}
                        }
                        
                        // Pattern 3: Look for iframe sources
                        if (videoSources.length === 0) {
                            embed$("iframe").each((i, el) => {
                                const src = el.attr("src") || el.attr("data-src")
                                if (src && (src.startsWith("http") || src.startsWith("//"))) {
                                    const url = src.startsWith("//") ? "https:" + src : src
                                    videoSources.push({
                                        url: url,
                                        type: "unknown",
                                        quality: `Server ${i + 1}`,
                                        subtitles: []
                                    })
                                }
                            })
                        }
                        
                        // Pattern 4: Extract embed URLs from scripts (most reliable for this site)
                        const urlMatches = embedHtml.match(/https?:\/\/[^"'\s<>]+(?:\.m3u8|\.mp4|\/embed\/[^"'\s<>]+|\/e\/[^"'\s<>]+)/gi)
                        if (urlMatches) {
                            // Group URLs by language sections (typically: Sub, Latino, Castellano)
                            // We detect language from URLs that have it, then apply to nearby URLs
                            let currentLanguage = "Sub" // Default to Sub
                            
                            urlMatches.forEach((url, i) => {
                                let cleanUrl = url.replace(/["'<>]/g, "").trim()
                                
                                if (!videoSources.find(s => s.url === cleanUrl)) {
                                    let serverName = this.identifyServerFromUrl(cleanUrl)
                                    let detectedLanguage = this.identifyLanguageFromUrl(cleanUrl)
                                    
                                    // Update current language if detected
                                    if (detectedLanguage) {
                                        currentLanguage = detectedLanguage
                                    }
                                    
                                    let quality = `${serverName} - ${currentLanguage}`
                                    
                                    videoSources.push({
                                        url: cleanUrl,
                                        type: cleanUrl.includes(".m3u8") ? "m3u8" : cleanUrl.includes(".mp4") ? "mp4" : "unknown",
                                        quality: quality,
                                        subtitles: []
                                    })
                                }
                            })
                        }
                    }
                } catch (e) {
                    console.error(`AnimeOnlineNinja: Error fetching embed: ${e}`)
                }
                
                // If no individual servers found, add the multiserver URL as fallback
                if (videoSources.length === 0) {
                    videoSources.push({
                        url: multiServerEmbedUrl,
                        type: "unknown",
                        quality: "MULTISERVER",
                        subtitles: []
                    })
                }
            }

            // Fallback: look for iframes in original page
            if (videoSources.length === 0) {
                $("iframe").each((i, el) => {
                    const src = el.attr("src") || el.attr("data-src")
                    if (src && (src.startsWith("http") || src.startsWith("//"))) {
                        const url = src.startsWith("//") ? "https:" + src : src
                        if (!url.includes("google") && !url.includes("facebook")) {
                            videoSources.push({
                                url: url,
                                type: "unknown",
                                quality: `Server ${i + 1}`,
                                subtitles: []
                            })
                        }
                    }
                })
            }

            console.log(`AnimeOnlineNinja: Found ${videoSources.length} video sources`)
            return {
                server: server === "default" ? "animeonline" : server,
                headers: this.headers,
                videoSources: videoSources
            }
        } catch (error) {
            console.error("AnimeOnlineNinja: Error:", error)
            return { server: server, headers: this.headers, videoSources: [] }
        }
    }

    private identifyServerFromUrl(url: string): string {
        const urlLower = url.toLowerCase()
        if (urlLower.includes("streamtape")) return "Streamtape"
        if (urlLower.includes("filemoon") || urlLower.includes("filemooon")) return "Filemoon"
        if (urlLower.includes("voe.sx") || urlLower.includes("voe.")) return "Voe"
        if (urlLower.includes("dood")) return "Doodstream"
        if (urlLower.includes("uqload")) return "Uqload"
        if (urlLower.includes("netu") || urlLower.includes("hqq") || urlLower.includes("netuplayer")) return "Netu"
        if (urlLower.includes("mp4upload")) return "Mp4Upload"
        if (urlLower.includes("yourupload")) return "YourUpload"
        if (urlLower.includes("okru") || urlLower.includes("ok.ru")) return "Ok.ru"
        if (urlLower.includes("fembed") || urlLower.includes("femax")) return "Fembed"
        if (urlLower.includes("mixdrop")) return "Mixdrop"
        if (urlLower.includes("upstream")) return "Upstream"
        if (urlLower.includes("vidlox")) return "Vidlox"
        if (urlLower.includes("streamwish")) return "StreamWish"
        if (urlLower.includes("filelions")) return "FileLions"
        if (urlLower.includes("embedsito")) return "Embedsito"
        // Extract domain as fallback
        const domainMatch = url.match(/https?:\/\/([^\/]+)/)
        if (domainMatch) return domainMatch[1].split('.')[0]
        return "Unknown"
    }

    private identifyLanguageFromUrl(url: string): string {
        const urlLower = url.toLowerCase()
        // Check for language indicators in URL
        if (urlLower.includes("latino") || urlLower.includes("_lat_") || urlLower.includes("_lat.")) return "Latino"
        if (urlLower.includes("castellano") || urlLower.includes("_cast_") || urlLower.includes("_cast.") || urlLower.includes("castell")) return "Castellano"
        if (urlLower.includes("_sub_") || urlLower.includes("_sub.") || urlLower.includes("subtitulado")) return "Sub"
        // If no language indicator and it's a BD/standard release, assume Sub
        if (urlLower.includes("_bd_") && !urlLower.includes("latino") && !urlLower.includes("castell")) return "Sub"
        return ""
    }

    private extractIdFromUrl(url: string): string {
        // Handle both /online/ and /anime/ URLs
        const match = url.match(/\/(online|anime)\/([^\/]+)/)
        if (match) return match[2]
        // Fallback: get last path segment
        const fallback = url.match(/\/([^\/]+)\/?$/)
        return fallback ? fallback[1] : url
    }

    private detectAudioType(title: string): SubOrDub {
        const lower = title.toLowerCase()
        if (lower.includes("latino") || lower.includes("castellano")) return "dub"
        if (lower.includes("sub")) return "sub"
        return "both"
    }

}
